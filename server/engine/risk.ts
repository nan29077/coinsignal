import { db } from "../db.ts";
import { errorMessage } from "../errors.ts";
import { sendTelegram } from "../notify/telegram.ts";
import { getSetting, logEvent } from "../settings.ts";
import { accountLabel, getAccount, setHalt, withAccountLock, type Account } from "./accounts.ts";
import { executeOrder, hasOpenOrder, MIN_ORDER_KRW, reconcileOpenOrders } from "./broker.ts";
import { snapshot, type Snapshot } from "./valuation.ts";

const KST = 9 * 3_600_000;
export const kstDate = (t = Date.now()) => new Date(t + KST).toISOString().slice(0, 10);

export type ExitDecision = { symbol: string; qty: number; kind: "stop_loss" | "take_profit"; reason: string };

/** Pure: which positions hit their stop-loss / take-profit. Unpriced (stale) positions are never acted on. */
export function exitDecisions(s: Pick<Snapshot, "positions">): ExitDecision[] {
  const out: ExitDecision[] = [];
  for (const p of s.positions) {
    if (p.stale || p.pnlPct === null) continue;
    if (p.pnlPct <= -p.stopLossPct) out.push({ symbol: p.symbol, qty: p.qty, kind: "stop_loss", reason: `손절 ${p.pnlPct.toFixed(2)}% (기준 -${p.stopLossPct}%)` });
    else if (p.pnlPct >= p.takeProfitPct) out.push({ symbol: p.symbol, qty: p.qty, kind: "take_profit", reason: `익절 ${p.pnlPct.toFixed(2)}% (기준 +${p.takeProfitPct}%)` });
  }
  return out;
}

/**
 * Runs every minute for each enabled account, independently of AI research and of the approval
 * mode: protective exits must not wait for a human. Also tracks the daily loss limit.
 */
export async function monitorAccount(a0: Account) {
  return withAccountLock(a0.id, async () => {
    const a = getAccount(a0.id);
    try {
      await reconcileOpenOrders(a);
    } catch (e) {
      logEvent("warn", `미체결 주문 확인 실패: ${errorMessage(e, e instanceof Error ? e.message : "")}`, a.id);
    }
    const s = await snapshot(a, { reconcile: true });
    if (s.error) return s;
    const today = kstDate();
    if (a.day_start_date !== today && !s.stale) {
      db().run("UPDATE accounts SET day_start_date = ?, day_start_equity = ? WHERE id = ?", today, s.equityKrw, a.id);
      a.day_start_date = today;
      a.day_start_equity = s.equityKrw;
    }
    if (!s.stale) db().run("UPDATE accounts SET last_equity = ?, last_equity_at = ? WHERE id = ?", s.equityKrw, Date.now(), a.id);

    if (getSetting("global").killSwitch) return s;

    for (const d of exitDecisions(s)) {
      const view = s.positions.find((p) => p.symbol === d.symbol);
      if (hasOpenOrder(a.id, d.symbol)) continue; // an order for this coin is still settling
      if ((view?.valueKrw ?? 0) < MIN_ORDER_KRW) continue; // dust below the exchange minimum
      // Back off 10 minutes after a failed protective sell instead of retrying (and alerting) every minute.
      const recentFail = db().get("SELECT 1 FROM orders WHERE account_id = ? AND symbol = ? AND side = 'sell' AND status = 'failed' AND kind IN ('stop_loss','take_profit') AND updated_at > ?", a.id, d.symbol, new Date(Date.now() - 10 * 60_000).toISOString());
      if (recentFail) continue;
      const row = await executeOrder(a, d.symbol, "sell", { qty: d.qty }, { kind: d.kind, reason: d.reason });
      void sendTelegram(`${d.kind === "stop_loss" ? "🛑" : "💰"} [${accountLabel(a)}] ${d.symbol} ${d.reason} → ${row.status}${row.error ? ` (${row.error})` : ""}`, undefined, { kind: "trade" });
    }

    if (!a.halted && a.daily_loss_limit_pct > 0 && a.day_start_equity && !s.stale) {
      const lossPct = (1 - s.equityKrw / a.day_start_equity) * 100;
      if (lossPct >= a.daily_loss_limit_pct) {
        const reason = `일일 손실 한도 도달 (-${lossPct.toFixed(2)}%)`;
        setHalt(a.id, true, reason);
        logEvent("warn", `${accountLabel(a)} 자동 정지: ${reason}`, a.id);
        void sendTelegram(`⛔ [${accountLabel(a)}] ${reason}. 신규 매매를 정지했습니다. 앱에서 재개할 수 있습니다.`);
      }
    }
    return s;
  });
}

export function recordEquity(s: Snapshot) {
  if (s.stale || s.error) return;
  const bucket = Math.floor(Date.now() / 300_000) * 300_000;
  db().run("INSERT OR REPLACE INTO equity_snapshots (account_id, ts, equity, cash) VALUES (?, ?, ?, ?)", s.account.id, bucket, s.equityKrw, s.cashKrw + s.lockedKrw);
}

/** Keeps the database small: 5-minute points for 14 days, hourly points for a year, events for 90 days. */
export function pruneHistory() {
  const d14 = Date.now() - 14 * 86_400_000;
  const y1 = Date.now() - 365 * 86_400_000;
  db().run("DELETE FROM equity_snapshots WHERE ts < ? AND ts % 3600000 != 0", d14);
  db().run("DELETE FROM equity_snapshots WHERE ts < ?", y1);
  db().run("DELETE FROM events WHERE ts < ?", new Date(Date.now() - 90 * 86_400_000).toISOString());
  db().run("DELETE FROM sessions WHERE expires_at < ?", Date.now());
}

export async function liquidate(a: Account, reason: string) {
  return withAccountLock(a.id, async () => {
    const s = await snapshot(a);
    const rows = [];
    // liquidation is allowed during kill switch / halt: it only reduces risk
    for (const p of s.positions) rows.push(await executeOrder(a, p.symbol, "sell", { qty: p.qty }, { kind: "liquidate", reason }));
    return rows;
  });
}
