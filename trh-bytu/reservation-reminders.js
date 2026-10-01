// Opakované Telegram připomínky "pořád rezervováno, zkontroloval jsi
// katastr?" — navazuje na okamžité upozornění při rezervaci (viz track.js
// notifyReservation). Tenhle modul řeší tři věci, volané z track.js na
// konci každého sběrného běhu:
//
//   1. scheduleFollowup — naplánuje DALŠÍ připomínku (voláno hned po
//      okamžitém upozornění na novou rezervaci).
//   2. sendDueFollowups — pošle připomínky, kterým uplynula lhůta, s
//      inline tlačítky "Prodáno" / "Odložit o 3 týdny", a rovnou naplánuje
//      další kolo — kdyby uživatel na tlačítko nikdy neklikl, appka se
//      sama "uzdraví" a zeptá se znovu za další 3 týdny, místo aby
//      navždy mlčela.
//   3. processTelegramActions — přečte kliknutí na tlačítka (Telegram
//      `getUpdates`) a vyřídí je: "Prodáno" připomínky ukončí, "Odložit"
//      je posune o 3 týdny od OKAMŽIKU KLIKNUTÍ (ne od předchozí lhůty).
//
// Pracuje na úrovni SKUPINY (stejná nemovitost napříč portály, viz
// group.js), ne jednotlivého inzerátu — jinak by byt sledovaný na 3
// portálech dostal 3 samostatné připomínky se 3 sadami tlačítek, a
// kliknutí na jednu by zbylé dvě nechalo viset. `callback_data` tlačítek
// nese ID inzerátu, přes který appka při zpracování kliknutí najde AKTUÁLNÍ
// skupinu (findGroupForListing) — robustní i kdyby se mezitím složení
// skupiny změnilo (přibyl/zmizel portál).

import { nowIso, updateListingFields } from "./db.js";
import { groupListings, mergedStatus, primaryListing, findGroupForListing } from "./group.js";
import { sendTelegramMessage, getTelegramUpdates, answerTelegramCallback, editTelegramMessageReplyMarkup } from "../lib/telegram.js";

const FOLLOWUP_INTERVAL_DAYS = 21;
const OFFSET_KEY = "telegram_update_offset";

function addDaysIso(days) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

function getOffset(db) {
  const row = db.prepare("SELECT value FROM app_state WHERE key = ?").get(OFFSET_KEY);
  return row ? parseInt(row.value, 10) : undefined;
}

function setOffset(db, offset) {
  db.prepare("INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(OFFSET_KEY, String(offset));
}

/**
 * Naplánuje první připomínku na +21 dní pro skupinu, do které patří daný
 * inzerát — voláno hned po odeslání okamžitého upozornění na novou
 * rezervaci (viz track.js). Zapisuje na VŠECHNY členy skupiny (stejná
 * úvaha jako u own_condition apod. — ať je vidět bez ohledu na to, kdo je
 * zrovna primaryListing).
 */
export function scheduleFollowup(db, listingId) {
  const allListings = db.prepare("SELECT * FROM listings").all();
  const group = findGroupForListing(allListings, listingId);
  if (!group) return;
  const due = addDaysIso(FOLLOWUP_INTERVAL_DAYS);
  for (const m of group.members) updateListingFields(db, m.id, { reservation_followup_due: due });
}

function specsText(rep) {
  const specs = [rep.disposition, rep.area_m2 ? `${rep.area_m2} m²` : null].filter(Boolean).join(", ");
  const price = rep.price_czk != null ? `${rep.price_czk.toLocaleString("cs-CZ")} Kč` : "cena na vyžádání";
  return { specs: specs || "byt", price };
}

/**
 * Pošle připomínku pro každou REZERVOVANOU skupinu, které uplynula lhůta
 * (`reservation_followup_due`), s inline tlačítky. Hned po odeslání
 * naplánuje další kolo (+21 dní) — tím appka "samo-ozdravuje" i úplné
 * mlčení uživatele (viz hlavička souboru). Selhání odeslání u JEDNÉ skupiny
 * (výpadek Telegramu) lhůtu NEPOSOUVÁ, ať se zkusí znovu příští běh — jen
 * se zaloguje a appka pokračuje dál.
 */
export async function sendDueFollowups(db, log) {
  const allListings = db.prepare("SELECT * FROM listings").all();
  const groups = groupListings(allListings);
  const now = nowIso();

  for (const group of groups) {
    if (mergedStatus(group.members) !== "reserved") continue;
    const rep = primaryListing(group.members);
    if (!rep.reservation_followup_due || rep.reservation_followup_due > now) continue;

    const { specs, price } = specsText(rep);
    const text = `⏰ Pořád rezervováno: ${specs}${rep.address ? `, ${rep.address}` : ""}\n${price}\n${rep.url}\n\nZkontroloval jsi převod v katastru nemovitostí?`;
    const replyMarkup = {
      inline_keyboard: [
        [
          { text: "✅ Prodáno", callback_data: `sold:${rep.id}` },
          { text: "⏳ Odložit o 3 týdny", callback_data: `snooze:${rep.id}` },
        ],
      ],
    };

    try {
      await sendTelegramMessage(text, { replyMarkup });
    } catch (err) {
      log(`Telegram následná připomínka selhala (${rep.id}): ${err.message}`);
      continue; // lhůta se neposouvá, zkusí se znovu příští běh
    }

    const nextDue = addDaysIso(FOLLOWUP_INTERVAL_DAYS);
    for (const m of group.members) updateListingFields(db, m.id, { reservation_followup_due: nextDue });
    log(`Telegram následná připomínka odeslána: ${rep.id} (další za ${FOLLOWUP_INTERVAL_DAYS} dní)`);
  }
}

// `callback_data` má tvar "<akce>:<id inzerátu>" — ID inzerátu SAMO
// obsahuje dvojtečku ("bazos:224446922"), takže `.split(":")` by ho
// rozsekalo na kusy. Dělí se jen na PRVNÍM výskytu.
function parseCallbackData(data) {
  const sepIdx = data.indexOf(":");
  if (sepIdx === -1) return null;
  return { action: data.slice(0, sepIdx), listingId: data.slice(sepIdx + 1) };
}

async function handleCallbackQuery(db, cq, log) {
  const parsed = cq.data ? parseCallbackData(cq.data) : null;
  if (!parsed) return;
  const { action, listingId } = parsed;

  const allListings = db.prepare("SELECT * FROM listings").all();
  const group = findGroupForListing(allListings, listingId);
  if (!group) {
    await answerTelegramCallback(cq.id, "Appka ten byt už nenašla.").catch(() => {});
    return;
  }
  const rep = primaryListing(group.members);
  const { specs } = specsText(rep);
  const label = `${specs}${rep.address ? `, ${rep.address}` : ""}`;

  // `answerTelegramCallback` je jen bublina na pár vteřin, co klidně zmizí
  // dřív, než se na telefon podíváš (appka ji totiž odešle, až se na
  // kliknutí dostane další naplánovaný běh — klidně v noci). Potvrzení
  // proto jde navíc jako OBYČEJNÁ zpráva, co v chatu zůstane.
  let confirmation = null;
  if (action === "sold") {
    const soldAt = nowIso();
    for (const m of group.members) updateListingFields(db, m.id, { reservation_followup_due: null, reservation_sold_at: soldAt });
    confirmation = `✅ ${label} — označeno jako prodáno, další připomínky končí.`;
    log(`Telegram: ${listingId} označeno jako prodáno.`);
  } else if (action === "snooze") {
    const nextDue = addDaysIso(FOLLOWUP_INTERVAL_DAYS);
    for (const m of group.members) updateListingFields(db, m.id, { reservation_followup_due: nextDue });
    confirmation = `⏳ ${label} — odloženo, příští připomínka ${new Date(nextDue).toLocaleDateString("cs-CZ")}.`;
    log(`Telegram: ${listingId} odloženo o 3 týdny.`);
  } else {
    return; // neznámá akce (např. stará verze appky) — nic nedělat
  }

  await answerTelegramCallback(cq.id).catch(() => {});
  await sendTelegramMessage(confirmation).catch((err) => log(`Telegram potvrzovací zpráva selhala (${listingId}): ${err.message}`));
  // Sejmout tlačítka z PŮVODNÍ zprávy, ať appka/uživatel nemůže kliknout
  // podruhé na už vyřízenou připomínku.
  if (cq.message) {
    await editTelegramMessageReplyMarkup(cq.message.chat.id, cq.message.message_id, null).catch(() => {});
  }
}

/**
 * Přečte nová kliknutí na tlačítka od posledního běhu (Telegram `getUpdates`
 * s uloženým offsetem, viz app_state) a vyřídí je. Offset se posouvá i při
 * chybě zpracování JEDNOHO update — appka se nesmí zacyklit na jedné vadné
 * aktualizaci napořád. Výpadek samotného `getUpdates` (síť, neplatný token)
 * celou funkci jen zaloguje a nic nezpracuje — zkusí se znovu příští běh.
 */
export async function processTelegramActions(db, log) {
  let updates;
  try {
    updates = await getTelegramUpdates(getOffset(db));
  } catch (err) {
    log(`Telegram getUpdates selhalo: ${err.message}`);
    return;
  }

  for (const update of updates) {
    if (update.callback_query) {
      try {
        await handleCallbackQuery(db, update.callback_query, log);
      } catch (err) {
        log(`Telegram zpracování kliknutí selhalo (update ${update.update_id}): ${err.message}`);
      }
    }
    setOffset(db, update.update_id + 1);
  }
}
