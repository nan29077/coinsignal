import { randomUUID } from "node:crypto";
import { db, nowIso } from "../db.ts";
import { AppError, errorMessage } from "../errors.ts";
import { screen, type Candidate } from "../market/screen.ts";
import { EXCHANGE_NAMES, getSecret, getSetting, logEvent, type Exchange } from "../settings.ts";
import { canSpend } from "./budget.ts";
import { costUsd, type Usage } from "./models.ts";
import { runStructuredResearch } from "./openai.ts";

export type Pick = {
  symbol: string;
  weight: number;
  confidence: number;
  horizonHours: number;
  stopLossPct: number;
  takeProfitPct: number;
  thesis: string;
  risks: string;
  sources: { title: string; url: string }[];
};
export type ResearchResult = {
  summary: string;
  riskLevel: "low" | "medium" | "high";
  cashWeight: number;
  picks: Pick[];
  exits: { symbol: string; reason: string }[];
  dropped: { symbol: string; reason: string }[];
  /** symbols the model was allowed to choose from; held coins outside it are left untouched */
  universe: string[];
};

export const RESEARCH_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["market_summary", "risk_level", "cash_weight", "picks", "exits"],
  properties: {
    market_summary: { type: "string", description: "시장 상황과 이번 판단 요약 (한국어, 5문장 이내)" },
    risk_level: { type: "string", enum: ["low", "medium", "high"] },
    cash_weight: { type: "number", description: "원화 현금으로 남길 비중 0~1" },
    picks: {
      type: "array",
      description: "투자할 코인. 개수와 비중은 근거에 따라 직접 결정",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["symbol", "weight", "confidence", "horizon_hours", "stop_loss_pct", "take_profit_pct", "thesis", "risks", "sources"],
        properties: {
          symbol: { type: "string", description: "제공된 후보 목록의 심볼 그대로" },
          weight: { type: "number", description: "총자산 대비 목표 비중 0~1" },
          confidence: { type: "number", description: "0~1" },
          horizon_hours: { type: "integer" },
          stop_loss_pct: { type: "number", description: "진입가 대비 손절 %, 양수" },
          take_profit_pct: { type: "number", description: "진입가 대비 익절 %, 양수" },
          thesis: { type: "string" },
          risks: { type: "string" },
          sources: {
            type: "array",
            items: { type: "object", additionalProperties: false, required: ["title", "url"], properties: { title: { type: "string" }, url: { type: "string" } } },
          },
        },
      },
    },
    exits: {
      type: "array",
      description: "보유 중이지만 정리해야 할 코인",
      items: { type: "object", additionalProperties: false, required: ["symbol", "reason"], properties: { symbol: { type: "string" }, reason: { type: "string" } } },
    },
  },
} as const;

const INSTRUCTIONS = `당신은 한국 원화(KRW) 가상자산 시장을 담당하는 투자 리서치 애널리스트입니다.
목표: 제공된 후보 코인 중 향후 수일 내 위험 대비 기대수익이 가장 좋은 포트폴리오를 구성합니다.
규칙:
1. 반드시 web_search 도구로 최신 정보(최근 7일 우선)를 확인하세요: 프로젝트 뉴스, 거래소 공지(상장·상장폐지·유의종목·입출금 중단), 해킹/보안 사고, 규제, 대형 언락/토큰 발행, 거시 이슈. 보유 종목은 반드시 확인합니다.
2. 제공된 후보 목록의 심볼만 사용하세요. 목록에 없는 코인은 추천하지 마세요.
3. 종목 수와 비중은 근거의 강도에 따라 직접 정합니다. 확신이 약하면 현금 비중을 높이세요. 모든 picks 비중과 cash_weight 합은 1이어야 합니다.
4. 각 pick 에는 실제로 검색해서 확인한 출처 URL을 1개 이상 넣으세요. 출처를 지어내지 마세요. 출처가 없으면 추천하지 마세요.
5. stop_loss_pct / take_profit_pct 는 해당 코인의 변동성을 고려해 정하세요.
6. 가격·지표 수치는 제공된 데이터만 사용하고, 확인되지 않은 사실을 만들어내지 마세요.
7. 모든 설명은 한국어로 간결하게 작성하세요.`;

function candidatePayload(e: Exchange, cands: Candidate[]) {
  return {
    exchange: EXCHANGE_NAMES[e],
    as_of: new Date().toISOString(),
    note: "가격은 원화, change_24h_pct는 1시간봉 기준 24시간 변동률, volume_krw_24h는 24시간 거래대금",
    candidates: cands.map((c) => ({
      symbol: c.symbol,
      name: c.name,
      held: c.held,
      price_krw: c.price,
      change_24h_pct: +c.analysis.change24h.toFixed(2),
      change_7d_pct: c.analysis.change7d === null ? null : +c.analysis.change7d.toFixed(2),
      volume_krw_24h: Math.round(c.volumeKrw),
      rsi14_1h: +c.analysis.rsi.toFixed(1),
      trend: `${c.analysis.last > c.analysis.ma20 ? "price>MA20" : "price<MA20"}, ${c.analysis.ma20 > c.analysis.ma60 ? "MA20>MA60" : "MA20<MA60"}`,
      hourly_volatility_pct: +c.analysis.volatility.toFixed(2),
      technical_score: c.analysis.score,
    })),
  };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : lo));

/** Step 3: strict validation of the model output. Nothing reaches the order engine without this. */
export function validateResearch(raw: unknown, allowed: Set<string>): ResearchResult {
  if (!raw || typeof raw !== "object") throw new AppError("AI 결과 형식이 올바르지 않습니다.", 502);
  const r = raw as Record<string, unknown>;
  const dropped: { symbol: string; reason: string }[] = [];
  const seen = new Set<string>();
  const picks: Pick[] = [];
  let proposedCount = 0;
  let proposedTotal = 0;
  for (const p of Array.isArray(r.picks) ? (r.picks as Record<string, unknown>[]) : []) {
    const symbol = String(p.symbol ?? "").toUpperCase().trim();
    const proposed = Number(p.weight);
    if (proposed > 0 && Number.isFinite(proposed)) {
      proposedCount++;
      proposedTotal += Math.min(proposed, 1);
    }
    if (!allowed.has(symbol)) {
      dropped.push({ symbol, reason: "후보 목록에 없는 종목" });
      continue;
    }
    if (seen.has(symbol)) {
      dropped.push({ symbol, reason: "중복 추천" });
      continue;
    }
    const sources = (Array.isArray(p.sources) ? (p.sources as Record<string, unknown>[]) : [])
      .map((s) => ({ title: String(s.title ?? "").slice(0, 200), url: String(s.url ?? "") }))
      .filter((s) => /^https?:\/\/[^\s]+\.[^\s]+/.test(s.url));
    if (!sources.length) {
      dropped.push({ symbol, reason: "검증 가능한 출처 없음" });
      continue;
    }
    const weight = Number(p.weight);
    if (!(weight >= 0.005)) {
      dropped.push({ symbol, reason: "비중 0" });
      continue;
    }
    seen.add(symbol);
    picks.push({
      symbol,
      weight: Math.min(weight, 1),
      confidence: clamp(Number(p.confidence), 0, 1),
      horizonHours: Math.round(clamp(Number(p.horizon_hours), 1, 24 * 90)),
      stopLossPct: clamp(Number(p.stop_loss_pct), 1, 50),
      takeProfitPct: clamp(Number(p.take_profit_pct), 1, 300),
      thesis: String(p.thesis ?? "").slice(0, 2000),
      risks: String(p.risks ?? "").slice(0, 2000),
      sources: sources.slice(0, 8),
    });
  }
  const proposedCash = clamp(Number(r.cash_weight), 0, 1);
  // A response whose every pick failed validation is treated as broken, not as "go 100% cash",
  // unless the model itself asked for mostly cash. Otherwise one bad response would liquidate everything.
  if (proposedCount > 0 && picks.length === 0 && proposedCash < 0.9) {
    throw new AppError(`AI 추천 ${proposedCount}건이 모두 검증에서 제외되어 이번 결과를 사용하지 않습니다 (${dropped.map((d) => `${d.symbol}: ${d.reason}`).join(", ")}).`, 502);
  }
  // Normalize against everything the model proposed so that the weight of dropped picks goes to cash
  // instead of inflating the remaining picks.
  const total = proposedCash + proposedTotal;
  if (total > 0) for (const p of picks) p.weight = p.weight / total;
  const cash = Math.max(0, 1 - picks.reduce((s, p) => s + p.weight, 0));
  const exits = (Array.isArray(r.exits) ? (r.exits as Record<string, unknown>[]) : [])
    .map((x) => ({ symbol: String(x.symbol ?? "").toUpperCase(), reason: String(x.reason ?? "").slice(0, 500) }))
    .filter((x) => x.symbol && !seen.has(x.symbol));
  const risk = r.risk_level === "low" || r.risk_level === "high" ? r.risk_level : "medium";
  return { summary: String(r.market_summary ?? "").slice(0, 3000), riskLevel: risk, cashWeight: cash, picks, exits, dropped, universe: [...allowed] };
}

const running = new Set<Exchange>();

export function heldSymbols(e: Exchange) {
  return db()
    .all<{ symbol: string }>("SELECT DISTINCT p.symbol FROM positions p JOIN accounts a ON a.id = p.account_id WHERE a.exchange = ? AND p.qty > 0", e)
    .map((r) => r.symbol);
}

/** Full pipeline for one exchange. Returns the run id. */
export async function runResearch(e: Exchange, trigger: "schedule" | "manual", onResult?: (runId: string, e: Exchange, r: ResearchResult) => Promise<void>) {
  if (running.has(e)) throw new AppError(`${EXCHANGE_NAMES[e]} 리서치가 이미 진행 중입니다.`, 409);
  const key = getSecret("openai_api_key");
  if (!key) throw new AppError("OpenAI API 키를 먼저 등록해 주세요.");
  const ai = getSetting("ai");
  const budget = canSpend();
  if (!budget.ok) {
    throw new AppError(
      `AI 예산 한도에 도달했습니다 (사용 $${budget.status.spentUsd.toFixed(2)} / $${budget.status.budgetUsd}, 1회 예상 $${budget.status.estimatePerRunUsd.toFixed(2)}).`,
      402,
      "budget",
    );
  }
  running.add(e);
  const id = randomUUID();
  db().run("INSERT INTO research_runs (id, exchange, trigger, model, status, started_at) VALUES (?, ?, ?, ?, 'running', ?)", id, e, trigger, ai.model, nowIso());
  const finish = (fields: Record<string, string | number | null>) => {
    const keys = Object.keys(fields);
    db().run(`UPDATE research_runs SET ${keys.map((k) => `${k} = ?`).join(", ")}, finished_at = ? WHERE id = ?`, ...keys.map((k) => fields[k]), nowIso(), id);
  };
  const custom = { input: ai.customInputPrice, output: ai.customOutputPrice };
  const usageFields = (u: Usage) => ({
    input_tokens: u.inputTokens,
    cached_tokens: u.cachedTokens,
    output_tokens: u.outputTokens,
    web_searches: u.webSearches,
    cost_usd: costUsd(ai.model, u, custom),
  });

  (async () => {
    try {
      const screened = await screen(e, ai.candidateCount, heldSymbols(e));
      db().run("UPDATE research_runs SET candidates = ? WHERE id = ?", JSON.stringify(screened), id);
      if (!screened.candidates.length) throw new AppError("스크리닝을 통과한 후보가 없습니다.");
      const res = await runStructuredResearch(
        key,
        {
          model: ai.model,
          effort: ai.reasoningEffort,
          instructions: INSTRUCTIONS,
          input: JSON.stringify(candidatePayload(e, screened.candidates)),
          schemaName: "portfolio_research",
          schema: RESEARCH_SCHEMA,
          maxOutputTokens: 60_000,
        },
        { onCreated: (rid) => db().run("UPDATE research_runs SET response_id = ? WHERE id = ?", rid, id) },
      );
      let parsed: unknown;
      try {
        parsed = JSON.parse(res.text);
      } catch {
        throw new AppError("AI 결과 JSON 해석 실패", 502);
      }
      const result = validateResearch(parsed, new Set(screened.candidates.map((c) => c.symbol)));
      finish({ status: "completed", result: JSON.stringify(result), ...usageFields(res.usage) });
      logEvent("info", `${EXCHANGE_NAMES[e]} AI 리서치 완료: ${result.picks.map((p) => `${p.symbol} ${(p.weight * 100).toFixed(0)}%`).join(", ") || "전액 현금"}`);
      if (onResult) await onResult(id, e, result);
    } catch (err) {
      const usage = (err as { usage?: Usage }).usage;
      finish({ status: "failed", error: errorMessage(err, "리서치 실패"), ...(usage ? usageFields(usage) : {}) });
      logEvent("error", `${EXCHANGE_NAMES[e]} AI 리서치 실패: ${errorMessage(err, err instanceof Error ? err.message : "unknown")}`);
    } finally {
      running.delete(e);
    }
  })();
  return id;
}

export function isResearchRunning(e: Exchange) {
  return running.has(e);
}
