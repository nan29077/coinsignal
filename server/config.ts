import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

/** Load simple KEY=VALUE lines from .env without overriding real environment variables. */
function loadDotEnv(file: string) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    const value = m[2].replace(/^["']|["']$/g, "");
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

loadDotEnv(path.resolve(process.cwd(), ".env"));

const dataDir = path.resolve(process.cwd(), process.env.COINSIGNAL_DATA_DIR || "data");
mkdirSync(dataDir, { recursive: true });

export const config = {
  host: process.env.HOST || "127.0.0.1",
  port: Number(process.env.PORT || 8787),
  dataDir,
  dbFile: path.join(dataDir, "coinsignal.db"),
  masterKeyFile: path.join(dataDir, "master.key"),
  /** base64 encoded 32 bytes. When absent a key file is generated inside the data directory. */
  masterKey: process.env.COINSIGNAL_MASTER_KEY || "",
  /** Set to true behind HTTPS (e.g. AWS load balancer) so cookies get the Secure flag. */
  secureCookies: process.env.COINSIGNAL_SECURE_COOKIES === "true",
  webDist: path.resolve(process.cwd(), "web/dist"),
  /** Disable background jobs (used by tests). */
  disableScheduler: process.env.COINSIGNAL_DISABLE_SCHEDULER === "true",
};
