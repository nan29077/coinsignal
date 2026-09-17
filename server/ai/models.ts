/** OpenAI models offered in the UI. Prices are USD per 1M tokens (standard tier, Sept 2026). */
export const MODEL_CATALOG = [
  { id: "gpt-6-astra", label: "GPT-6 Astra", tier: "최고 성능", input: 10, cachedInput: 1, output: 50 },
  { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", tier: "고성능", input: 4, cachedInput: 0.4, output: 20 },
  { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", tier: "균형", input: 2, cachedInput: 0.2, output: 12 },
  { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", tier: "저비용", input: 0.2, cachedInput: 0.02, output: 1.2 },
] as const;

/** Web search tool: $10 per 1,000 calls (search content tokens are billed as input tokens). */
export const WEB_SEARCH_USD_PER_CALL = 0.01;

export type Usage = { inputTokens: number; cachedTokens: number; outputTokens: number; webSearches: number };

export function priceFor(model: string, custom: { input: number; output: number }) {
  const m = MODEL_CATALOG.find((x) => x.id === model);
  if (m) return { input: m.input, cachedInput: m.cachedInput, output: m.output };
  return { input: custom.input, cachedInput: custom.input, output: custom.output };
}

export function costUsd(model: string, u: Usage, custom: { input: number; output: number }) {
  const p = priceFor(model, custom);
  const uncached = Math.max(0, u.inputTokens - u.cachedTokens);
  return (uncached * p.input + u.cachedTokens * p.cachedInput + u.outputTokens * p.output) / 1_000_000 + u.webSearches * WEB_SEARCH_USD_PER_CALL;
}

/** Rough pre-run estimate used for the budget guard before we have history for a model. */
export function defaultEstimateUsd(model: string, candidateCount: number, custom: { input: number; output: number }) {
  return costUsd(model, { inputTokens: 15_000 + candidateCount * 3_000, cachedTokens: 0, outputTokens: 12_000, webSearches: Math.min(20, candidateCount) }, custom);
}
