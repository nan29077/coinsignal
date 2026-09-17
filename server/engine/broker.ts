import { randomUUID } from "node:crypto";
import { db, nowIso } from "../db.ts";
import { AppError, errorMessage } from "../errors.ts";
import { orderbook, tickerMap, type Orderbook } from "../exchanges/public.ts";
import { ExchangeError, floorTo, liveClient, type Balance, type LiveClient, type OrderState } from "../exchanges/private.ts";
import { exchangeCredentials, logEvent } from "../settings.ts";
import { accountLabel, type Account, type Position } from "./accounts.ts";

export type OrderKind = "rebalance" | "stop_loss" | "take_profit" | "manual" | "liquidate" | "exit";
export type OrderCtx = { planId?: string | null; kind: OrderKind; reason: string; stopLossPct?: number | null; takeProfitPct?: number | null };
export type Fill = { qty: number; krw: number; fee: number };
export type OrderRow = {
  id: string;
  account_id: string;
  plan_id: string | null;
  symbol: string;
  side: "buy" | "sell";
  kind: string;
  requested_krw: number | null;
  requested_qty: number | null;
  status: string;
  exchange_order_id: string | null;
  executed_qty: number;
  executed_krw: number;
  fee_krw: number;
  avg_price: number | null;
  pnl_krw: number | null;
  reason: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
};

export const MIN_ORDER_KRW = 5000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ paper simulation (pure)
export function simulateBuy(book: Orderbook, krw: number, feePct: number, slippagePct: number): Fill {
  const fee = feePct / 100;
  const slip = slippagePct / 100;
  let remain = krw / (1 + fee);
  let qty = 0;
  let gross = 0;
  for (const level of book.asks) {
    const price = level.price * (1 + slip);
    const take = Math.min(level.qty, remain / price);
    qty += take;
    gross += take * price;
    remain -= take * price;
    if (remain < 0.01) break;
  }
  if (remain > 1 || qty <= 0) throw new AppError("호가 잔량이 부족해 전량 체결할 수 없습니다.");
  return { qty, krw: gross, fee: gross * fee };
}

export function simulateSell(book: Orderbook, qty: number, feePct: number, slippagePct: number): Fill {
  const fee = feePct / 100;
  const slip = slippagePct / 100;
  let remain = qty;
  let gross = 0;
  for (const level of book.bids) {
    const take = Math.min(level.qty, remain);
    gross += take * level.price * (1 - slip);
    remain -= take;
    if (remain <= qty * 1e-10) break;
  }
  if (remain > qty * 1e-8) throw new AppError("호가 잔량이 부족해 전량 매도할 수 없습니다.");
  return { qty, krw: gross, fee: gross * fee };
}

// ------------------------------------------------------------------ position bookkeeping
function applyBuy(accountId: string, symbol: string, fill: Fill, ctx: OrderCtx) {
  const pos = db().get<Position>("SELECT * FROM positions WHERE account_id = ? AND symbol = ?", accountId, symbol);
  if (pos) {
    db().run(
      "UPDATE positions SET qty = qty + ?, cost_krw = cost_krw + ?, stop_loss_pct = COALESCE(?, stop_loss_pct), take_profit_pct = COALESCE(?, take_profit_pct) WHERE account_id = ? AND symbol = ?",
      fill.qty,
      fill.krw + fill.fee,
      ctx.stopLossPct ?? null,
      ctx.takeProfitPct ?? null,
      accountId,
      symbol,
    );
  } else {
    db().run(
      "INSERT INTO positions (account_id, symbol, qty, cost_krw, opened_at, stop_loss_pct, take_profit_pct) VALUES (?, ?, ?, ?, ?, ?, ?)",
      accountId,
      symbol,
      fill.qty,
      fill.krw + fill.fee,
      nowIso(),
      ctx.stopLossPct ?? null,
      ctx.takeProfitPct ?? null,
    );
  }
}

/** Returns realized PnL (net of the sell fee and the cost basis of the sold portion). */
function applySell(accountId: string, symbol: string, fill: Fill): number {
  const pos = db().get<Position>("SELECT * FROM positions WHERE account_id = ? AND symbol = ?", accountId, symbol);
  if (!pos || pos.qty <= 0) return fill.krw - fill.fee;
  const portion = Math.min(1, fill.qty / pos.qty);
  const costPart = pos.cost_krw * portion;
  const remaining = pos.qty - fill.qty;
  if (portion >= 0.999999 || remaining <= pos.qty * 1e-6) db().run("DELETE FROM positions WHERE account_id = ? AND symbol = ?", accountId, symbol);
  else db().run("UPDATE positions SET qty = ?, cost_krw = cost_krw - ? WHERE account_id = ? AND symbol = ?", remaining, costPart, accountId, symbol);
  return fill.krw - fill.fee - costPart;
}

function insertOrder(a: Account, symbol: string, side: "buy" | "sell", ctx: OrderCtx, req: { krw?: number; qty?: number }) {
  const id = randomUUID();
  const t = nowIso();
  db().run(
    "INSERT INTO orders (id, account_id, plan_id, symbol, side, kind, requested_krw, requested_qty, status, reason, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'submitting', ?, ?, ?)",
    id,
    a.id,
    ctx.planId ?? null,
    symbol,
    side,
    ctx.kind,
    req.krw ?? null,
    req.qty ?? null,
    ctx.reason.slice(0, 1000),
    t,
    t,
  );
  return id;
}

function updateOrder(id: string, fields: Partial<Record<keyof OrderRow, string | number | null>>) {
  const keys = Object.keys(fields);
  db().run(`UPDATE orders SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`, ...keys.map((k) => fields[k as keyof OrderRow] ?? null), nowIso(), id);
}

export const getOrderRow = (id: string) => db().get<OrderRow>("SELECT * FROM orders WHERE id = ?", id)!;

// ------------------------------------------------------------------ live helpers
const balanceCache = new Map<string, { at: number; value: Balance[] }>();

export function clientFor(a: Account): LiveClient {
  const creds = exchangeCredentials(a.exchange);
  if (!creds) throw new AppError(`${accountLabel(a)}: 거래소 API 키가 등록되지 않았습니다.`);
  return liveClient(a.exchange, creds);
}

export async function liveBalances(a: Account, maxAgeMs = 10_000): Promise<Balance[]> {
  const hit = balanceCache.get(a.exchange);
  if (hit && Date.now() - hit.at < maxAgeMs) return hit.value;
  const value = await clientFor(a).balances();
  balanceCache.set(a.exchange, { at: Date.now(), value });
  return value;
}
export const invalidateBalances = (e: string) => balanceCache.delete(e);

async function waitForFinal(client: LiveClient, symbol: string, ref: { exchangeOrderId?: string | null; clientId: string }, maxMs = 20_000) {
  const deadline = Date.now() + maxMs;
  let last: OrderState | null = null;
  let delay = 700;
  while (Date.now() < deadline) {
    await sleep(delay);
    delay = Math.min(delay * 1.6, 4000);
    try {
      last = await client.getOrder(symbol, ref);
    } catch {
      continue;
    }
    if (last?.final) return last;
  }
  return last;
}

function recordLiveFill(a: Account, orderId: string, side: "buy" | "sell", symbol: string, st: OrderState, ctx: OrderCtx) {
  db().tx(() => {
    const fill = { qty: st.executedQty, krw: st.executedKrw, fee: st.feeKrw };
    let pnl: number | null = null;
    if (fill.qty > 0) {
      if (side === "buy") applyBuy(a.id, symbol, fill, ctx);
      else pnl = applySell(a.id, symbol, fill);
    }
    updateOrder(orderId, {
      status: !st.final ? "submitted" : fill.qty > 0 ? "filled" : "canceled",
      executed_qty: fill.qty,
      executed_krw: fill.krw,
      fee_krw: fill.fee,
      avg_price: fill.qty > 0 ? fill.krw / fill.qty : null,
      pnl_krw: pnl,
    });
  });
}

// ------------------------------------------------------------------ public API
export async function executeOrder(a: Account, symbol: string, side: "buy" | "sell", amount: { krw?: number; qty?: number }, ctx: OrderCtx): Promise<OrderRow> {
  if (side === "buy" && !(amount.krw && amount.krw >= MIN_ORDER_KRW)) throw new AppError(`최소 주문 금액은 ${MIN_ORDER_KRW.toLocaleString()}원입니다.`);
  if (side === "sell" && !(amount.qty && amount.qty > 0)) throw new AppError("매도 수량이 없습니다.");
  const id = insertOrder(a, symbol, side, ctx, amount);
  const label = accountLabel(a);

  if (a.mode === "paper") {
    try {
      const book = await orderbook(a.exchange, symbol);
      const fresh = db().get<Account>("SELECT * FROM accounts WHERE id = ?", a.id)!;
      db().tx(() => {
        if (side === "buy") {
          const fill = simulateBuy(book, amount.krw!, fresh.fee_pct, fresh.slippage_pct);
          if (fill.krw + fill.fee > fresh.cash_krw + 0.5) throw new AppError("모의 계좌 현금이 부족합니다.");
          db().run("UPDATE accounts SET cash_krw = cash_krw - ? WHERE id = ?", fill.krw + fill.fee, a.id);
          applyBuy(a.id, symbol, fill, ctx);
          updateOrder(id, { status: "filled", executed_qty: fill.qty, executed_krw: fill.krw, fee_krw: fill.fee, avg_price: fill.krw / fill.qty });
        } else {
          const pos = db().get<Position>("SELECT * FROM positions WHERE account_id = ? AND symbol = ?", a.id, symbol);
          if (!pos) throw new AppError("보유하지 않은 종목입니다.");
          const qty = Math.min(amount.qty!, pos.qty);
          const fill = simulateSell(book, qty, fresh.fee_pct, fresh.slippage_pct);
          db().run("UPDATE accounts SET cash_krw = cash_krw + ? WHERE id = ?", fill.krw - fill.fee, a.id);
          const pnl = applySell(a.id, symbol, fill);
          updateOrder(id, { status: "filled", executed_qty: fill.qty, executed_krw: fill.krw, fee_krw: fill.fee, avg_price: fill.krw / fill.qty, pnl_krw: pnl });
        }
      });
    } catch (e) {
      updateOrder(id, { status: "failed", error: errorMessage(e, "모의 체결 실패") });
    }
  } else {
    const client = clientFor(a);
    let qty = amount.qty;
    if (side === "sell") {
      // Never ask the exchange to sell more than is actually available (fees in coin, locked coins, manual sells).
      try {
        const available = (await liveBalances(a, 0)).find((b) => b.currency === symbol)?.available ?? 0;
        qty = floorTo(Math.min(amount.qty!, available), 1e-8);
        const price = (await tickerMap(a.exchange)).get(symbol)?.price ?? 0;
        if (!(qty > 0) || qty * price < MIN_ORDER_KRW) throw new AppError(`매도 가능 수량이 없거나 최소 주문 금액(${MIN_ORDER_KRW.toLocaleString()}원) 미만입니다.`);
        updateOrder(id, { requested_qty: qty });
      } catch (e) {
        updateOrder(id, { status: "failed", error: errorMessage(e, "매도 수량 확인 실패") });
        return finalizeLog(a, id, label);
      }
    }
    let exchangeOrderId: string | null = null;
    try {
      exchangeOrderId = side === "buy" ? await client.marketBuy(symbol, amount.krw!, id) : await client.marketSell(symbol, qty!, id);
      updateOrder(id, { status: "submitted", exchange_order_id: exchangeOrderId });
    } catch (e) {
      if (e instanceof ExchangeError && e.uncertain) {
        // The order may exist. Mark it unknown so nothing is double-counted; the monitor keeps checking by client id.
        updateOrder(id, { status: "unknown", error: errorMessage(e, "주문 결과 불확실") });
        await sleep(2000);
        const found = await client.getOrder(symbol, { clientId: id }).catch(() => null);
        if (found) {
          updateOrder(id, { status: "submitted", error: null });
          recordLiveFill(a, id, side, symbol, found.final ? found : ((await waitForFinal(client, symbol, { clientId: id })) ?? found), ctx);
        }
        invalidateBalances(a.exchange);
        return finalizeLog(a, id, label);
      }
      updateOrder(id, { status: "failed", error: errorMessage(e, "주문 실패") });
      return finalizeLog(a, id, label);
    }
    const st = await waitForFinal(client, symbol, { exchangeOrderId, clientId: id });
    if (st) recordLiveFill(a, id, side, symbol, st, ctx);
    invalidateBalances(a.exchange);
  }
  return finalizeLog(a, id, label);
}

function finalizeLog(a: Account, id: string, label: string) {
  const o = getOrderRow(id);
  const sideKo = o.side === "buy" ? "매수" : "매도";
  if (o.status === "filled")
    logEvent(
      "trade",
      `${label} ${o.symbol} ${sideKo} 체결 ${Math.round(o.executed_krw).toLocaleString()}원 (${o.kind})${o.pnl_krw !== null ? ` 손익 ${Math.round(o.pnl_krw).toLocaleString()}원` : ""}`,
      a.id,
    );
  else if (o.status === "failed") logEvent("error", `${label} ${o.symbol} ${sideKo} 실패: ${o.error}`, a.id);
  else logEvent("warn", `${label} ${o.symbol} ${sideKo} 상태 ${o.status} — 체결 확인 대기`, a.id);
  return o;
}

export const OPEN_STATUSES = ["submitting", "submitted", "unknown"];

export function hasOpenOrder(accountId: string, symbol: string) {
  return !!db().get("SELECT 1 FROM orders WHERE account_id = ? AND symbol = ? AND status IN ('submitting','submitted','unknown')", accountId, symbol);
}

/** Re-check live orders whose outcome is not final yet (slow fills, timeouts, process restarts). */
export async function reconcileOpenOrders(a: Account) {
  if (a.mode !== "live") return;
  const open = db().all<OrderRow>(
    "SELECT * FROM orders WHERE account_id = ? AND status IN ('submitting','submitted','unknown') AND updated_at < ?",
    a.id,
    new Date(Date.now() - 20_000).toISOString(),
  );
  if (!open.length) return;
  const client = clientFor(a);
  for (const o of open) {
    let st: OrderState | null;
    try {
      st = await client.getOrder(o.symbol, { exchangeOrderId: o.exchange_order_id, clientId: o.id });
    } catch {
      continue; // transient: try again next minute
    }
    if (st === null) {
      if (Date.now() - Date.parse(o.created_at) > 10 * 60_000) updateOrder(o.id, { status: "failed", error: "거래소에서 주문을 찾을 수 없음 (미접수로 판단)" });
      continue;
    }
    if (!st.final) continue;
    const delta = { qty: st.executedQty - o.executed_qty, krw: st.executedKrw - o.executed_krw, fee: st.feeKrw - o.fee_krw };
    let ctx: OrderCtx = { kind: o.kind as OrderKind, reason: o.reason ?? "" };
    if (o.plan_id && o.side === "buy") {
      const plan = db().get<{ targets: string }>("SELECT targets FROM plans WHERE id = ?", o.plan_id);
      const t = plan ? (JSON.parse(plan.targets) as { picks: { symbol: string; stopLossPct: number; takeProfitPct: number }[] }).picks.find((x) => x.symbol === o.symbol) : undefined;
      if (t) ctx = { ...ctx, stopLossPct: t.stopLossPct, takeProfitPct: t.takeProfitPct };
    }
    db().tx(() => {
      let pnl = o.pnl_krw;
      if (delta.qty > 0) {
        if (o.side === "buy") applyBuy(a.id, o.symbol, delta, ctx);
        else pnl = (pnl ?? 0) + applySell(a.id, o.symbol, delta);
      }
      updateOrder(o.id, {
        status: st.executedQty > 0 ? "filled" : "canceled",
        exchange_order_id: o.exchange_order_id,
        executed_qty: st.executedQty,
        executed_krw: st.executedKrw,
        fee_krw: st.feeKrw,
        avg_price: st.executedQty > 0 ? st.executedKrw / st.executedQty : null,
        pnl_krw: pnl,
        error: null,
      });
    });
    invalidateBalances(a.exchange);
    finalizeLog(a, o.id, accountLabel(a));
  }
}
