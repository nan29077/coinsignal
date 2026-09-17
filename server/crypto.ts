import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { config } from "./config.ts";

let cachedKey: Buffer | null = null;

/** 32-byte master key used to encrypt API secrets at rest. */
export function masterKey(): Buffer {
  if (cachedKey) return cachedKey;
  let raw = config.masterKey;
  if (!raw) {
    if (!existsSync(config.masterKeyFile)) {
      writeFileSync(config.masterKeyFile, randomBytes(32).toString("base64"), { mode: 0o600 });
      console.warn(`[security] 새 암호화 키를 생성했습니다: ${config.masterKeyFile} (백업 필수, 분실 시 저장된 API 키 복구 불가)`);
    }
    raw = readFileSync(config.masterKeyFile, "utf8").trim();
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("COINSIGNAL_MASTER_KEY 는 base64 인코딩된 32바이트여야 합니다.");
  cachedKey = key;
  return key;
}

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey(), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), data.toString("base64")].join(":");
}

export function decrypt(payload: string): string {
  const [v, iv, tag, data] = payload.split(":");
  if (v !== "v1") throw new Error("지원하지 않는 암호화 형식입니다.");
  const decipher = createDecipheriv("aes-256-gcm", masterKey(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt:${salt.toString("base64")}:${hash.toString("base64")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [alg, salt, hash] = stored.split(":");
  if (alg !== "scrypt") return false;
  const expected = Buffer.from(hash, "base64");
  const actual = scryptSync(password, Buffer.from(salt, "base64"), expected.length, { N: 16384, r: 8, p: 1 });
  return timingSafeEqual(expected, actual);
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");

/** Show only the last 4 characters of a secret. */
export const maskSecret = (s: string) => (s.length <= 4 ? "••••" : `••••${s.slice(-4)}`);
