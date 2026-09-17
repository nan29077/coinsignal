import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { test } from "node:test";
import { simulateBuy, simulateSell } from "../server/engine/broker.ts";
import { planOrders } from "../server/engine/planner.ts";
import { exitDecisions } from "../server/engine/risk.ts";
import { validateResearch } from "../server/ai/research.ts";
import { costUsd } from "../server/ai/models.ts";
import { periodStart } from "../server/ai/budget.ts";
import { floorTo, queryString, signJwt } from "../server/exchanges/private.ts";
import { normalizeTimestamp } from "../server/exchanges/public.ts";
import { isPegged } from "../server/market/screen.ts";
import { analyze, rsi } from "../server/market/indicators.ts";
import { backtest } from "../server/market/backtest.ts";

const book = { bids: [{ price: 99, qty: 100_000 }], asks: [{ price: 100, qty: 100_000 }], timestamp: Date.now() };

test("paper buy spends exactly the budget including fee and slippage", () => {
  const f = simulateBuy(book, 1_000_000, 0.05, 0.05);
  assert.ok(Math.abs(f.krw + f.fee - 1_000_000) < 1e-6);
  assert.ok(Math.abs(f.krw / f.qty - 100.05) < 1e-9);
});

test("paper sell applies slippage and fee, rejects thin books atomically", () => {
  const f = simulateSell(book, 10, 0.05, 0.05);
  assert.ok(Math.abs(f.krw - 10 * 99 * 0.9995) < 1e-9);
  assert.ok(Math.abs(f.fee - f.krw * 0.0005) < 1e-9);
  assert.throws(() => simulateBuy({ ...book, asks: [{ price: 100, qty: 1 }] }, 1_000_000, 0.05, 0.05), /잔량/);
  assert.throws(() => simulateSell({ ...book, bids: [{ price: 99, qty: 1 }] }, 10, 0.05, 0.05), /잔량/);
});

test("planner: exits, trims, tops up, respects band and cash", () => {
  const orders = planOrders({
    equityKrw: 10_000_000,
    cashKrw: 2_000_000,
    positions: [
      { symbol: "OLD", qty: 10, price: 200_000, valueKrw: 2_000_000 },
      { symbol: "BTC", qty: 1, price: 5_000_000, valueKrw: 5_000_000 },
      { symbol: "ETH", qty: 1, price: 1_000_000, valueKrw: 1_000_000 },
    ],
    targets: {
      cashWeight: 0.1,
      picks: [
        { symbol: "BTC", weight: 0.3, stopLossPct: 5, takeProfitPct: 10 },
        { symbol: "ETH", weight: 0.11, stopLossPct: 5, takeProfitPct: 10 },
        { symbol: "SOL", weight: 0.49, stopLossPct: 5, takeProfitPct: 10 },
      ],
      exits: [{ symbol: "OLD", reason: "악재" }],
    },
    bandPct: 2,
    feeBufferPct: 0.5,
  });
  const by = (s: string) => orders.find((o) => o.symbol === s);
  assert.equal(by("OLD")?.side, "sell");
  assert.equal(by("OLD")?.qty, 10);
  assert.equal(by("OLD")?.reason, "악재");
  assert.equal(by("BTC")?.side, "sell");
  assert.ok(Math.abs(by("BTC")!.krw - 2_000_000) < 1);
  assert.equal(by("ETH"), undefined, "1%p deviation is inside the 2%p band");
  assert.equal(by("SOL")?.side, "buy");
  assert.ok(by("SOL")!.krw <= (2_000_000 + 4_000_000) * 0.995 + 1);
  assert.equal(orders[0].side, "sell", "sells come first");
});

test("planner scales buys to available cash and never trades unpriced positions", () => {
  const orders = planOrders({
    equityKrw: 1_000_000,
    cashKrw: 100_000,
    positions: [{ symbol: "X", qty: 1, price: null, valueKrw: null }],
    targets: { cashWeight: 0, picks: [{ symbol: "A", weight: 0.5, stopLossPct: 5, takeProfitPct: 5 }, { symbol: "B", weight: 0.5, stopLossPct: 5, takeProfitPct: 5 }], exits: [] },
    bandPct: 2,
    feeBufferPct: 0,
  });
  assert.equal(orders.filter((o) => o.symbol === "X").length, 0);
  assert.ok(orders.reduce((s, o) => s + o.krw, 0) <= 100_000);
});

test("research validation drops unknown symbols, missing sources and normalizes weights", () => {
  const r = validateResearch(
    {
      market_summary: "요약",
      risk_level: "medium",
      cash_weight: 0.5,
      picks: [
        { symbol: "btc", weight: 0.5, confidence: 0.8, horizon_hours: 48, stop_loss_pct: 5, take_profit_pct: 12, thesis: "t", risks: "r", sources: [{ title: "a", url: "https://example.com/a" }] },
        { symbol: "ETH", weight: 0.5, confidence: 0.8, horizon_hours: 48, stop_loss_pct: 5, take_profit_pct: 12, thesis: "t", risks: "r", sources: [] },
        { symbol: "FAKE", weight: 0.5, confidence: 0.8, horizon_hours: 48, stop_loss_pct: 5, take_profit_pct: 12, thesis: "t", risks: "r", sources: [{ title: "a", url: "https://x.io" }] },
        { symbol: "SOL", weight: 0.5, confidence: 2, horizon_hours: 1, stop_loss_pct: 900, take_profit_pct: 0, thesis: "t", risks: "r", sources: [{ title: "a", url: "https://example.com/sol" }] },
      ],
      exits: [{ symbol: "XRP", reason: "악재" }],
    },
    new Set(["BTC", "ETH", "SOL", "XRP"]),
  );
  assert.deepEqual(r.picks.map((p) => p.symbol), ["BTC", "SOL"]);
  assert.deepEqual(r.dropped.map((d) => d.reason), ["검증 가능한 출처 없음", "후보 목록에 없는 종목"]);
  const total = r.cashWeight + r.picks.reduce((s, p) => s + p.weight, 0);
  assert.ok(Math.abs(total - 1) < 1e-9);
  assert.equal(r.picks[1].stopLossPct, 50);
  assert.equal(r.picks[1].takeProfitPct, 1);
  assert.equal(r.picks[1].confidence, 1);
  assert.equal(r.exits[0].symbol, "XRP");
  // weight of dropped picks goes to cash instead of inflating the survivors
  assert.ok(Math.abs(r.picks[0].weight - 0.2) < 1e-9);
  assert.ok(Math.abs(r.cashWeight - 0.6) < 1e-9);
});

test("research validation rejects a response whose picks were all invalid", () => {
  const bad = { symbol: "FAKE", weight: 0.9, confidence: 1, horizon_hours: 1, stop_loss_pct: 5, take_profit_pct: 5, thesis: "", risks: "", sources: [] };
  assert.throws(() => validateResearch({ market_summary: "", risk_level: "low", cash_weight: 0.1, picks: [bad], exits: [] }, new Set(["BTC"])), /모두 검증에서 제외/);
  const cashy = validateResearch({ market_summary: "", risk_level: "low", cash_weight: 0.95, picks: [{ ...bad, weight: 0.05 }], exits: [] }, new Set(["BTC"]));
  assert.equal(cashy.cashWeight, 1);
});

test("planner leaves held coins the AI never evaluated untouched and skips dust exits", () => {
  const orders = planOrders({
    equityKrw: 1_000_000,
    cashKrw: 500_000,
    positions: [
      { symbol: "UNSEEN", qty: 1, price: 300_000, valueKrw: 300_000 },
      { symbol: "SEEN", qty: 1, price: 196_000, valueKrw: 196_000 },
      { symbol: "DUST", qty: 1, price: 4_000, valueKrw: 4_000 },
    ],
    targets: { cashWeight: 1, picks: [], exits: [], universe: ["SEEN", "DUST"] },
    bandPct: 2,
    feeBufferPct: 0,
  });
  assert.deepEqual(orders.map((o) => o.symbol), ["SEEN"]);
});

test("research validation with nothing valid means all cash", () => {
  const r = validateResearch({ market_summary: "", risk_level: "x", cash_weight: 0, picks: [], exits: [] }, new Set());
  assert.equal(r.cashWeight, 1);
  assert.equal(r.riskLevel, "medium");
});

test("stop loss / take profit decisions skip stale prices", () => {
  const base = { name: "", qty: 1, costKrw: 100, avgPrice: 100, price: 90, valueKrw: 90, pnlKrw: -10, stopLossPct: 5, takeProfitPct: 20, openedAt: "" };
  const d = exitDecisions({
    positions: [
      { ...base, symbol: "A", pnlPct: -10, stale: false },
      { ...base, symbol: "B", pnlPct: -10, stale: true },
      { ...base, symbol: "C", pnlPct: 25, stale: false },
      { ...base, symbol: "D", pnlPct: 1, stale: false },
    ],
  });
  assert.deepEqual(d.map((x) => [x.symbol, x.kind]), [["A", "stop_loss"], ["C", "take_profit"]]);
});

test("cost calculation uses cached tokens and web search calls", () => {
  const c = costUsd("gpt-5.6-terra", { inputTokens: 1_000_000, cachedTokens: 500_000, outputTokens: 100_000, webSearches: 10 }, { input: 0, output: 0 });
  assert.ok(Math.abs(c - (0.5 * 2 + 0.5 * 0.2 + 0.1 * 12 + 0.1)) < 1e-9);
  const custom = costUsd("my-model", { inputTokens: 1_000_000, cachedTokens: 0, outputTokens: 1_000_000, webSearches: 0 }, { input: 3, output: 7 });
  assert.equal(custom, 10);
});

test("budget periods use Korean calendar", () => {
  const t = Date.parse("2026-09-16T16:30:00Z"); // 2026-09-17 01:30 KST (Thursday)
  assert.equal(periodStart("day", t), "2026-09-16T15:00:00.000Z");
  assert.equal(periodStart("month", t), "2026-08-31T15:00:00.000Z");
  assert.equal(periodStart("week", t), "2026-09-13T15:00:00.000Z"); // Monday 14th KST
});

test("bithumb +9h timestamps are normalized, normal ones untouched", () => {
  const now = Date.parse("2026-09-17T13:58:00Z");
  assert.equal(normalizeTimestamp(now + 9 * 3_600_000 - 2000, now), now - 2000);
  assert.equal(normalizeTimestamp(now - 5000, now), now - 5000);
  assert.ok(Number.isNaN(normalizeTimestamp(NaN, now)));
});

test("exchange signing helpers", () => {
  assert.equal(queryString({ market: "KRW-BTC", side: "bid", volume: "0.001" }), "market=KRW-BTC&side=bid&volume=0.001");
  const token = signJwt({ a: 1 }, "secret", "HS512");
  const [h, p, s] = token.split(".");
  assert.equal(JSON.parse(Buffer.from(h, "base64url").toString()).alg, "HS512");
  assert.equal(s, createHmac("sha512", "secret").update(`${h}.${p}`).digest("base64url"));
  assert.equal(floorTo(1.23456789123, 1e-8), 1.23456789);
  assert.equal(floorTo(0.129, 0.01), 0.12);
  assert.equal(floorTo(0.57, 1e-8), 0.57);
  assert.equal(floorTo(1.1, 0.1), 1.1);
  assert.equal(createHash("sha512").update("x").digest("hex").length, 128);
});

test("pegged asset detection", () => {
  for (const s of ["USDT", "USDC", "USD1", "JPYC", "PAXG"]) assert.ok(isPegged(s), s);
  for (const s of ["BTC", "SUI", "USUAL"]) assert.ok(!isPegged(s), s);
});

function trend(n: number, step: number) {
  const start = Date.now() - (n + 2) * 3_600_000;
  return Array.from({ length: n }, (_, i) => {
    const close = 100 * (1 + step) ** i * (1 + 0.01 * Math.sin(i));
    return { time: start + i * 3_600_000, open: close, high: close, low: close, close, volume: 10 + (i % 5) };
  });
}

test("indicators and backtest compare on equal capital", () => {
  assert.equal(rsi([1, 1, 1]), 50);
  const cs = trend(199, 0.002);
  const a = analyze(cs);
  assert.ok(a.asOf > cs[cs.length - 1].time, "asOf is the candle close time");
  const bt = backtest(cs, { feePct: 0.05, slippagePct: 0.05, stopLossPct: 5, takeProfitPct: 10 });
  assert.ok(bt.benchmarkPct > 0);
  assert.equal(bt.curve.length, cs.length - 60);
  assert.throws(() => backtest(cs.slice(0, 50), { feePct: 0, slippagePct: 0, stopLossPct: 5, takeProfitPct: 10 }), /이력/);
});
