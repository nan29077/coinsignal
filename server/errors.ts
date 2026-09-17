/** Error whose message is safe to show to the admin, with an HTTP status. */
export class AppError extends Error {
  constructor(message: string, public status = 400, public code = "bad_request") {
    super(message);
  }
}

export const unauthorized = (m = "로그인이 필요합니다.") => new AppError(m, 401, "unauthorized");
export const upstream = (m: string) => new AppError(m, 502, "upstream");

export function errorMessage(e: unknown, fallback = "요청을 처리하지 못했습니다.") {
  if (e instanceof AppError) return e.message;
  if (e instanceof Error && e.name === "TimeoutError") return "외부 서버 응답 시간이 초과되었습니다.";
  return fallback;
}

export function logError(scope: string, e: unknown) {
  const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  console.error(`[${new Date().toISOString()}] [${scope}] ${detail}`);
}
