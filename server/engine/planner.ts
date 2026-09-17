import { MIN_ORDER_KRW } from "./broker.ts";

export type Target = { symbol: string; weight: number; stopLossPct: number; takeProfitPct: number };
export type Targets = { cashWeight: number; picks: Target[]; exits: { symbol: string; reason: string }[]; universe?: string[] };
export type PlannedOrder = { symbol: string; side: "buy" | "sell"; krw: number; qty?: number; currentWeight: number; targetWeight: number; reason: string };

export type PlanInput = {
  equityKrw: number;
  cashKrw: number;
  positions: { symbol: string; qty: number; price: number | null; valueKrw: number | null }[];
  targets: Targets;
  bandPct: number;
  /** live accounts keep a small KRW buffer for fees/rounding */
  feeBufferPct: number;
};

/**
 * Turns target weights into concrete orders. Rules:
 * - positions not in the target list are sold completely, but only if the AI actually evaluated them
 *   (in `universe`) or explicitly listed them in `exits`; coins it never saw are left untouched
 * - a position is trimmed / topped up only when it deviates more than `bandPct` percentage points
 * - orders below the exchange minimum are skipped (a full exit is still allowed below the minimum)
 * - buys are scaled down to the cash that will be available after the sells
 */
export function planOrders(input: PlanInput): PlannedOrder[] {
  const { equityKrw, targets } = input;
  if (!(equityKrw > 0)) return [];
  const band = input.bandPct / 100;
  const want = new Map(targets.picks.map((p) => [p.symbol, p]));
  const exitReason = new Map(targets.exits.map((x) => [x.symbol, x.reason]));
  const sells: PlannedOrder[] = [];
  const buys: PlannedOrder[] = [];

  for (const pos of input.positions) {
    if (!pos.price || pos.valueKrw === null) continue; // unpriced: never trade blind
    const cur = pos.valueKrw / equityKrw;
    const t = want.get(pos.symbol);
    if (!t) {
      const evaluated = !targets.universe || targets.universe.includes(pos.symbol) || exitReason.has(pos.symbol);
      if (!evaluated || pos.valueKrw < MIN_ORDER_KRW) continue; // dust cannot be sold on the exchange
      sells.push({ symbol: pos.symbol, side: "sell", krw: pos.valueKrw, qty: pos.qty, currentWeight: cur, targetWeight: 0, reason: exitReason.get(pos.symbol) ?? "AI 목표 포트폴리오에서 제외" });
      continue;
    }
    const diff = t.weight - cur;
    if (diff < -band) {
      const krw = -diff * equityKrw;
      if (krw >= MIN_ORDER_KRW) {
        const qty = Math.min(pos.qty, krw / pos.price);
        sells.push({ symbol: pos.symbol, side: "sell", krw, qty, currentWeight: cur, targetWeight: t.weight, reason: "목표 비중 초과분 축소" });
      }
    }
  }

  const held = new Map(input.positions.map((p) => [p.symbol, p]));
  for (const t of targets.picks) {
    const pos = held.get(t.symbol);
    if (pos && (!pos.price || pos.valueKrw === null)) continue;
    const cur = pos?.valueKrw ? pos.valueKrw / equityKrw : 0;
    const diff = t.weight - cur;
    if (diff > band || (!pos && t.weight > 0)) {
      const krw = diff * equityKrw;
      if (krw >= MIN_ORDER_KRW) buys.push({ symbol: t.symbol, side: "buy", krw, currentWeight: cur, targetWeight: t.weight, reason: pos ? "목표 비중까지 추가 매수" : "신규 편입" });
    }
  }

  const proceeds = sells.reduce((s, o) => s + o.krw, 0);
  const available = (input.cashKrw + proceeds) * (1 - input.feeBufferPct / 100);
  const wanted = buys.reduce((s, o) => s + o.krw, 0);
  if (wanted > available && wanted > 0) {
    const k = Math.max(0, available) / wanted;
    for (const b of buys) b.krw = Math.floor(b.krw * k);
  }
  return [...sells, ...buys.filter((b) => b.krw >= MIN_ORDER_KRW).sort((a, b) => b.krw - a.krw)];
}
