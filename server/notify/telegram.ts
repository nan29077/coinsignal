import { AppError, logError } from "../errors.ts";
import { httpFetch } from "../exchanges/http.ts";
import { getKv, getSecret, getSetting, setKv } from "../settings.ts";

type Button = { text: string; callback_data: string };

async function api(token: string, method: string, body: Record<string, unknown>, timeoutMs = 15_000) {
  const res = await httpFetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const d = (await res.json().catch(() => null)) as { ok: boolean; result?: unknown; description?: string } | null;
  if (!d?.ok) throw new AppError(`텔레그램 오류: ${d?.description ?? res.status}`, 502);
  return d.result;
}

function ready() {
  const s = getSetting("telegram");
  const token = getSecret("telegram_bot_token");
  if (!s.enabled || !token || !s.chatId) return null;
  return { token, chatId: s.chatId, settings: s };
}

const escape = (t: string) => t.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);

export async function sendTelegram(text: string, buttons?: Button[][], opts: { kind?: "trade" | "research" | "system" } = {}): Promise<number | null> {
  const r = ready();
  if (!r) return null;
  if (opts.kind === "trade" && !r.settings.notifyTrades) return null;
  if (opts.kind === "research" && !r.settings.notifyResearch) return null;
  try {
    const msg = (await api(r.token, "sendMessage", {
      chat_id: r.chatId,
      text: escape(text).slice(0, 4000),
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}),
    })) as { message_id: number };
    return msg.message_id;
  } catch (e) {
    logError("telegram", e);
    return null;
  }
}

export async function editTelegram(messageId: number, text: string) {
  const r = ready();
  if (!r) return;
  await api(r.token, "editMessageText", { chat_id: r.chatId, message_id: messageId, text: escape(text).slice(0, 4000), parse_mode: "HTML" }).catch((e) => logError("telegram", e));
}

/** Used from the settings page: the user sends any message to the bot, then we read the chat id. */
export async function detectChatId(token: string): Promise<{ chatId: string; name: string }[]> {
  const updates = (await api(token, "getUpdates", { timeout: 0, allowed_updates: ["message", "callback_query"] })) as { message?: { chat: { id: number; title?: string; username?: string; first_name?: string } } }[];
  const seen = new Map<string, string>();
  for (const u of updates) if (u.message) seen.set(String(u.message.chat.id), u.message.chat.title ?? u.message.chat.username ?? u.message.chat.first_name ?? "");
  return [...seen].map(([chatId, name]) => ({ chatId, name }));
}

export async function testTelegram(token: string, chatId: string) {
  await api(token, "sendMessage", { chat_id: chatId, text: "✅ CoinSignal 알림 연결 테스트" });
}

export type CallbackHandler = (action: string, id: string) => Promise<string>;

let polling = false;
/**
 * Long-polls Telegram for button presses. Works behind NAT (local PC) because no webhook is needed.
 * Only callbacks coming from the configured chat are accepted.
 */
export function startTelegramPolling(onCallback: CallbackHandler) {
  if (polling) return;
  polling = true;
  const loop = async () => {
    while (polling) {
      const r = ready();
      if (!r) {
        await new Promise((res) => setTimeout(res, 15_000));
        continue;
      }
      try {
        const offset = Number(getKv("telegram_offset") ?? 0);
        const updates = (await api(r.token, "getUpdates", { offset, timeout: 25, allowed_updates: ["message", "callback_query"] }, 35_000)) as {
          update_id: number;
          callback_query?: { id: string; data?: string; message?: { chat: { id: number } } };
        }[];
        for (const u of updates) {
          setKv("telegram_offset", String(u.update_id + 1));
          const cb = u.callback_query;
          if (!cb?.data) continue;
          if (String(cb.message?.chat.id) !== r.chatId) {
            await api(r.token, "answerCallbackQuery", { callback_query_id: cb.id, text: "허용되지 않은 채팅입니다." }).catch(() => undefined);
            continue;
          }
          const [action, id] = cb.data.split(":");
          let answer = "처리했습니다.";
          try {
            answer = await onCallback(action, id);
          } catch (e) {
            answer = e instanceof Error ? e.message.slice(0, 180) : "처리 실패";
          }
          await api(r.token, "answerCallbackQuery", { callback_query_id: cb.id, text: answer.slice(0, 190) }).catch(() => undefined);
        }
      } catch (e) {
        logError("telegram-poll", e);
        await new Promise((res) => setTimeout(res, 10_000));
      }
    }
  };
  void loop();
}
export function stopTelegramPolling() {
  polling = false;
}
