import { AppError } from "../errors.ts";
import type { Candle } from "../exchanges/public.ts";
import { analyze } from "./indicators.ts";

export type BacktestParams = { feePct: number; slippagePct: number; stopLossPct: number; takeProfitPct: number };

/**
 * Replays the technical rule on hourly candles. Decisions use data up to candle i and fill at the
 * close of candle i+1 (no look-ahead). Strategy and buy&hold both invest 100% of capital with the
 * same costs so the two returns are directly comparable.
 */
export function backtest(cs: Candle[], p: BacktestParams) {
  if (cs.length < 80) throw new AppError("검증에 필요한 이력이 부족합니다 (최소 80개 봉).");
  const f = p.feePct / 100;
  const slip = p.slippagePct / 100;
  const initial = 1_000_000;
  let cash = initial;
  let qty = 0;
  let entry = 0;
  let trades = 0;
  let wins = 0;
  let peak = initial;
  let drawdown = 0;
  const curve: { time: number; value: number; benchmark: number }[] = [];
  const startPrice = cs[60].close * (1 + slip);
  const benchQty = (initial * (1 - f)) / startPrice;

  for (let i = 59; i < cs.length - 1; i++) {
    const a = analyze(cs.slice(0, i + 1));
    const next = cs[i + 1];
    if (qty > 0) {
      const ret = (cs[i].close / entry - 1) * 100;
      if (a.signal === "매도 검토" || ret <= -p.stopLossPct || ret >= p.takeProfitPct) {
        const proceeds = qty * next.close * (1 - slip) * (1 - f);
        if (proceeds > qty * entry) wins++;
        cash += proceeds;
        qty = 0;
        trades++;
      }
    } else if (a.signal === "매수 검토") {
      entry = next.close * (1 + slip);
      qty = (cash * (1 - f)) / entry;
      cash = 0;
      trades++;
    }
    const value = cash + qty * next.close;
    peak = Math.max(peak, value);
    drawdown = Math.max(drawdown, ((peak - value) / peak) * 100);
    curve.push({ time: next.time + 3_600_000, value, benchmark: benchQty * next.close });
  }
  const last = curve[curve.length - 1];
  const sells = Math.floor(trades / 2);
  return {
    curve,
    returnPct: (last.value / initial - 1) * 100,
    benchmarkPct: (last.benchmark / initial - 1) * 100,
    drawdownPct: drawdown,
    trades,
    winRatePct: sells ? (wins / sells) * 100 : null,
    openPosition: qty > 0,
    start: cs[60].time + 3_600_000,
    end: last.time,
  };
}
