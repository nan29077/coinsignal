import type { Exchange } from "../settings.ts";
import { candles, markets, tickers, type Ticker } from "../exchanges/public.ts";
import { mapLimit } from "../exchanges/http.ts";
import { analyze, type Analysis } from "./indicators.ts";

/** Fiat/commodity-pegged tokens that should never be treated as growth investments. */
export const PEGGED = new Set([
  "USDT", "USDC", "USDE", "USDS", "DAI", "FDUSD", "TUSD", "PYUSD", "USD1", "RLUSD", "USDP", "GUSD", "BUSD", "FRAX", "LUSD", "SUSD",
  "USDD", "USDX", "USDG", "EURC", "EURT", "JPYC", "KRWO", "XSGD", "XAUT", "PAXG", "BKRW", "KRT",
]);

export function isPegged(symbol: string, name = "") {
  if (PEGGED.has(symbol)) return true;
  return /^(USD|EUR|JPY|KRW)[A-Z0-9]{0,3}$/.test(symbol) || /stable ?coin|스테이블/i.test(name);
}

export type Candidate = {
  symbol: string;
  name: string;
  price: number;
  changePct: number;
  volumeKrw: number;
  analysis: Analysis;
  held: boolean;
};

export type ScreenResult = { candidates: Candidate[]; excluded: { symbol: string; reason: string }[]; universe: number };

const MIN_VOLUME_KRW = 1_000_000_000; // 10억원 / 24h
const MIN_HISTORY = 150; // ~6 days of hourly candles → excludes fresh listings

/**
 * Step 1 of the AI pipeline: cheap, deterministic filtering so the model only sees liquid,
 * established, non-pegged coins that are not under an exchange warning.
 */
export async function screen(e: Exchange, count: number, heldSymbols: string[] = []): Promise<ScreenResult> {
  const [all, meta] = await Promise.all([tickers(e), markets(e)]);
  const metaBy = new Map(meta.map((m) => [m.symbol, m]));
  const excluded: { symbol: string; reason: string }[] = [];
  const now = Date.now();
  const held = new Set(heldSymbols);

  const pre: Ticker[] = [];
  for (const t of all) {
    const m = metaBy.get(t.symbol);
    let reason = "";
    if (isPegged(t.symbol, t.name)) reason = "스테이블/페깅 자산";
    else if (t.warning) reason = "거래소 투자 경고·주의 종목";
    else if (m && !m.tradable) reason = "거래 중단/점검";
    else if (now - t.timestamp > 5 * 60_000) reason = "시세 갱신 지연";
    else if (t.volumeKrw < MIN_VOLUME_KRW && !held.has(t.symbol)) reason = "거래대금 부족";
    if (reason) {
      if (t.volumeKrw >= MIN_VOLUME_KRW || held.has(t.symbol)) excluded.push({ symbol: t.symbol, reason });
      continue;
    }
    pre.push(t);
  }
  // Keep held coins plus the most liquid names for deeper (candle based) checks.
  const shortlist = [...pre.filter((t) => held.has(t.symbol)), ...pre.filter((t) => !held.has(t.symbol)).slice(0, Math.max(count * 2, 30))];

  const analysed = await mapLimit(shortlist, 4, async (t) => {
    try {
      const cs = await candles(e, t.symbol);
      if (cs.length < MIN_HISTORY) return { t, reason: "신규 상장(이력 부족)" };
      const a = analyze(cs);
      if (a.volatility < 0.05 && Math.abs(a.change24h) < 0.3) return { t, reason: "가격 변동 없음(페깅 추정)" };
      return { t, a };
    } catch {
      return { t, reason: "캔들 조회 실패" };
    }
  });

  const candidates: Candidate[] = [];
  for (const r of analysed) {
    if ("reason" in r && r.reason) {
      excluded.push({ symbol: r.t.symbol, reason: r.reason });
      continue;
    }
    if (!("a" in r) || !r.a) continue;
    candidates.push({ symbol: r.t.symbol, name: r.t.name, price: r.t.price, changePct: r.t.changePct, volumeKrw: r.t.volumeKrw, analysis: r.a, held: held.has(r.t.symbol) });
  }
  // Rank: held first (the model must decide keep/exit), then liquidity-weighted technical score.
  candidates.sort((a, b) => Number(b.held) - Number(a.held) || rank(b) - rank(a));
  const heldCount = candidates.filter((c) => c.held).length;
  return { candidates: candidates.slice(0, Math.max(count, heldCount)), excluded, universe: all.length };
}

function rank(c: Candidate) {
  return c.analysis.score + Math.log10(Math.max(c.volumeKrw, 1)) * 5;
}
