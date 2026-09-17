import { Hono, type Context } from "hono";
import { z } from "zod";
import { changePassword, createAdmin, hasAdmin, isAuthenticated, login, logout, requireAuth } from "./auth.ts";
import { db } from "./db.ts";
import { AppError, errorMessage, logError } from "./errors.ts";
import { budgetStatus } from "./ai/budget.ts";
import { MODEL_CATALOG } from "./ai/models.ts";
import { listModels } from "./ai/openai.ts";
import { isResearchRunning, runResearch } from "./ai/research.ts";
import { candles, orderbook, symbolOf, tickers } from "./exchanges/public.ts";
import { liveClient } from "./exchanges/private.ts";
import { analyze } from "./market/indicators.ts";
import { backtest } from "./market/backtest.ts";
import { accountLabel, accountUpdateSchema, getAccount, listAccounts, resetPaperAccount, setHalt, updateAccount, withAccountLock } from "./engine/accounts.ts";
import { executeOrder, invalidateBalances, type OrderRow } from "./engine/broker.ts";
import { approvePlan, createPlansForResearch, rejectPlan, type PlanRow } from "./engine/plans.ts";
import { liquidate } from "./engine/risk.ts";
import { snapshot } from "./engine/valuation.ts";
import { detectChatId, sendTelegram, testTelegram } from "./notify/telegram.ts";
import {
  aiSettingsSchema,
  deleteSecret,
  exchangeCredentials,
  EXCHANGES,
  getSecret,
  getSetting,
  logEvent,
  SECRET_NAMES,
  secretHints,
  setSecret,
  setSetting,
  telegramSettingsSchema,
  type Exchange,
} from "./settings.ts";

export const api = new Hono();

const exchangeOf = (v: unknown): Exchange => {
  if (EXCHANGES.includes(v as Exchange)) return v as Exchange;
  throw new AppError("거래소를 선택해 주세요.");
};
async function body<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  const raw = await c.req.json().catch(() => {
    throw new AppError("요청 본문(JSON)이 올바르지 않습니다.");
  });
  const r = schema.safeParse(raw);
  if (!r.success) throw new AppError(`입력값 확인: ${r.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join(", ")}`);
  return r.data;
}

api.onError((err, c) => {
  if (!(err instanceof AppError)) logError(`${c.req.method} ${c.req.path}`, err);
  const status = err instanceof AppError ? err.status : 500;
  return c.json({ error: errorMessage(err, "서버 내부 오류가 발생했습니다.") }, status as 400);
});
api.use("*", async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
});

// ------------------------------------------------------------------ auth (public)
api.get("/auth/status", (c) => c.json({ setupRequired: !hasAdmin(), authenticated: isAuthenticated(c) }));
api.post("/auth/setup", async (c) => {
  const b = await body(c, z.object({ password: z.string(), token: z.string() }));
  createAdmin(b.password, b.token);
  login(c, b.password);
  return c.json({ ok: true });
});
api.post("/auth/login", async (c) => {
  const b = await body(c, z.object({ password: z.string() }));
  login(c, b.password);
  return c.json({ ok: true });
});
api.post("/auth/logout", (c) => {
  logout(c);
  return c.json({ ok: true });
});

api.use("*", requireAuth);

api.post("/auth/password", async (c) => {
  const b = await body(c, z.object({ current: z.string(), next: z.string() }));
  changePassword(b.current, b.next);
  logout(c);
  return c.json({ ok: true });
});

// ------------------------------------------------------------------ market
api.get("/market/tickers", async (c) => {
  const e = exchangeOf(c.req.query("exchange"));
  return c.json({ exchange: e, tickers: await tickers(e), receivedAt: Date.now() });
});
api.get("/market/analysis", async (c) => {
  const e = exchangeOf(c.req.query("exchange"));
  const s = symbolOf(c.req.query("symbol"));
  const cs = await candles(e, s);
  return c.json({ exchange: e, symbol: s, ...analyze(cs), candles: cs.map((x) => ({ time: x.time + 3_600_000, close: x.close })) });
});
api.get("/market/orderbook", async (c) => c.json(await orderbook(exchangeOf(c.req.query("exchange")), symbolOf(c.req.query("symbol")))));
api.post("/market/backtest", async (c) => {
  const b = await body(
    c,
    z.object({
      exchange: z.enum(EXCHANGES),
      symbol: z.string(),
      feePct: z.number().min(0).max(2).default(0.05),
      slippagePct: z.number().min(0).max(5).default(0.05),
      stopLossPct: z.number().min(0.5).max(50).default(5),
      takeProfitPct: z.number().min(0.5).max(300).default(10),
    }),
  );
  return c.json(backtest(await candles(b.exchange, symbolOf(b.symbol)), b));
});

// ------------------------------------------------------------------ accounts
api.get("/accounts", async (c) => {
  const kill = getSetting("global").killSwitch;
  const out = await Promise.all(
    listAccounts().map(async (a) => {
      const hasKeys = a.mode === "paper" || !!(a.exchange === "coinone" ? getSecret("coinone_access_token") : getSecret(`${a.exchange}_access_key`));
      const pending = db().get<{ n: number }>("SELECT COUNT(*) n FROM plans WHERE account_id = ? AND status = 'pending'", a.id)?.n ?? 0;
      // Live snapshots call the exchange; only do it for configured accounts.
      const s = a.mode === "paper" || hasKeys ? await snapshot(a).catch((e) => ({ error: errorMessage(e, "조회 실패") }) as const) : null;
      return { account: a, label: accountLabel(a), hasKeys, pendingPlans: pending, snapshot: s && "account" in s ? { ...s, account: undefined } : null, snapshotError: s && !("account" in s) ? s.error : s?.error };
    }),
  );
  return c.json({ killSwitch: kill, accounts: out });
});

api.get("/accounts/:id", async (c) => {
  const a = getAccount(c.req.param("id"));
  const s = await snapshot(a);
  const orders = db().all<OrderRow>("SELECT * FROM orders WHERE account_id = ? ORDER BY created_at DESC LIMIT 200", a.id);
  const equity = db().all<{ ts: number; equity: number }>("SELECT ts, equity FROM equity_snapshots WHERE account_id = ? ORDER BY ts DESC LIMIT 2000", a.id).reverse();
  return c.json({ label: accountLabel(a), snapshot: s, orders, equity });
});

api.patch("/accounts/:id", async (c) => {
  const input = await body(c, accountUpdateSchema);
  const before = getAccount(c.req.param("id"));
  if (input.enabled && before.mode === "live" && !exchangeCredentials(before.exchange)) throw new AppError("거래소 API 키를 먼저 등록해 주세요.");
  const a = updateAccount(before.id, input);
  if (input.enabled !== undefined && input.enabled !== !!before.enabled) logEvent("info", `${accountLabel(a)} ${input.enabled ? "활성화" : "비활성화"}`, a.id);
  if (input.execution && input.execution !== before.execution) logEvent("info", `${accountLabel(a)} 실행 방식: ${input.execution === "auto" ? "자동" : "승인"}`, a.id);
  return c.json(a);
});

api.post("/accounts/:id/reset", async (c) => {
  const b = await body(c, z.object({ initialKrw: z.number() }));
  resetPaperAccount(c.req.param("id"), b.initialKrw);
  return c.json({ ok: true });
});

api.post("/accounts/:id/halt", async (c) => {
  const b = await body(c, z.object({ halted: z.boolean() }));
  const a = getAccount(c.req.param("id"));
  setHalt(a.id, b.halted, b.halted ? "관리자 수동 정지" : null);
  if (!b.halted) db().run("UPDATE accounts SET day_start_date = NULL WHERE id = ?", a.id);
  logEvent("warn", `${accountLabel(a)} ${b.halted ? "수동 정지" : "재개"}`, a.id);
  return c.json({ ok: true });
});

api.post("/accounts/:id/order", async (c) => {
  const b = await body(
    c,
    z.object({ side: z.enum(["buy", "sell"]), symbol: z.string(), krw: z.number().optional(), fraction: z.number().min(0.01).max(1).optional() }),
  );
  const a = getAccount(c.req.param("id"));
  const symbol = symbolOf(b.symbol);
  const row = await withAccountLock(a.id, async () => {
    if (b.side === "buy") {
      if (getSetting("global").killSwitch) throw new AppError("긴급 중단 중에는 매수할 수 없습니다.");
      if (getAccount(a.id).halted) throw new AppError("정지된 계좌에서는 매수할 수 없습니다. 먼저 재개해 주세요.");
    }
    if (b.side === "buy") return executeOrder(a, symbol, "buy", { krw: b.krw }, { kind: "manual", reason: "관리자 수동 매수" });
    const s = await snapshot(a);
    const pos = s.positions.find((p) => p.symbol === symbol);
    if (!pos) throw new AppError("보유하지 않은 종목입니다.");
    return executeOrder(a, symbol, "sell", { qty: pos.qty * (b.fraction ?? 1) }, { kind: "manual", reason: "관리자 수동 매도" });
  });
  if (row.status === "failed") throw new AppError(row.error ?? "주문 실패");
  return c.json(row);
});

api.post("/accounts/:id/liquidate", async (c) => {
  const a = getAccount(c.req.param("id"));
  const rows = await liquidate(a, "관리자 전량 매도");
  return c.json({ orders: rows });
});

// ------------------------------------------------------------------ research & plans
api.get("/research", (c) => {
  const rows = db().all<Record<string, unknown>>(
    "SELECT id, exchange, trigger, model, status, started_at, finished_at, error, input_tokens, cached_tokens, output_tokens, web_searches, cost_usd, result FROM research_runs ORDER BY started_at DESC LIMIT 100",
  );
  return c.json({
    runs: rows.map((r) => ({ ...r, result: r.result ? JSON.parse(String(r.result)) : null })),
    running: EXCHANGES.filter(isResearchRunning),
    budget: budgetStatus(),
  });
});
api.get("/research/:id", (c) => {
  const r = db().get<Record<string, unknown>>("SELECT * FROM research_runs WHERE id = ?", c.req.param("id"));
  if (!r) throw new AppError("리서치 기록이 없습니다.", 404);
  return c.json({ ...r, result: r.result ? JSON.parse(String(r.result)) : null, candidates: r.candidates ? JSON.parse(String(r.candidates)) : null });
});
api.post("/research/run", async (c) => {
  const b = await body(c, z.object({ exchange: z.enum(EXCHANGES), createPlans: z.boolean().default(true) }));
  const id = await runResearch(b.exchange, "manual", b.createPlans ? createPlansForResearch : undefined);
  return c.json({ id });
});

api.get("/plans", (c) => {
  const rows = db().all<PlanRow>("SELECT * FROM plans ORDER BY created_at DESC LIMIT 100");
  return c.json(
    rows.map((p) => ({
      ...p,
      label: accountLabel(getAccount(p.account_id)),
      targets: JSON.parse(p.targets),
      preview: p.preview ? JSON.parse(p.preview) : null,
      result: p.result ? JSON.parse(p.result) : null,
    })),
  );
});
api.post("/plans/:id/approve", async (c) => c.json({ message: await approvePlan(c.req.param("id"), "web") }));
api.post("/plans/:id/reject", (c) => c.json({ message: rejectPlan(c.req.param("id"), "web") }));

// ------------------------------------------------------------------ settings
api.get("/settings", (c) =>
  c.json({ ai: getSetting("ai"), telegram: getSetting("telegram"), global: getSetting("global"), secrets: secretHints(), models: MODEL_CATALOG, budget: budgetStatus() }),
);
api.put("/settings/ai", async (c) => {
  const v = await body(c, aiSettingsSchema);
  setSetting("ai", v);
  logEvent("info", `AI 설정 변경: ${v.model}, ${v.intervalHours}시간 주기, 예산 $${v.budgetUsd}/${v.budgetPeriod}, 예약 ${v.scheduleEnabled ? "켜짐" : "꺼짐"}`);
  return c.json({ ok: true, budget: budgetStatus() });
});
api.put("/settings/telegram", async (c) => {
  setSetting("telegram", await body(c, telegramSettingsSchema));
  return c.json({ ok: true });
});
api.put("/settings/kill-switch", async (c) => {
  const b = await body(c, z.object({ on: z.boolean() }));
  setSetting("global", { ...getSetting("global"), killSwitch: b.on });
  logEvent("warn", b.on ? "긴급 중단 켜짐: 모든 자동 매매·리서치 중지" : "긴급 중단 해제");
  void sendTelegram(b.on ? "⛔ 긴급 중단이 켜졌습니다. 모든 자동 매매를 멈춥니다." : "▶️ 긴급 중단이 해제되었습니다.");
  return c.json({ ok: true });
});
api.put("/secrets/:name", async (c) => {
  const name = c.req.param("name") as (typeof SECRET_NAMES)[number];
  if (!SECRET_NAMES.includes(name)) throw new AppError("알 수 없는 키 이름입니다.", 404);
  const b = await body(c, z.object({ value: z.string() }));
  if (name === "openai_api_key") await listModels(b.value.trim()); // reject invalid keys before saving
  setSecret(name, b.value);
  if (name.startsWith("upbit") || name.startsWith("bithumb") || name.startsWith("coinone")) invalidateBalances(name.split("_")[0]);
  logEvent("info", `키 저장: ${name}`);
  return c.json({ ok: true, secrets: secretHints() });
});
api.delete("/secrets/:name", (c) => {
  const name = c.req.param("name") as (typeof SECRET_NAMES)[number];
  if (!SECRET_NAMES.includes(name)) throw new AppError("알 수 없는 키 이름입니다.", 404);
  deleteSecret(name);
  logEvent("info", `키 삭제: ${name}`);
  return c.json({ ok: true, secrets: secretHints() });
});
api.post("/settings/test/openai", async () => {
  const key = getSecret("openai_api_key");
  if (!key) throw new AppError("OpenAI API 키가 없습니다.");
  const models = await listModels(key);
  return Response.json({ ok: true, available: MODEL_CATALOG.map((m) => ({ id: m.id, available: models.includes(m.id) })), count: models.length });
});
api.post("/settings/test/exchange", async (c) => {
  const b = await body(c, z.object({ exchange: z.enum(EXCHANGES) }));
  const creds =
    b.exchange === "coinone"
      ? { key: getSecret("coinone_access_token"), secret: getSecret("coinone_secret_key") }
      : { key: getSecret(`${b.exchange}_access_key`), secret: getSecret(`${b.exchange}_secret_key`) };
  if (!creds.key || !creds.secret) throw new AppError("거래소 키가 모두 등록되지 않았습니다.");
  const balances = await liveClient(b.exchange, { key: creds.key, secret: creds.secret }).balances();
  const krw = balances.find((x) => x.currency === "KRW");
  return c.json({ ok: true, krw: krw?.available ?? 0, assets: balances.filter((x) => x.available + x.locked > 0).length });
});
api.post("/settings/test/telegram", async () => {
  const token = getSecret("telegram_bot_token");
  const chatId = getSetting("telegram").chatId;
  if (!token || !chatId) throw new AppError("봇 토큰과 채팅 ID를 먼저 저장해 주세요.");
  await testTelegram(token, chatId);
  return Response.json({ ok: true });
});
api.post("/settings/telegram/detect", async () => {
  const token = getSecret("telegram_bot_token");
  if (!token) throw new AppError("봇 토큰을 먼저 저장해 주세요.");
  return Response.json({ chats: await detectChatId(token) });
});

api.get("/events", (c) => {
  const raw = Number(c.req.query("limit") ?? 200);
  const limit = Number.isInteger(raw) && raw > 0 ? Math.min(raw, 1000) : 200;
  return c.json(db().all("SELECT * FROM events ORDER BY id DESC LIMIT ?", limit));
});
