import { randomUUID } from "node:crypto";
import { db, nowIso } from "../db.ts";
import { AppError, errorMessage } from "../errors.ts";
import type { ResearchResult } from "../ai/research.ts";
import { editTelegram, sendTelegram } from "../notify/telegram.ts";
import { getSetting, logEvent, type Exchange } from "../settings.ts";
import { accountLabel, getAccount, listAccounts, withAccountLock, type Account } from "./accounts.ts";
import { executeOrder, liveBalances, type OrderRow } from "./broker.ts";
import { planOrders, type PlannedOrder, type Targets } from "./planner.ts";
import { snapshot } from "./valuation.ts";

export type PlanRow = {
  id: string;
  account_id: string;
  research_id: string | null;
  status: "pending" | "executing" | "executed" | "rejected" | "expired" | "failed" | "noop";
  targets: string;
  preview: string | null;
  result: string | null;
  created_at: string;
  expires_at: string;
  decided_at: string | null;
  decided_via: string | null;
  telegram_message_id: number | null;
};

const fmt = (n: number) => Math.round(n).toLocaleString("ko-KR");

export function targetsFromResearch(r: ResearchResult, a: Account): Targets {
  return {
    cashWeight: r.cashWeight,
    picks: r.picks.map((p) => ({ symbol: p.symbol, weight: p.weight, stopLossPct: p.stopLossPct || a.default_stop_loss_pct, takeProfitPct: p.takeProfitPct || a.default_take_profit_pct })),
    exits: r.exits,
    universe: r.universe,
  };
}

async function preview(a: Account, targets: Targets): Promise<{ orders: PlannedOrder[]; equity: number; stale: boolean }> {
  const s = await snapshot(a);
  if (s.error) throw new AppError(`${accountLabel(a)}: ${s.error}`);
  const orders = planOrders({
    equityKrw: s.equityKrw,
    cashKrw: s.cashKrw,
    positions: s.positions.map((p) => ({ symbol: p.symbol, qty: p.qty, price: p.stale ? null : p.price, valueKrw: p.stale ? null : p.valueKrw })),
    targets,
    bandPct: a.rebalance_band_pct,
    feeBufferPct: a.mode === "live" ? 0.5 : a.fee_pct + a.slippage_pct + 0.05,
  });
  return { orders, equity: s.equityKrw, stale: s.stale };
}

function describe(a: Account, orders: PlannedOrder[], equity: number) {
  const lines = orders.map((o) => `${o.side === "buy" ? "🟢 매수" : "🔴 매도"} ${o.symbol} ${fmt(o.krw)}원 (${(o.currentWeight * 100).toFixed(1)}% → ${(o.targetWeight * 100).toFixed(1)}%)`);
  return `[${accountLabel(a)}] 총자산 ${fmt(equity)}원\n${lines.join("\n")}`;
}

/** Called after each completed research run. Creates one plan per enabled account on that exchange. */
export async function createPlansForResearch(researchId: string, e: Exchange, r: ResearchResult) {
  const accounts = listAccounts().filter((a) => a.exchange === e && a.enabled);
  const global = getSetting("global");
  const ai = getSetting("ai");
  await sendTelegram(
    `🧠 ${e.toUpperCase()} AI 리서치 완료\n${r.summary.slice(0, 600)}\n\n목표: ${r.picks.map((p) => `${p.symbol} ${(p.weight * 100).toFixed(0)}%`).join(", ") || "없음"} · 현금 ${(r.cashWeight * 100).toFixed(0)}%`,
    undefined,
    { kind: "research" },
  );
  for (const a of accounts) {
    try {
      if (global.killSwitch) throw new AppError("긴급 중단 상태라 계획을 만들지 않았습니다.");
      if (a.halted) throw new AppError(`계좌가 정지 상태입니다: ${a.halt_reason ?? ""}`);
      const targets = targetsFromResearch(r, a);
      const { orders, equity } = await preview(a, targets);
      // A newer plan supersedes any older pending plan for the same account.
      for (const old of db().all<PlanRow>("SELECT * FROM plans WHERE account_id = ? AND status = 'pending'", a.id)) {
        db().run("UPDATE plans SET status = 'expired' WHERE id = ? AND status = 'pending'", old.id);
        if (old.telegram_message_id) void editTelegram(old.telegram_message_id, "⌛ 새 리서치 결과로 대체된 계획");
      }
      const id = randomUUID();
      const created = new Date();
      const expires = new Date(created.getTime() + ai.approvalTimeoutMinutes * 60_000);
      const status = orders.length === 0 ? "noop" : a.execution === "auto" ? "executing" : "pending";
      db().run(
        "INSERT INTO plans (id, account_id, research_id, status, targets, preview, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        id,
        a.id,
        researchId,
        status,
        JSON.stringify(targets),
        JSON.stringify({ orders, equity }),
        created.toISOString(),
        expires.toISOString(),
      );
      if (status === "noop") {
        logEvent("info", `${accountLabel(a)}: 목표와 현재 비중 차이가 작아 주문 없음`, a.id);
        continue;
      }
      if (status === "executing") {
        await executePlan(id, "auto");
      } else {
        const msgId = await sendTelegram(`📝 승인 대기 (${ai.approvalTimeoutMinutes}분 내)\n${describe(a, orders, equity)}`, [
          [
            { text: "✅ 승인", callback_data: `approve:${id}` },
            { text: "❌ 거절", callback_data: `reject:${id}` },
          ],
        ]);
        if (msgId) db().run("UPDATE plans SET telegram_message_id = ? WHERE id = ?", msgId, id);
        logEvent("info", `${accountLabel(a)}: 매매 계획 승인 대기 (${orders.length}건)`, a.id);
      }
    } catch (err) {
      logEvent("warn", `${accountLabel(a)} 계획 생성 실패: ${errorMessage(err, err instanceof Error ? err.message : "")}`, a.id);
    }
  }
}

export function getPlan(id: string): PlanRow {
  const p = db().get<PlanRow>("SELECT * FROM plans WHERE id = ?", id);
  if (!p) throw new AppError("계획을 찾을 수 없습니다.", 404);
  return p;
}

export async function approvePlan(id: string, via: "web" | "telegram") {
  const p = getPlan(id);
  if (p.status !== "pending") throw new AppError(`이미 처리된 계획입니다 (${p.status}).`, 409);
  if (Date.parse(p.expires_at) < Date.now()) {
    expirePlan(p);
    throw new AppError("승인 시간이 지나 만료되었습니다.", 409);
  }
  const changed = db().run("UPDATE plans SET status = 'executing', decided_at = ?, decided_via = ? WHERE id = ? AND status = 'pending'", nowIso(), via, id);
  if (changed.changes !== 1) throw new AppError("이미 처리된 계획입니다.", 409);
  void executePlan(id, via);
  return "승인했습니다. 주문을 실행합니다.";
}

export function rejectPlan(id: string, via: "web" | "telegram") {
  const p = getPlan(id);
  const changed = db().run("UPDATE plans SET status = 'rejected', decided_at = ?, decided_via = ? WHERE id = ? AND status = 'pending'", nowIso(), via, id);
  if (changed.changes !== 1) throw new AppError(`이미 처리된 계획입니다 (${p.status}).`, 409);
  if (p.telegram_message_id) void editTelegram(p.telegram_message_id, "❌ 거절된 계획");
  logEvent("info", "매매 계획 거절", p.account_id);
  return "거절했습니다.";
}

function expirePlan(p: PlanRow) {
  db().run("UPDATE plans SET status = 'expired' WHERE id = ? AND status = 'pending'", p.id);
  if (p.telegram_message_id) void editTelegram(p.telegram_message_id, "⌛ 승인 시간이 지나 만료된 계획");
}

export function expirePlans() {
  for (const p of db().all<PlanRow>("SELECT * FROM plans WHERE status = 'pending' AND expires_at < ?", nowIso())) expirePlan(p);
}

/**
 * Executes with fresh prices: orders are re-planned at execution time from the stored target weights,
 * sells first, then buys sized to the cash actually available.
 */
export async function executePlan(id: string, via: string) {
  const plan = getPlan(id);
  const a0 = getAccount(plan.account_id);
  return withAccountLock(a0.id, async () => {
    const results: { symbol: string; side: string; status: string; krw: number; error?: string | null }[] = [];
    try {
      if (getSetting("global").killSwitch) throw new AppError("긴급 중단 상태입니다.");
      const a = getAccount(a0.id);
      if (a.halted) throw new AppError(`계좌 정지: ${a.halt_reason ?? ""}`);
      const targets = JSON.parse(plan.targets) as Targets;
      const stops = new Map(targets.picks.map((t) => [t.symbol, t]));
      // Only (symbol, side) pairs that were in the previewed/approved plan may be executed, and buys may
      // not grow beyond 1.5x the previewed amount. Anything new (e.g. re-buying a coin a stop-loss just
      // sold) needs a new plan.
      const approved = new Map(((plan.preview ? JSON.parse(plan.preview) : { orders: [] }) as { orders: PlannedOrder[] }).orders.map((o) => [`${o.side}:${o.symbol}`, o]));
      const skipped: string[] = [];
      const guard = () => {
        if (getSetting("global").killSwitch) throw new AppError("긴급 중단으로 남은 주문을 취소했습니다.");
        const cur = getAccount(a.id);
        if (cur.halted) throw new AppError(`계좌 정지로 남은 주문을 취소했습니다: ${cur.halt_reason ?? ""}`);
      };
      const first = await preview(a, targets);
      for (const o of first.orders.filter((x) => x.side === "sell")) {
        if (!approved.has(`sell:${o.symbol}`)) {
          skipped.push(`매도 ${o.symbol}`);
          continue;
        }
        guard();
        const row = await executeOrder(a, o.symbol, "sell", { qty: o.qty }, { planId: id, kind: o.targetWeight === 0 ? "exit" : "rebalance", reason: o.reason });
        results.push(summary(row));
      }
      // Recompute buys after sells settled so cash is exact.
      const second = await preview(getAccount(a.id), targets);
      let cash = a.mode === "live" ? ((await liveBalances(a, 0)).find((b) => b.currency === "KRW")?.available ?? 0) : getAccount(a.id).cash_krw;
      for (const o of second.orders.filter((x) => x.side === "buy")) {
        const ok = approved.get(`buy:${o.symbol}`);
        if (!ok) {
          skipped.push(`매수 ${o.symbol}`);
          continue;
        }
        const krw = Math.floor(Math.min(o.krw, ok.krw * 1.5, cash * (a.mode === "live" ? 0.995 : 1 / (1 + (a.fee_pct + a.slippage_pct) / 100))));
        if (krw < 5000) continue;
        guard();
        const t = stops.get(o.symbol);
        const row = await executeOrder(a, o.symbol, "buy", { krw }, { planId: id, kind: "rebalance", reason: o.reason, stopLossPct: t?.stopLossPct, takeProfitPct: t?.takeProfitPct });
        results.push(summary(row));
        // Orders still settling have not reported their spend yet: reserve the requested amount.
        cash -= row.status === "failed" || row.status === "canceled" ? 0 : row.status === "filled" ? row.executed_krw + row.fee_krw : krw;
      }
      if (skipped.length) logEvent("warn", `승인 이후 새로 생긴 주문은 실행하지 않음: ${skipped.join(", ")}`, a.id);
      // Update risk levels for positions that were already at target weight.
      for (const t of targets.picks)
        db().run("UPDATE positions SET stop_loss_pct = ?, take_profit_pct = ? WHERE account_id = ? AND symbol = ?", t.stopLossPct, t.takeProfitPct, a.id, t.symbol);
      const failed = results.filter((r) => r.status === "failed").length;
      db().run("UPDATE plans SET status = ?, result = ? WHERE id = ?", failed && failed === results.length ? "failed" : "executed", JSON.stringify({ via, results }), id);
      const text = `${failed ? "⚠️" : "✅"} [${accountLabel(a)}] 계획 실행 (${via})\n${results.map((r) => `${r.side === "buy" ? "매수" : "매도"} ${r.symbol} ${r.status} ${fmt(r.krw)}원${r.error ? ` - ${r.error}` : ""}`).join("\n") || "주문 없음"}`;
      if (plan.telegram_message_id) void editTelegram(plan.telegram_message_id, text);
      else void sendTelegram(text, undefined, { kind: "trade" });
    } catch (err) {
      const message = errorMessage(err, err instanceof Error ? err.message : "실행 실패");
      db().run("UPDATE plans SET status = 'failed', result = ? WHERE id = ?", JSON.stringify({ via, results, error: message }), id);
      logEvent("error", `계획 실행 실패: ${message}`, a0.id);
      void sendTelegram(`⚠️ [${accountLabel(a0)}] 계획 실행 실패: ${message}`, undefined, { kind: "trade" });
    }
  });
}

const summary = (o: OrderRow) => ({ symbol: o.symbol, side: o.side, status: o.status, krw: o.executed_krw || o.requested_krw || 0, error: o.error });
