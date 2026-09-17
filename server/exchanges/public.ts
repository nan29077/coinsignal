import { AppError, upstream } from "../errors.ts";
import type { Exchange } from "../settings.ts";
import { getJson } from "./http.ts";

export type Ticker = {
  symbol: string;
  name: string;
  price: number;
  /** % change: Upbit/Bithumb vs previous close (KST 00/09h), Coinone vs 24h ago */
  changePct: number;
  volumeKrw: number;
  /** ms, normalized to real UTC epoch */
  timestamp: number;
  /** exchange investment warning / caution flag */
  warning: boolean;
};
export type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number };
export type Level = { price: number; qty: number };
export type Orderbook = { bids: Level[]; asks: Level[]; timestamp: number };
export type MarketMeta = { symbol: string; name: string; warning: boolean; qtyUnit?: number; minOrderKrw: number; tradable: boolean };

const HOUR = 3_600_000;
const LABEL: Record<Exchange, string> = { upbit: "업비트", bithumb: "빗썸", coinone: "코인원" };
const base = (e: "upbit" | "bithumb") => (e === "upbit" ? "https://api.upbit.com" : "https://api.bithumb.com");

export const symbolOf = (s: unknown): string => {
  if (typeof s === "string" && /^[A-Za-z0-9]{1,20}$/.test(s)) return s.toUpperCase();
  throw new AppError("올바른 종목이 아닙니다.");
};

/**
 * Bithumb's ticker timestamp is currently shifted +9h (KST encoded as UTC). Any timestamp more than
 * 10 minutes in the future is corrected by exactly 9 hours; anything else is left untouched.
 */
export function normalizeTimestamp(ts: number, now = Date.now()): number {
  if (!Number.isFinite(ts)) return NaN;
  if (ts - now > 10 * 60_000 && Math.abs(ts - 9 * HOUR - now) < 10 * 60_000) return ts - 9 * HOUR;
  return ts;
}

const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN);

// ---------------- caches ----------------
type CacheEntry<T> = { at: number; value: Promise<T> };
const caches = new Map<string, CacheEntry<unknown>>();
function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const hit = caches.get(key) as CacheEntry<T> | undefined;
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  const value = load();
  caches.set(key, { at: Date.now(), value });
  value.catch(() => caches.delete(key));
  return value;
}
export function clearMarketCache() {
  caches.clear();
}

// ---------------- markets ----------------
export function markets(e: Exchange): Promise<MarketMeta[]> {
  return cached(`markets:${e}`, 10 * 60_000, async () => {
    if (e === "coinone") {
      const [m, c] = await Promise.all([
        getJson<{ result: string; markets: Record<string, string | number>[] }>("https://api.coinone.co.kr/public/v2/markets/KRW", LABEL[e]),
        getJson<{ result: string; currencies: { name: string; symbol: string }[] }>("https://api.coinone.co.kr/public/v2/currencies", LABEL[e]).catch(
          () => ({ result: "error", currencies: [] as { name: string; symbol: string }[] }),
        ),
      ]);
      if (m.result !== "success" || !Array.isArray(m.markets)) throw upstream("코인원 종목 목록을 불러오지 못했습니다.");
      const names = new Map(c.currencies.map((x) => [x.symbol.toUpperCase(), x.name]));
      return m.markets.map((x) => {
        const symbol = String(x.target_currency).toUpperCase();
        return {
          symbol,
          name: names.get(symbol) ?? symbol,
          warning: false,
          qtyUnit: num(x.qty_unit) || undefined,
          minOrderKrw: Math.max(5000, num(x.min_order_amount) || 0),
          tradable: Number(x.trade_status) === 1 && Number(x.maintenance_status) === 0,
        };
      });
    }
    if (e === "upbit") {
      const all = await getJson<{ market: string; korean_name: string; market_event?: { warning?: boolean; caution?: Record<string, boolean> } }[]>(
        `${base(e)}/v1/market/all?is_details=true`,
        LABEL[e],
      );
      if (!Array.isArray(all)) throw upstream("업비트 종목 목록 형식이 올바르지 않습니다.");
      return all
        .filter((x) => x.market.startsWith("KRW-"))
        .map((x) => ({
          symbol: x.market.slice(4),
          name: x.korean_name,
          warning: !!x.market_event?.warning || Object.values(x.market_event?.caution ?? {}).some(Boolean),
          minOrderKrw: 5000,
          tradable: true,
        }));
    }
    const [all, warnings] = await Promise.all([
      getJson<{ market: string; korean_name: string; market_warning?: string }[]>(`${base(e)}/v1/market/all?isDetails=true`, LABEL[e]),
      getJson<{ market: string }[]>(`${base(e)}/v1/market/virtual_asset_warning`, LABEL[e]).catch(() => [] as { market: string }[]),
    ]);
    if (!Array.isArray(all)) throw upstream("빗썸 종목 목록 형식이 올바르지 않습니다.");
    const warned = new Set(Array.isArray(warnings) ? warnings.map((w) => w.market) : []);
    return all
      .filter((x) => x.market.startsWith("KRW-"))
      .map((x) => ({
        symbol: x.market.slice(4),
        name: x.korean_name,
        warning: (x.market_warning && x.market_warning !== "NONE") || warned.has(x.market),
        minOrderKrw: 5000,
        tradable: true,
      }));
  });
}

// ---------------- tickers ----------------
export function tickers(e: Exchange): Promise<Ticker[]> {
  return cached(`tickers:${e}`, 5_000, async () => {
    const meta = await markets(e);
    const metaBy = new Map(meta.map((m) => [m.symbol, m]));
    let out: Ticker[] = [];
    if (e === "coinone") {
      const d = await getJson<{ result: string; tickers: Record<string, unknown>[] }>("https://api.coinone.co.kr/public/v2/ticker_new/KRW", LABEL[e]);
      if (d.result !== "success" || !Array.isArray(d.tickers)) throw upstream("코인원 시세를 불러오지 못했습니다.");
      out = d.tickers.map((t) => {
        const symbol = String(t.target_currency).toUpperCase();
        const last = num(t.last);
        const first = num(t.first);
        return {
          symbol,
          name: metaBy.get(symbol)?.name ?? symbol,
          price: last,
          changePct: first > 0 ? (last / first - 1) * 100 : 0,
          volumeKrw: num(t.quote_volume),
          timestamp: normalizeTimestamp(num(t.timestamp)),
          warning: metaBy.get(symbol)?.warning ?? false,
        };
      });
    } else {
      const list = meta.map((m) => `KRW-${m.symbol}`);
      for (let i = 0; i < list.length; i += 100) {
        const group = list.slice(i, i + 100);
        const rows = await getJson<Record<string, unknown>[]>(`${base(e)}/v1/ticker?markets=${group.join(",")}`, LABEL[e]);
        if (!Array.isArray(rows)) throw upstream(`${LABEL[e]} 시세 형식이 올바르지 않습니다.`);
        for (const t of rows) {
          const symbol = String(t.market).slice(4);
          out.push({
            symbol,
            name: metaBy.get(symbol)?.name ?? symbol,
            price: num(t.trade_price),
            changePct: num(t.signed_change_rate) * 100,
            volumeKrw: num(t.acc_trade_price_24h),
            timestamp: normalizeTimestamp(num(t.timestamp)),
            warning: metaBy.get(symbol)?.warning ?? false,
          });
        }
      }
    }
    return out
      .filter((t) => Number.isFinite(t.price) && t.price > 0 && Number.isFinite(t.timestamp))
      .map((t) => ({ ...t, changePct: Number.isFinite(t.changePct) ? t.changePct : 0, volumeKrw: Number.isFinite(t.volumeKrw) ? t.volumeKrw : 0 }))
      .sort((a, b) => b.volumeKrw - a.volumeKrw);
  });
}

// ---------------- candles ----------------
/** Completed 1h candles (oldest → newest), max ~199. */
export function candles(e: Exchange, rawSymbol: string): Promise<Candle[]> {
  const symbol = symbolOf(rawSymbol);
  return cached(`candles:${e}:${symbol}`, 60_000, async () => {
    let out: Candle[];
    if (e === "coinone") {
      const d = await getJson<{ result: string; chart: Record<string, unknown>[] }>(
        `https://api.coinone.co.kr/public/v2/chart/KRW/${symbol}?interval=1h&size=200`,
        LABEL[e],
      );
      if (d.result !== "success" || !Array.isArray(d.chart)) throw upstream("코인원 과거 이력을 불러오지 못했습니다.");
      out = d.chart.map((c) => ({ time: num(c.timestamp), open: num(c.open), high: num(c.high), low: num(c.low), close: num(c.close), volume: num(c.target_volume) }));
    } else {
      const d = await getJson<Record<string, unknown>[]>(`${base(e)}/v1/candles/minutes/60?market=KRW-${symbol}&count=200`, LABEL[e]);
      if (!Array.isArray(d)) throw upstream(`${LABEL[e]} 과거 이력을 불러오지 못했습니다.`);
      out = d.map((c) => ({
        time: Date.parse(`${c.candle_date_time_utc}Z`),
        open: num(c.opening_price),
        high: num(c.high_price),
        low: num(c.low_price),
        close: num(c.trade_price),
        volume: num(c.candle_acc_trade_volume),
      }));
    }
    const now = Date.now();
    return out.filter((c) => c.time + HOUR <= now && Number.isFinite(c.close) && c.close > 0).sort((a, b) => a.time - b.time);
  });
}

// ---------------- orderbook ----------------
export async function orderbook(e: Exchange, rawSymbol: string): Promise<Orderbook> {
  const symbol = symbolOf(rawSymbol);
  let bids: { price: unknown; qty: unknown }[];
  let asks: { price: unknown; qty: unknown }[];
  let timestamp: number;
  if (e === "coinone") {
    const d = await getJson<{ result: string; bids: { price: string; qty: string }[]; asks: { price: string; qty: string }[]; timestamp: number }>(
      `https://api.coinone.co.kr/public/v2/orderbook/KRW/${symbol}?size=15`,
      LABEL[e],
    );
    if (d.result !== "success") throw upstream("코인원 호가를 불러오지 못했습니다.");
    bids = d.bids;
    asks = d.asks;
    timestamp = normalizeTimestamp(num(d.timestamp));
  } else {
    const d = await getJson<{ timestamp: number; orderbook_units: Record<string, number>[] }[]>(`${base(e)}/v1/orderbook?markets=KRW-${symbol}`, LABEL[e]);
    const row = Array.isArray(d) ? d[0] : undefined;
    if (!row) throw upstream("호가를 확인할 수 없습니다.");
    bids = row.orderbook_units.map((x) => ({ price: x.bid_price, qty: x.bid_size }));
    asks = row.orderbook_units.map((x) => ({ price: x.ask_price, qty: x.ask_size }));
    timestamp = normalizeTimestamp(num(row.timestamp));
  }
  const now = Date.now();
  if (!Array.isArray(bids) || !Array.isArray(asks) || !Number.isFinite(timestamp) || now - timestamp > 60_000 || timestamp > now + 10_000) {
    throw upstream("호가가 오래되었거나 유효하지 않습니다.");
  }
  const clean = (a: { price: unknown; qty: unknown }[]) =>
    a.map((x) => ({ price: num(x.price), qty: num(x.qty) })).filter((x) => Number.isFinite(x.price) && Number.isFinite(x.qty) && x.price > 0 && x.qty > 0);
  return { bids: clean(bids).sort((a, b) => b.price - a.price), asks: clean(asks).sort((a, b) => a.price - b.price), timestamp };
}

export async function tickerMap(e: Exchange) {
  return new Map((await tickers(e)).map((t) => [t.symbol, t]));
}
