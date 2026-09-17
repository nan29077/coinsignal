import { AppError } from "../errors.ts";
import type { Candle } from "../exchanges/public.ts";

export type Analysis = {
  score: number;
  signal: "매수 검토" | "매도 검토" | "관망";
  rsi: number;
  ma20: number;
  ma60: number;
  volumeRatio: number;
  /** std-dev of hourly returns over last 24h, % */
  volatility: number;
  change24h: number;
  change7d: number | null;
  last: number;
  /** close time of the last completed candle (ms) */
  asOf: number;
  candleCount: number;
  reason: string;
};

const avg = (x: number[]) => x.reduce((a, b) => a + b, 0) / Math.max(x.length, 1);

/** Simple-average RSI over `period` closes. */
export function rsi(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;
  const recent = closes.slice(-(period + 1));
  const diffs = recent.slice(1).map((v, i) => v - recent[i]);
  const gains = avg(diffs.map((d) => Math.max(d, 0)));
  const losses = avg(diffs.map((d) => Math.max(-d, 0)));
  if (losses === 0) return gains === 0 ? 50 : 100;
  return 100 - 100 / (1 + gains / losses);
}

export function analyze(cs: Candle[]): Analysis {
  if (cs.length < 60) throw new AppError("분석에 필요한 완료된 1시간봉이 60개 미만입니다.");
  const p = cs.map((c) => c.close);
  const last = p[p.length - 1];
  const ma20 = avg(p.slice(-20));
  const ma60 = avg(p.slice(-60));
  const r = rsi(p);
  const returns = p.slice(1).map((v, i) => (v / p[i] - 1) * 100).slice(-24);
  const mean = avg(returns);
  const volatility = Math.sqrt(avg(returns.map((x) => (x - mean) ** 2)));
  const volumeRatio = cs[cs.length - 1].volume / Math.max(avg(cs.slice(-21, -1).map((c) => c.volume)), 1e-12);
  const change24h = p.length > 24 ? (last / p[p.length - 25] - 1) * 100 : 0;
  const change7d = p.length > 168 ? (last / p[p.length - 169] - 1) * 100 : null;
  const score = Math.max(
    0,
    Math.min(100, 50 + (last > ma20 ? 15 : -15) + (ma20 > ma60 ? 15 : -15) + (r >= 45 && r < 70 ? 10 : -10) + (volumeRatio > 1.2 ? 10 : 0)),
  );
  const signal = score >= 80 && r < 70 ? "매수 검토" : score <= 30 || r > 80 ? "매도 검토" : "관망";
  return {
    score,
    signal,
    rsi: r,
    ma20,
    ma60,
    volumeRatio,
    volatility,
    change24h,
    change7d,
    last,
    asOf: cs[cs.length - 1].time + 3_600_000,
    candleCount: cs.length,
    reason: `완료된 1시간봉 ${cs.length}개 기준. 종가는 20시간 평균 ${last > ma20 ? "위" : "아래"}, 20시간 평균은 60시간 평균 ${ma20 > ma60 ? "위" : "아래"}. RSI ${r.toFixed(1)}, 최근 거래량 ${volumeRatio.toFixed(2)}배.`,
  };
}
