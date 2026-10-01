// Odesílání notifikací a čtení odpovědí přes Telegram Bot API.
//
// BOT_TOKEN/CHAT_ID se NEČTOU na úrovni modulu (`const X = process.env...`
// hned při importu) — kdyby volající (typicky skript, co si env teprve
// sám načítá přes `process.loadEnvFile()`, viz trh-bytu/track.js) tenhle
// modul importoval staticky NAD tím načtením, ES moduly by ho vyhodnotily
// (včetně čtení `process.env`) dřív, než `.env.local` vůbec existuje v
// `process.env` — import se vždy hoistuje před zbytek těla modulu, bez
// ohledu na pořadí řádků v souboru. Ověřeno naostro (ne teorie): přesně
// tenhle pořádek v track.js tiše posílal "Chybí TELEGRAM_BOT_TOKEN..." i s
// platným `.env.local`. Čtení uvnitř funkcí = vždy aktuální hodnota v
// okamžiku VOLÁNÍ, ne importu.

function getCredentials() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    throw new Error("Chybí TELEGRAM_BOT_TOKEN nebo TELEGRAM_CHAT_ID v env proměnných — zprávu nelze odeslat.");
  }
  return { token, chatId };
}

async function callTelegramApi(method, token, params) {
  const url = `https://api.telegram.org/bot${token}/${method}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.ok) {
    throw new Error(`Telegram API (${method}) selhalo: HTTP ${res.status} ${JSON.stringify(body)}`);
  }
  return body;
}

/**
 * Pošle jednu textovou zprávu danému chatu. Vyhodí chybu při HTTP != ok.
 * `options.replyMarkup` — nepovinná inline klávesnice, viz
 * https://core.telegram.org/bots/api#inlinekeyboardmarkup, např.:
 *   { inline_keyboard: [[{ text: "Ano", callback_data: "sold:123" }]] }
 */
export async function sendTelegramMessage(text, { replyMarkup } = {}) {
  const { token, chatId } = getCredentials();
  const params = { chat_id: chatId, text, disable_web_page_preview: false };
  if (replyMarkup) params.reply_markup = replyMarkup;
  return callTelegramApi("sendMessage", token, params);
}

/**
 * Nové aktualizace od Telegramu (typicky kliknutí na inline tlačítko, viz
 * `callback_query`) od zadaného `offset` dál (= `update_id` poslední UŽ
 * zpracované aktualizace + 1; `undefined` = všechno, co Telegram ještě má ve
 * frontě). Krátký dotaz bez čekání (`timeout: 0`) — hodí se pro naplánovanou
 * úlohu, co běží jednou denně, ne pro dlouho otevřené spojení. Omezeno na
 * `callback_query`, appka jiné typy aktualizací (obyčejné zprávy apod.)
 * nezpracovává.
 */
export async function getTelegramUpdates(offset) {
  const { token } = getCredentials();
  const params = { timeout: 0, allowed_updates: ["callback_query"] };
  if (offset != null) params.offset = offset;
  const body = await callTelegramApi("getUpdates", token, params);
  return body.result || [];
}

/**
 * Potvrdí appce přijaté kliknutí na inline tlačítko — zhasne "načítá se" u
 * uživatele na telefonu. `text` (nepovinný) se mu ukáže jako malá bublina,
 * ideální na "✅ Uloženo", ať appka nemusí posílat novou zprávu jen kvůli
 * potvrzení.
 */
export async function answerTelegramCallback(callbackQueryId, text) {
  const { token } = getCredentials();
  const params = { callback_query_id: callbackQueryId };
  if (text) params.text = text;
  return callTelegramApi("answerCallbackQuery", token, params);
}

/**
 * Nahradí (nebo smaže, když `replyMarkup` je `null`) inline klávesnici u už
 * odeslané zprávy — appka to volá po vyřízení kliknutí, ať stejná tlačítka
 * nejdou zmáčknout podruhé.
 */
export async function editTelegramMessageReplyMarkup(chatId, messageId, replyMarkup) {
  const { token } = getCredentials();
  return callTelegramApi("editMessageReplyMarkup", token, {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: replyMarkup || { inline_keyboard: [] },
  });
}

/** Malá pauza mezi zprávami, ať nenarazíme na Telegram rate limit. */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
