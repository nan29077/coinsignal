import type { Context, MiddlewareHandler } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { config } from "./config.ts";
import { hashPassword, randomToken, sha256, verifyPassword } from "./crypto.ts";
import { db, nowIso } from "./db.ts";
import { AppError, unauthorized } from "./errors.ts";
import { getKv, setKv } from "./settings.ts";

const COOKIE = "cs_session";
const SESSION_MS = 7 * 86_400_000;

export const hasAdmin = () => !!db().get("SELECT 1 FROM admin WHERE id = 1");

/** One-time token printed to the server console; required to create the admin on first start. */
export function setupToken(): string {
  let t = getKv("setup_token");
  if (!t) {
    t = randomToken(12);
    setKv("setup_token", t);
  }
  return t;
}

function validatePassword(pw: unknown): string {
  if (typeof pw !== "string" || pw.length < 10 || pw.length > 200) throw new AppError("비밀번호는 10자 이상으로 입력해 주세요.");
  return pw;
}

export function createAdmin(password: unknown, token: unknown) {
  if (hasAdmin()) throw new AppError("관리자가 이미 설정되었습니다.", 409);
  if (typeof token !== "string" || token !== setupToken()) throw new AppError("설정 토큰이 올바르지 않습니다. 서버 콘솔에 표시된 토큰을 입력해 주세요.", 403);
  db().run("INSERT INTO admin (id, password_hash, created_at) VALUES (1, ?, ?)", hashPassword(validatePassword(password)), nowIso());
  setKv("setup_token", "");
}

export function changePassword(current: unknown, next: unknown) {
  const row = db().get<{ password_hash: string }>("SELECT password_hash FROM admin WHERE id = 1");
  if (!row || typeof current !== "string" || !verifyPassword(current, row.password_hash)) throw new AppError("현재 비밀번호가 올바르지 않습니다.", 403);
  db().run("UPDATE admin SET password_hash = ? WHERE id = 1", hashPassword(validatePassword(next)));
  db().run("DELETE FROM sessions");
}

// In-memory brute-force protection: per client IP and globally (defends against rotating IPs).
const failures = new Map<string, { count: number; until: number }>();
let globalFailures: number[] = [];

function clientIp(c: Context) {
  // Only trust X-Forwarded-For when explicitly running behind a reverse proxy.
  if (process.env.COINSIGNAL_TRUST_PROXY === "true") {
    const fwd = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
    if (fwd) return fwd;
  }
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
}

export function login(c: Context, password: unknown) {
  const ip = clientIp(c);
  const now = Date.now();
  globalFailures = globalFailures.filter((t) => now - t < 10 * 60_000);
  const f = failures.get(ip);
  if ((f && f.until > now) || globalFailures.length >= 30) throw new AppError("로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.", 429);
  const row = db().get<{ password_hash: string }>("SELECT password_hash FROM admin WHERE id = 1");
  if (!row || typeof password !== "string" || !verifyPassword(password, row.password_hash)) {
    const count = (f?.count ?? 0) + 1;
    if (failures.size > 1000) failures.clear();
    failures.set(ip, { count, until: count >= 5 ? now + 5 * 60_000 : 0 });
    globalFailures.push(now);
    throw new AppError("비밀번호가 올바르지 않습니다.", 401);
  }
  failures.delete(ip);
  const token = randomToken();
  db().run("INSERT INTO sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)", sha256(token), Date.now(), Date.now() + SESSION_MS);
  setCookie(c, COOKIE, token, { httpOnly: true, sameSite: "Strict", secure: config.secureCookies, path: "/", maxAge: SESSION_MS / 1000 });
}

export function logout(c: Context) {
  const token = getCookie(c, COOKIE);
  if (token) db().run("DELETE FROM sessions WHERE token_hash = ?", sha256(token));
  deleteCookie(c, COOKIE, { path: "/" });
}

export function isAuthenticated(c: Context) {
  const token = getCookie(c, COOKIE);
  if (!token) return false;
  const row = db().get<{ expires_at: number }>("SELECT expires_at FROM sessions WHERE token_hash = ?", sha256(token));
  return !!row && row.expires_at > Date.now();
}

/** Requires a session; for state-changing requests also rejects cross-origin callers. */
export const requireAuth: MiddlewareHandler = async (c, next) => {
  if (!isAuthenticated(c)) throw unauthorized();
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    // State-changing requests must prove they come from this site's own pages.
    const source = c.req.header("origin") ?? c.req.header("referer");
    const host = (process.env.COINSIGNAL_TRUST_PROXY === "true" ? c.req.header("x-forwarded-host") : undefined) ?? c.req.header("host");
    let ok = false;
    try {
      ok = !!source && !!host && new URL(source).host === host;
    } catch {
      ok = false;
    }
    if (!ok) throw new AppError("허용되지 않은 요청 출처입니다.", 403);
  }
  await next();
};
