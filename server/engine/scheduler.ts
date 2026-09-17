import { db } from "../db.ts";
import { errorMessage, logError } from "../errors.ts";
import { isResearchRunning, runResearch } from "../ai/research.ts";
import { sendTelegram } from "../notify/telegram.ts";
import { getKv, getSecret, getSetting, logEvent, setKv, type Exchange } from "../settings.ts";
import { listAccounts } from "./accounts.ts";
import { createPlansForResearch, expirePlans } from "./plans.ts";
import { monitorAccount, pruneHistory, recordEquity } from "./risk.ts";

let timers: NodeJS.Timeout[] = [];
let monitorBusy = false;

async function monitorTick() {
  if (monitorBusy) return;
  monitorBusy = true;
  try {
    expirePlans();
    for (const a of listAccounts().filter((x) => x.enabled)) {
      try {
        const s = await monitorAccount(a);
        if (s && Date.now() % 300_000 < 65_000) recordEquity(s);
      } catch (e) {
        logError(`monitor:${a.id}`, e);
      }
    }
  } finally {
    monitorBusy = false;
  }
}

export function researchDue(e: Exchange, now = Date.now()) {
  const ai = getSetting("ai");
  const last = db().get<{ started_at: string }>("SELECT started_at FROM research_runs WHERE exchange = ? AND trigger = 'schedule' AND status != 'skipped' ORDER BY started_at DESC LIMIT 1", e);
  return !last || now - Date.parse(last.started_at) >= ai.intervalHours * 3_600_000 - 30_000;
}

async function researchTick() {
  const ai = getSetting("ai");
  if (!ai.scheduleEnabled || getSetting("global").killSwitch || !getSecret("openai_api_key")) return;
  const active = new Set(listAccounts().filter((a) => a.enabled && !a.halted).map((a) => a.exchange));
  for (const e of ai.exchanges) {
    if (!active.has(e) || isResearchRunning(e) || !researchDue(e)) continue;
    try {
      await runResearch(e, "schedule", createPlansForResearch);
      setKv(`research_block:${e}`, "");
    } catch (err) {
      const msg = errorMessage(err, err instanceof Error ? err.message : "");
      // Budget exhaustion: notify at most once per period instead of every tick.
      const key = `research_block:${e}`;
      if (getKv(key) !== msg.slice(0, 40)) {
        setKv(key, msg.slice(0, 40));
        logEvent("warn", `예약 리서치 건너뜀 (${e}): ${msg}`);
        void sendTelegram(`⚠️ 예약 AI 리서치를 건너뛰었습니다 (${e}): ${msg}`, undefined, { kind: "research" });
      }
    }
  }
}

export function startScheduler() {
  const safe = (fn: () => Promise<void> | void, name: string) => () => {
    Promise.resolve()
      .then(fn)
      .catch((e) => logError(name, e));
  };
  timers.push(setInterval(safe(monitorTick, "monitor"), 60_000));
  timers.push(setInterval(safe(researchTick, "research"), 60_000));
  timers.push(setInterval(safe(pruneHistory, "prune"), 6 * 3_600_000));
  setTimeout(safe(monitorTick, "monitor"), 5_000);
  setTimeout(safe(pruneHistory, "prune"), 30_000);
}

export function stopScheduler() {
  timers.forEach(clearInterval);
  timers = [];
}
