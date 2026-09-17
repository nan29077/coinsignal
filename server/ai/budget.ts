import { db } from "../db.ts";
import { getSetting } from "../settings.ts";
import { defaultEstimateUsd } from "./models.ts";

const KST_OFFSET = 9 * 3_600_000;

/** Start (UTC ISO) of the current budget period, using Korean calendar boundaries. Weeks start Monday. */
export function periodStart(period: "day" | "week" | "month", now = Date.now()): string {
  const k = new Date(now + KST_OFFSET);
  let y = k.getUTCFullYear();
  let m = k.getUTCMonth();
  let d = k.getUTCDate();
  if (period === "month") d = 1;
  if (period === "week") {
    const dow = (k.getUTCDay() + 6) % 7; // Monday = 0
    const monday = new Date(Date.UTC(y, m, d) - dow * 86_400_000);
    y = monday.getUTCFullYear();
    m = monday.getUTCMonth();
    d = monday.getUTCDate();
  }
  return new Date(Date.UTC(y, m, d) - KST_OFFSET).toISOString();
}

export function budgetStatus() {
  const ai = getSetting("ai");
  const since = periodStart(ai.budgetPeriod);
  const spent = db().get<{ s: number | null }>("SELECT SUM(cost_usd) s FROM research_runs WHERE started_at >= ?", since)?.s ?? 0;
  const recent = db().all<{ cost_usd: number }>(
    "SELECT cost_usd FROM research_runs WHERE model = ? AND status = 'completed' ORDER BY started_at DESC LIMIT 5",
    ai.model,
  );
  const estimate = recent.length
    ? Math.max(...recent.map((r) => r.cost_usd)) * 1.2
    : defaultEstimateUsd(ai.model, ai.candidateCount, { input: ai.customInputPrice, output: ai.customOutputPrice });
  const runsPerPeriod = { day: 24, week: 168, month: 24 * 30 }[ai.budgetPeriod] / ai.intervalHours;
  return {
    period: ai.budgetPeriod,
    since,
    budgetUsd: ai.budgetUsd,
    spentUsd: spent,
    remainingUsd: Math.max(0, ai.budgetUsd - spent),
    estimatePerRunUsd: estimate,
    projectedPerPeriodUsd: estimate * runsPerPeriod * Math.max(1, ai.exchanges.length),
  };
}

/** True if another run of the estimated size still fits the budget. */
export function canSpend(multiplier = 1) {
  const s = budgetStatus();
  return { ok: s.spentUsd + s.estimatePerRunUsd * multiplier <= s.budgetUsd, status: s };
}
