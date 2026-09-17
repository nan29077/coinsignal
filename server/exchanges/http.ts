import { upstream } from "../errors.ts";

export type FetchLike = typeof fetch;
let fetchImpl: FetchLike = (...args) => fetch(...args);

/** Tests can inject a fake fetch. */
export function setFetch(f: FetchLike) {
  fetchImpl = f;
}
export const httpFetch: FetchLike = (...args) => fetchImpl(...args);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Public JSON GET with timeout and one retry on 429/5xx. */
export async function getJson<T = unknown>(url: string, label: string, timeoutMs = 12000): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let res: Response;
    try {
      res = await httpFetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      if (attempt === 0) {
        await sleep(400);
        continue;
      }
      throw upstream(`${label} 연결에 실패했습니다 (${e instanceof Error ? e.name : "network"}).`);
    }
    if ((res.status === 429 || res.status >= 500) && attempt === 0) {
      await sleep(res.status === 429 ? 1100 : 500);
      continue;
    }
    if (!res.ok) throw upstream(`${label} 응답 오류 (${res.status}).`);
    return (await res.json()) as T;
  }
  throw upstream(`${label} 응답이 없습니다.`);
}

/** Run async jobs with limited concurrency and a small gap to respect exchange rate limits. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>, gapMs = 120): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
      if (gapMs) await sleep(gapMs);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
