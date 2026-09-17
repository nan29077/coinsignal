import { AppError, upstream } from "../errors.ts";
import { httpFetch } from "../exchanges/http.ts";
import type { Usage } from "./models.ts";

const API = "https://api.openai.com/v1";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function call(key: string, path: string, init: RequestInit = {}, timeoutMs = 60_000) {
  let res: Response;
  try {
    res = await httpFetch(`${API}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw upstream(`OpenAI 연결 실패 (${e instanceof Error ? e.name : "network"})`);
  }
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    const msg = (data?.error as { message?: string } | undefined)?.message ?? `HTTP ${res.status}`;
    if (res.status === 401) throw new AppError("OpenAI API 키가 유효하지 않습니다.", 400, "openai_auth");
    if (res.status === 429) throw new AppError(`OpenAI 사용 한도 초과: ${msg}`, 429, "openai_quota");
    throw new AppError(`OpenAI 오류: ${msg}`, 502, "openai");
  }
  return data ?? {};
}

/** Validates the key and returns the model ids available to it. */
export async function listModels(key: string): Promise<string[]> {
  const d = await call(key, "/models", {}, 20_000);
  return ((d.data as { id: string }[]) ?? []).map((m) => m.id).sort();
}

export type ResearchResponse = { text: string; usage: Usage; responseId: string; citations: { url: string; title: string }[] };

type OutputItem = { type: string; content?: { type: string; text?: string; annotations?: { type: string; url?: string; title?: string }[] }[] };

function parseResponse(d: Record<string, unknown>): ResearchResponse {
  const output = (d.output as OutputItem[]) ?? [];
  const texts: string[] = [];
  const citations: { url: string; title: string }[] = [];
  for (const item of output) {
    if (item.type !== "message") continue;
    for (const c of item.content ?? []) {
      if (c.type === "output_text" && c.text) texts.push(c.text);
      for (const a of c.annotations ?? []) if (a.type === "url_citation" && a.url) citations.push({ url: a.url, title: a.title ?? a.url });
    }
  }
  const u = (d.usage as Record<string, unknown>) ?? {};
  const usage: Usage = {
    inputTokens: Number(u.input_tokens ?? 0),
    cachedTokens: Number((u.input_tokens_details as Record<string, number> | undefined)?.cached_tokens ?? 0),
    outputTokens: Number(u.output_tokens ?? 0),
    webSearches: output.filter((o) => o.type === "web_search_call").length,
  };
  return { text: texts.join("\n"), usage, responseId: String(d.id ?? ""), citations };
}

/**
 * Runs a research request in background mode and polls until it completes. Web search runs can take
 * several minutes, so we never hold one HTTP request open for the whole duration.
 */
export async function runStructuredResearch(
  key: string,
  req: { model: string; effort: string; instructions: string; input: string; schemaName: string; schema: object; maxOutputTokens: number },
  opts: { onCreated?: (id: string) => void; maxWaitMs?: number } = {},
): Promise<ResearchResponse> {
  const created = await call(key, "/responses", {
    method: "POST",
    body: JSON.stringify({
      model: req.model,
      instructions: req.instructions,
      input: req.input,
      tools: [{ type: "web_search", search_context_size: "medium", user_location: { type: "approximate", country: "KR", timezone: "Asia/Seoul" } }],
      tool_choice: "auto",
      reasoning: { effort: req.effort },
      text: { format: { type: "json_schema", name: req.schemaName, strict: true, schema: req.schema } },
      max_output_tokens: req.maxOutputTokens,
      background: true,
      store: true,
    }),
  });
  const id = String(created.id ?? "");
  if (!id) throw upstream("OpenAI 응답 ID를 받지 못했습니다.");
  opts.onCreated?.(id);
  const deadline = Date.now() + (opts.maxWaitMs ?? 20 * 60_000);
  let d = created;
  let delay = 3000;
  while (d.status === "queued" || d.status === "in_progress") {
    if (Date.now() > deadline) {
      await call(key, `/responses/${id}/cancel`, { method: "POST" }).catch(() => undefined);
      throw upstream("AI 리서치 시간이 초과되어 취소했습니다.");
    }
    await sleep(delay);
    delay = Math.min(delay * 1.5, 15_000);
    d = await call(key, `/responses/${id}`, { method: "GET" });
  }
  const parsed = parseResponse(d);
  if (d.status !== "completed") {
    const reason = (d.incomplete_details as { reason?: string } | undefined)?.reason ?? (d.error as { message?: string } | undefined)?.message ?? String(d.status);
    const err = new AppError(`AI 리서치가 완료되지 않았습니다: ${reason}`, 502, "openai_incomplete");
    (err as AppError & { usage?: Usage }).usage = parsed.usage;
    throw err;
  }
  if (!parsed.text) throw upstream("AI 리서치 결과가 비어 있습니다.");
  return parsed;
}
