import { z } from "zod";
import { db, nowIso } from "./db.ts";
import { decrypt, encrypt, maskSecret } from "./crypto.ts";
import { AppError } from "./errors.ts";

export const EXCHANGES = ["upbit", "bithumb", "coinone"] as const;
export type Exchange = (typeof EXCHANGES)[number];
export const EXCHANGE_NAMES: Record<Exchange, string> = { upbit: "업비트", bithumb: "빗썸", coinone: "코인원" };

export const aiSettingsSchema = z.object({
  model: z.string().min(1).max(80).regex(/^[a-zA-Z0-9._:-]+$/),
  reasoningEffort: z.enum(["low", "medium", "high", "xhigh"]),
  /** research cadence */
  intervalHours: z.number().min(0.5).max(168),
  budgetUsd: z.number().min(0).max(100000),
  budgetPeriod: z.enum(["day", "week", "month"]),
  /** scheduled research on/off (manual runs still allowed) */
  scheduleEnabled: z.boolean(),
  /** how many screened coins are sent to the model */
  candidateCount: z.number().int().min(5).max(40),
  /** research is performed for exchanges that have at least one enabled account, filtered by this list */
  exchanges: z.array(z.enum(EXCHANGES)).min(1),
  /** custom price per 1M tokens when the model is not in the catalog */
  customInputPrice: z.number().min(0).max(1000),
  customOutputPrice: z.number().min(0).max(1000),
  /** minutes a plan waits for approval before it expires */
  approvalTimeoutMinutes: z.number().int().min(5).max(24 * 60),
});
export type AiSettings = z.infer<typeof aiSettingsSchema>;

export const telegramSettingsSchema = z.object({
  enabled: z.boolean(),
  chatId: z.string().max(40).regex(/^-?\d*$/),
  notifyTrades: z.boolean(),
  notifyResearch: z.boolean(),
});
export type TelegramSettings = z.infer<typeof telegramSettingsSchema>;

type Defaults = { ai: AiSettings; telegram: TelegramSettings; global: { killSwitch: boolean } };

const DEFAULTS: Defaults = {
  ai: {
    model: "gpt-5.6-terra",
    reasoningEffort: "medium",
    intervalHours: 4,
    budgetUsd: 50,
    budgetPeriod: "month",
    scheduleEnabled: false,
    candidateCount: 20,
    exchanges: ["upbit", "bithumb", "coinone"],
    customInputPrice: 0,
    customOutputPrice: 0,
    approvalTimeoutMinutes: 30,
  },
  telegram: { enabled: false, chatId: "", notifyTrades: true, notifyResearch: true },
  global: { killSwitch: false },
};

type SettingKey = keyof Defaults;
type SettingValue<K extends SettingKey> = Defaults[K];

export function getSetting<K extends SettingKey>(key: K): SettingValue<K> {
  const row = db().get<{ value: string }>("SELECT value FROM settings WHERE key = ?", key);
  if (!row) return structuredClone(DEFAULTS[key]);
  return { ...structuredClone(DEFAULTS[key]), ...JSON.parse(row.value) };
}

export function setSetting<K extends SettingKey>(key: K, value: SettingValue<K>) {
  db().run(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    key,
    JSON.stringify(value),
  );
}

export function getKv(key: string): string | null {
  return db().get<{ value: string }>("SELECT value FROM settings WHERE key = ?", `kv:${key}`)?.value ?? null;
}
export function setKv(key: string, value: string) {
  db().run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", `kv:${key}`, value);
}

// ---------- secrets ----------
export const SECRET_NAMES = [
  "openai_api_key",
  "telegram_bot_token",
  "upbit_access_key",
  "upbit_secret_key",
  "bithumb_access_key",
  "bithumb_secret_key",
  "coinone_access_token",
  "coinone_secret_key",
] as const;
export type SecretName = (typeof SECRET_NAMES)[number];

export function setSecret(name: SecretName, value: string) {
  const v = value.trim();
  if (v.length < 8 || v.length > 400 || /\s/.test(v)) throw new AppError("키 형식이 올바르지 않습니다.");
  db().run(
    "INSERT INTO secrets (name, ciphertext, hint, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET ciphertext = excluded.ciphertext, hint = excluded.hint, updated_at = excluded.updated_at",
    name,
    encrypt(v),
    maskSecret(v),
    nowIso(),
  );
}

export function getSecret(name: SecretName): string | null {
  const row = db().get<{ ciphertext: string }>("SELECT ciphertext FROM secrets WHERE name = ?", name);
  if (!row) return null;
  try {
    return decrypt(row.ciphertext);
  } catch {
    throw new AppError("저장된 키를 복호화할 수 없습니다. 암호화 키(master.key)가 바뀌었는지 확인하고 키를 다시 입력해 주세요.", 500);
  }
}

export function deleteSecret(name: SecretName) {
  db().run("DELETE FROM secrets WHERE name = ?", name);
}

export function secretHints(): Record<string, { hint: string; updatedAt: string } | null> {
  const rows = db().all<{ name: string; hint: string; updated_at: string }>("SELECT name, hint, updated_at FROM secrets");
  const out: Record<string, { hint: string; updatedAt: string } | null> = {};
  for (const n of SECRET_NAMES) {
    const r = rows.find((x) => x.name === n);
    out[n] = r ? { hint: r.hint, updatedAt: r.updated_at } : null;
  }
  return out;
}

export function exchangeCredentials(exchange: Exchange): { key: string; secret: string } | null {
  const [k, s] =
    exchange === "coinone"
      ? [getSecret("coinone_access_token"), getSecret("coinone_secret_key")]
      : [getSecret(`${exchange}_access_key`), getSecret(`${exchange}_secret_key`)];
  return k && s ? { key: k, secret: s } : null;
}

// ---------- event log ----------
export function logEvent(level: "info" | "warn" | "error" | "trade", message: string, accountId?: string) {
  db().run("INSERT INTO events (ts, level, account_id, message) VALUES (?, ?, ?, ?)", nowIso(), level, accountId ?? null, message);
  const line = `[${new Date().toISOString()}] [${level}]${accountId ? ` [${accountId}]` : ""} ${message}`;
  if (level === "error") console.error(line);
  else console.log(line);
}
