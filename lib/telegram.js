// Odesílání notifikací přes Telegram Bot API.

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

/** Pošle jednu textovou zprávu danému chatu. Vyhodí chybu při HTTP != ok. */
export async function sendTelegramMessage(text) {
  if (!BOT_TOKEN || !CHAT_ID) {
    throw new Error(
      "Chybí TELEGRAM_BOT_TOKEN nebo TELEGRAM_CHAT_ID v env proměnných — zprávu nelze odeslat."
    );
  }
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text,
      disable_web_page_preview: false,
    }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.ok) {
    throw new Error(
      `Telegram API selhalo: HTTP ${res.status} ${JSON.stringify(body)}`
    );
  }
  return body;
}

/** Malá pauza mezi zprávami, ať nenarazíme na Telegram rate limit. */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
