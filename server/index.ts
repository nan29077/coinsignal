import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { api } from "./api.ts";
import { hasAdmin, setupToken } from "./auth.ts";
import { config } from "./config.ts";
import { masterKey } from "./crypto.ts";
import { db } from "./db.ts";
import { ensureAccounts } from "./engine/accounts.ts";
import { approvePlan, rejectPlan } from "./engine/plans.ts";
import { startScheduler } from "./engine/scheduler.ts";
import { startTelegramPolling } from "./notify/telegram.ts";
import { logEvent } from "./settings.ts";

db();
masterKey();
ensureAccounts();
// Plans interrupted by a restart are closed; their orders (if any) are resolved by the order reconciler.
{
  const stuck = db().run("UPDATE plans SET status = 'failed', result = json_object('error', '서버 재시작으로 실행이 중단되었습니다. 주문 기록을 확인하세요.') WHERE status = 'executing'");
  if (stuck.changes) logEvent("warn", `서버 재시작으로 중단된 매매 계획 ${stuck.changes}건을 실패 처리했습니다.`);
  db().run("UPDATE orders SET status = 'unknown' WHERE status = 'submitting' AND account_id LIKE 'live:%'");
  db().run("UPDATE orders SET status = 'failed', error = '서버 재시작으로 중단' WHERE status = 'submitting' AND account_id LIKE 'paper:%'");
}

const app = new Hono();
app.use("*", async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Frame-Options", "DENY");
});
app.route("/api", api);

if (existsSync(config.webDist)) {
  const rel = path.relative(process.cwd(), config.webDist);
  app.use("/assets/*", serveStatic({ root: rel }));
  app.use("/favicon.svg", serveStatic({ root: rel }));
  const indexHtml = readFileSync(path.join(config.webDist, "index.html"), "utf8");
  app.get("*", (c) => c.html(indexHtml));
} else {
  app.get("/", (c) => c.text("웹 화면이 빌드되지 않았습니다. `npm run build` 후 다시 시작하거나 개발 모드(`npm run dev`)에서 http://localhost:5173 으로 접속하세요."));
}

if (!config.disableScheduler) {
  startScheduler();
  startTelegramPolling(async (action, id) => {
    if (action === "approve") return approvePlan(id, "telegram");
    if (action === "reject") return rejectPlan(id, "telegram");
    return "알 수 없는 명령입니다.";
  });
}

serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  logEvent("info", `CoinSignal 서버 시작 http://${config.host === "0.0.0.0" ? "localhost" : config.host}:${info.port}`);
  if (!hasAdmin()) {
    console.log("\n==============================================");
    console.log(" 최초 관리자 설정이 필요합니다.");
    console.log(` 설정 토큰: ${setupToken()}`);
    console.log("==============================================\n");
  }
  if (config.host === "0.0.0.0" && !config.secureCookies) {
    console.warn("[보안] 외부에 공개된 주소로 실행 중입니다. HTTPS(리버스 프록시) 뒤에서 COINSIGNAL_SECURE_COOKIES=true 로 운영하세요.");
  }
});

// On Windows `localhost` usually resolves to the IPv6 loopback first, so also listen on ::1 —
// still loopback only, so this does not expose the app to the network.
if (config.host === "127.0.0.1" || config.host === "localhost") {
  try {
    const v6 = serve({ fetch: app.fetch, hostname: "::1", port: config.port }, () => console.log(`http://localhost:${config.port} (IPv6 루프백) 으로도 접속할 수 있습니다.`));
    v6.on("error", () => undefined);
  } catch {
    /* IPv6 unavailable: the IPv4 address still works */
  }
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    console.log("종료합니다.");
    process.exit(0);
  });
}
