import { db } from "../db.ts";
import { tickerMap } from "../exchanges/public.ts";
import { getPositions, type Account } from "./accounts.ts";
import { hasOpenOrder, liveBalances } from "./broker.ts";

export type PositionView = {
  symbol: string;
  name: string;
  qty: number;
  costKrw: number;
  avgPrice: number;
  price: number | null;
  valueKrw: number | null;
  pnlKrw: number | null;
  pnlPct: number | null;
  stopLossPct: number;
  takeProfitPct: number;
  /** price missing or older than 3 minutes */
  stale: boolean;
  /** live only: coins on the exchange that are fewer than our bookkeeping (manual sell / withdrawal) */
  exchangeQty?: number;
  openedAt: string;
};

export type Snapshot = {
  account: Account;
  cashKrw: number;
  /** live: KRW locked in open orders */
  lockedKrw: number;
  positions: PositionView[];
  equityKrw: number;
  /** equity could not be fully priced */
  stale: boolean;
  error?: string;
};

const PRICE_MAX_AGE = 3 * 60_000;

/**
 * @param opts.reconcile shrink bookkeeping to the exchange balance. Only pass true while holding the
 * account lock (monitor loop), otherwise an in-flight sell could be double-counted.
 */
export async function snapshot(a: Account, opts: { reconcile?: boolean } = {}): Promise<Snapshot> {
  const positions = getPositions(a.id);
  let cash = a.cash_krw;
  let locked = 0;
  let balances: Map<string, number> | null = null;
  let error: string | undefined;

  if (a.mode === "live") {
    try {
      const b = await liveBalances(a);
      const krw = b.find((x) => x.currency === "KRW");
      cash = krw?.available ?? 0;
      locked = krw?.locked ?? 0;
      balances = new Map(b.map((x) => [x.currency, x.available + x.locked]));
    } catch (e) {
      error = e instanceof Error ? e.message : "잔고 조회 실패";
      cash = 0;
    }
  }

  let prices: Awaited<ReturnType<typeof tickerMap>> | null = null;
  try {
    prices = await tickerMap(a.exchange);
  } catch (e) {
    error = error ?? (e instanceof Error ? e.message : "시세 조회 실패");
  }

  const now = Date.now();
  let stale = !!error;
  const views: PositionView[] = positions.map((p) => {
    const t = prices?.get(p.symbol);
    const fresh = !!t && now - t.timestamp <= PRICE_MAX_AGE;
    const price = t ? t.price : p.last_price;
    if (t) db().run("UPDATE positions SET last_price = ?, last_price_at = ? WHERE account_id = ? AND symbol = ?", t.price, t.timestamp, a.id, p.symbol);
    let qty = p.qty;
    let exchangeQty: number | undefined;
    if (balances) {
      exchangeQty = balances.get(p.symbol) ?? 0;
      if (exchangeQty < qty * 0.999) {
        // Coins left the account outside the app (manual sell / withdrawal).
        if (opts.reconcile && !hasOpenOrder(a.id, p.symbol)) {
          db().run("UPDATE positions SET qty = ?, cost_krw = cost_krw * ? WHERE account_id = ? AND symbol = ? AND qty = ?", exchangeQty, exchangeQty / qty, a.id, p.symbol, qty);
        }
        qty = exchangeQty;
      }
    }
    if (!fresh) stale = true;
    const cost = balances && exchangeQty !== undefined && exchangeQty < p.qty * 0.999 ? p.cost_krw * (exchangeQty / p.qty) : p.cost_krw;
    const value = price ? qty * price : null;
    return {
      symbol: p.symbol,
      name: t?.name ?? p.symbol,
      qty,
      costKrw: cost,
      avgPrice: qty > 0 ? cost / qty : 0,
      price: price ?? null,
      valueKrw: value,
      pnlKrw: value !== null ? value - cost : null,
      pnlPct: value !== null && cost > 0 ? (value / cost - 1) * 100 : null,
      stopLossPct: p.stop_loss_pct ?? a.default_stop_loss_pct,
      takeProfitPct: p.take_profit_pct ?? a.default_take_profit_pct,
      stale: !fresh,
      exchangeQty,
      openedAt: p.opened_at,
    };
  });
  if (opts.reconcile) db().run("DELETE FROM positions WHERE account_id = ? AND qty <= 0", a.id);
  const equity = cash + locked + views.reduce((s, v) => s + (v.valueKrw ?? 0), 0);
  return { account: a, cashKrw: cash, lockedKrw: locked, positions: views.filter((v) => v.qty > 0), equityKrw: equity, stale, error };
}
