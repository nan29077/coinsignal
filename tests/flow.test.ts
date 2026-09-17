import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const dir = mkdtempSync(path.join(tmpdir(), "coinsignal-flow-"));
process.env.COINSIGNAL_DATA_DIR = dir;
process.env.COINSIGNAL_DISABLE_SCHEDULER = "true";

const { useDatabase, db } = await import("../server/db.ts");
useDatabase(path.join(dir, "test.db"));
const { setFetch } = await import("../server/exchanges/http.ts");
const { clearMarketCache } = await import("../server/exchanges/public.ts");
const settings = await import("../server/settings.ts");
const accounts = await import("../server/engine/accounts.ts");
const { runResearch } = await import("../server/ai/research.ts");
const plans = await import("../server/engine/plans.ts");
const { monitorAccount, kstDate } = await import("../server/engine/risk.ts");
const { executeOrder } = await import("../server/engine/broker.ts");
const { snapshot } = await import("../server/engine/valuation.ts");

// ------------------------------------------------------------------ fake exchange + OpenAI
const coins: Record<string, { name: string; price: number; volume: number }> = {
  BTC: { name: "비트코인", price: 100_000_000, volume: 90e9 },
  ETH: { name: "이더리움", price: 5_000_000, volume: 40e9 },
  SOL: { name: "솔라나", price: 300_000, volume: 20e9 },
  USDT: { name: "테더", price: 1380, volume: 50e9 },
  NEW: { name: "신규", price: 100, volume: 30e9 },
};
const live = { krw: 5_000_000, coins: {} as Record<string, number>, orders: new Map<string, Record<string, unknown>>(), failNextOrder: false, fail502: false, jwt: [] as Record<string, unknown>[] };
let researchOutput: unknown;

function candlesFor(symbol: string, count: number) {
  const now = Date.now();
  const top = Math.floor(now / 3_600_000) * 3_600_000;
  return Array.from({ length: count }, (_, i) => {
    const t = top - i * 3_600_000;
    const px = coins[symbol].price * (1 - i * 0.0005) * (1 + 0.004 * Math.sin(i));
    return { candle_date_time_utc: new Date(t).toISOString().slice(0, 19), trade_price: px, opening_price: px, high_price: px, low_price: px, candle_acc_trade_volume: 100 + (i % 7) };
  });
}

function json(v: unknown, status = 200) {
  return new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });
}

const fakeFetch: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  if (url.hostname === "api.upbit.com") {
    const p = url.pathname;
    if (p === "/v1/market/all") return json(Object.entries(coins).map(([s, c]) => ({ market: `KRW-${s}`, korean_name: c.name, market_event: { warning: false, caution: {} } })));
    if (p === "/v1/ticker")
      return json(
        url.searchParams.get("markets")!.split(",").map((m) => {
          const s = m.slice(4);
          return { market: m, trade_price: coins[s].price, signed_change_rate: 0.01, acc_trade_price_24h: coins[s].volume, timestamp: Date.now() };
        }),
      );
    if (p === "/v1/candles/minutes/60") {
      const s = url.searchParams.get("market")!.slice(4);
      return json(candlesFor(s, s === "NEW" ? 40 : 200));
    }
    if (p === "/v1/orderbook") {
      const s = url.searchParams.get("markets")!.slice(4);
      const px = coins[s].price;
      return json([{ timestamp: Date.now(), orderbook_units: [{ ask_price: px, ask_size: 1e6, bid_price: px * 0.999, bid_size: 1e6 }] }]);
    }
    // ---- private
    const auth = String((init?.headers as Record<string, string>)?.Authorization ?? "");
    const payload = JSON.parse(Buffer.from(auth.replace("Bearer ", "").split(".")[1], "base64url").toString());
    live.jwt.push(payload);
    if (p === "/v1/accounts") {
      return json([{ currency: "KRW", balance: String(live.krw), locked: "0", avg_buy_price: "0" }, ...Object.entries(live.coins).map(([c, q]) => ({ currency: c, balance: String(q), locked: "0", avg_buy_price: "0" }))]);
    }
    if (p === "/v1/orders" && method === "POST") {
      const b = JSON.parse(String(init!.body));
      const qs = Object.entries(b).map(([k, v]) => `${k}=${v}`).join("&");
      assert.equal(payload.query_hash, createHash("sha512").update(qs).digest("hex"), "query_hash must match body");
      const s = b.market.slice(4);
      const px = coins[s].price;
      const order =
        b.side === "bid"
          ? { state: "cancel", executed_volume: String(Number(b.price) / px), paid_fee: String(Number(b.price) * 0.0005), trades: [{ funds: b.price }] }
          : { state: "done", executed_volume: b.volume, paid_fee: String(Number(b.volume) * px * 0.999 * 0.0005), trades: [{ funds: String(Number(b.volume) * px * 0.999) }] };
      if (b.side === "bid") {
        live.krw -= Number(b.price) * 1.0005;
        live.coins[s] = (live.coins[s] ?? 0) + Number(order.executed_volume);
      } else {
        live.krw += Number(b.volume) * px * 0.999 * 0.9995;
        live.coins[s] -= Number(b.volume);
      }
      const uuid = `u-${live.orders.size + 1}`;
      live.orders.set(uuid, order);
      live.orders.set(`id:${b.identifier}`, order);
      if (live.fail502) {
        live.fail502 = false;
        return json({ error: { name: "server_error", message: "gateway" } }, 502);
      }
      if (live.failNextOrder) {
        live.failNextOrder = false;
        throw new TypeError("fetch failed");
      }
      return json({ uuid, state: "wait" }, 201);
    }
    if (p === "/v1/order") {
      const o = live.orders.get(url.searchParams.get("uuid") ?? `id:${url.searchParams.get("identifier")}`);
      return o ? json(o) : json({ error: { name: "order_not_found", message: "404" } }, 404);
    }
  }
  if (url.hostname === "api.openai.com") {
    if (url.pathname === "/v1/responses" && method === "POST") {
      const b = JSON.parse(String(init!.body));
      assert.equal(b.background, true);
      assert.equal(b.text.format.type, "json_schema");
      assert.equal(b.tools[0].type, "web_search");
      const input = JSON.parse(b.input);
      const symbols = input.candidates.map((c: { symbol: string }) => c.symbol);
      assert.ok(!symbols.includes("USDT"), "stablecoins are screened out");
      assert.ok(!symbols.includes("NEW"), "new listings are screened out");
      return json({ id: "resp_1", status: "queued" });
    }
    if (url.pathname === "/v1/responses/resp_1") {
      return json({
        id: "resp_1",
        status: "completed",
        output: [{ type: "web_search_call" }, { type: "web_search_call" }, { type: "message", content: [{ type: "output_text", text: JSON.stringify(researchOutput), annotations: [] }] }],
        usage: { input_tokens: 20000, input_tokens_details: { cached_tokens: 0 }, output_tokens: 5000 },
      });
    }
  }
  if (url.hostname === "api.telegram.org") return json({ ok: true, result: { message_id: 1 } });
  throw new Error(`unexpected fetch ${method} ${url}`);
};

const pick = (symbol: string, weight: number) => ({
  symbol,
  weight,
  confidence: 0.7,
  horizon_hours: 72,
  stop_loss_pct: 5,
  take_profit_pct: 15,
  thesis: "테스트 근거",
  risks: "테스트 위험",
  sources: [{ title: "news", url: `https://news.example.com/${symbol}` }],
});

const waitFor = async (fn: () => boolean, ms = 15_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("timeout waiting for condition");
};

before(() => {
  setFetch(fakeFetch);
  accounts.ensureAccounts();
  settings.setSecret("openai_api_key", "sk-test-1234567890");
  settings.setSecret("upbit_access_key", "access-key-123");
  settings.setSecret("upbit_secret_key", "secret-key-456");
  settings.setSetting("ai", { ...settings.getSetting("ai"), budgetUsd: 10, candidateCount: 5, exchanges: ["upbit"] });
  accounts.updateAccount("paper:upbit", { enabled: true, execution: "approval" });
  accounts.updateAccount("live:upbit", { enabled: true, execution: "auto" });
});
after(() => setFetch((...a) => fetch(...a)));

test("full pipeline: screen → AI → validate → live auto execution + paper approval", async () => {
  researchOutput = { market_summary: "테스트", risk_level: "medium", cash_weight: 0.4, picks: [pick("BTC", 0.4), pick("ETH", 0.2), pick("USDT", 0.1)], exits: [] };
  const id = await runResearch("upbit", "manual", plans.createPlansForResearch);
  await waitFor(() => db().get<{ status: string }>("SELECT status FROM research_runs WHERE id = ?", id)?.status !== "running");
  const run = db().get<{ status: string; result: string; cost_usd: number; web_searches: number; error: string }>("SELECT * FROM research_runs WHERE id = ?", id)!;
  assert.equal(run.status, "completed", run.error);
  assert.equal(run.web_searches, 2);
  assert.ok(run.cost_usd > 0.05);
  const result = JSON.parse(run.result);
  assert.deepEqual(result.dropped.map((d: { symbol: string }) => d.symbol), ["USDT"]);

  await waitFor(() => db().all("SELECT * FROM plans").length === 2 && !db().get("SELECT 1 FROM plans WHERE status = 'executing'"));
  const livePlan = db().get<{ status: string; result: string }>("SELECT * FROM plans WHERE account_id = 'live:upbit'")!;
  assert.equal(livePlan.status, "executed", livePlan.result);
  const livePos = accounts.getPositions("live:upbit");
  assert.deepEqual(livePos.map((p) => p.symbol).sort(), ["BTC", "ETH"]);
  assert.ok(live.jwt.every((j) => typeof j.nonce === "string" && j.access_key === "access-key-123"));
  const btc = livePos.find((p) => p.symbol === "BTC")!;
  assert.equal(btc.stop_loss_pct, 5);
  const s = await snapshot(accounts.getAccount("live:upbit"));
  const btcWeight = s.positions.find((p) => p.symbol === "BTC")!.valueKrw! / s.equityKrw;
  assert.ok(Math.abs(btcWeight - 0.4 / 1.1) < 0.02, `BTC weight ${btcWeight}`);

  const paperPlan = db().get<{ id: string; status: string }>("SELECT * FROM plans WHERE account_id = 'paper:upbit'")!;
  assert.equal(paperPlan.status, "pending");
  await plans.approvePlan(paperPlan.id, "web");
  await waitFor(() => plans.getPlan(paperPlan.id).status !== "executing");
  assert.equal(plans.getPlan(paperPlan.id).status, "executed");
  const paper = accounts.getAccount("paper:upbit");
  assert.ok(paper.cash_krw >= 4_400_000 && paper.cash_krw <= 4_700_000, `cash ${paper.cash_krw}`);
  await assert.rejects(() => plans.approvePlan(paperPlan.id, "web"), /이미 처리/);
});

test("rebalance: next research exits a coin and trims another", async () => {
  researchOutput = { market_summary: "리밸런싱", risk_level: "high", cash_weight: 0.8, picks: [pick("BTC", 0.2)], exits: [{ symbol: "ETH", reason: "악재" }] };
  const id = await runResearch("upbit", "manual", plans.createPlansForResearch);
  await waitFor(() => db().get<{ n: number }>("SELECT COUNT(*) n FROM plans WHERE research_id = ?", id)!.n === 2 && !db().get("SELECT 1 FROM plans WHERE status = 'executing'"));
  const pos = accounts.getPositions("live:upbit");
  assert.deepEqual(pos.map((p) => p.symbol), ["BTC"]);
  const sells = db().all<{ kind: string; pnl_krw: number }>("SELECT * FROM orders WHERE account_id = 'live:upbit' AND side = 'sell'");
  assert.ok(sells.some((o) => o.kind === "exit"));
  assert.ok(sells.every((o) => o.pnl_krw !== null));
});

test("stop loss fires from the monitor regardless of approval mode", async () => {
  clearMarketCache();
  coins.BTC.price *= 0.9;
  await monitorAccount(accounts.getAccount("paper:upbit"));
  assert.equal(accounts.getPositions("paper:upbit").some((p) => p.symbol === "BTC"), false);
  const o = db().get<{ kind: string; status: string }>("SELECT * FROM orders WHERE account_id = 'paper:upbit' AND kind = 'stop_loss'");
  assert.equal(o?.status, "filled");
  coins.BTC.price /= 0.9;
  clearMarketCache();
});

test("live order survives a network error by looking the order up via client id", async () => {
  live.failNextOrder = true;
  const row = await executeOrder(accounts.getAccount("live:upbit"), "SOL", "buy", { krw: 100_000 }, { kind: "manual", reason: "test" });
  assert.equal(row.status, "filled");
  assert.ok(accounts.getPositions("live:upbit").some((p) => p.symbol === "SOL"));
});

test("a 5xx after the exchange accepted the order is resolved as filled, not failed", async () => {
  live.fail502 = true;
  const row = await executeOrder(accounts.getAccount("live:upbit"), "SOL", "buy", { krw: 50_000 }, { kind: "manual", reason: "test" });
  assert.equal(row.status, "filled");
});

test("daily loss limit halts the account", async () => {
  const a = accounts.getAccount("live:upbit");
  db().run("UPDATE accounts SET day_start_date = ?, day_start_equity = ?, daily_loss_limit_pct = 5 WHERE id = ?", kstDate(), (a.last_equity ?? 5_000_000) * 2, a.id);
  await monitorAccount(accounts.getAccount(a.id));
  assert.equal(accounts.getAccount(a.id).halted, 1);
});

test("budget guard blocks research when the period budget is spent", async () => {
  settings.setSetting("ai", { ...settings.getSetting("ai"), budgetUsd: 0.01 });
  await assert.rejects(() => runResearch("upbit", "manual"), /예산/);
});
