// Telegram upozornění kolem prodeje bytu po rezervaci. Okamžité upozornění
// na samotnou rezervaci posílá track.js (notifyReservation); tenhle modul
// řeší tři věci, volané z track.js na konci každého sběrného běhu:
//
//   1. sendKnCheckDigest — JEDNA souhrnná zpráva o bytech, kterým nastal
//      kontrolní bod rozvrhu (kdy se v katastru podívat na byt po rezervaci,
//      viz kn-schedule.js). Dřívější pevná připomínka po 21 dnech a pak každé
//      3 týdny chodila u kupce s hypotékou zbytečně dvakrát a u hotovostního
//      pozdě; navíc byla jedna zpráva na byt. Každý kontrolní bod se ohlásí
//      jen jednou (`kn_digest_cp`), takže zpráva nechodí při každém běhu.
//   2. notifyPossibleSales — okamžité upozornění, že rezervovaný byt zmizel
//      ze všech portálů (možný prodej).
//   3. processTelegramActions — přečte kliknutí na tlačítka ze starších
//      připomínek (Telegram `getUpdates`) a vyřídí je. Nové zprávy tlačítka
//      nemají — výsledek kontroly se zapisuje v appce (Katastr).
//
// Pracuje na úrovni SKUPINY (stejná nemovitost napříč portály, viz
// group.js), ne jednotlivého inzerátu — jinak by byt sledovaný na 3
// portálech dostal 3 samostatné zprávy. `callback_data` tlačítek ze starších
// zpráv nese ID inzerátu, přes který appka při zpracování kliknutí najde
// AKTUÁLNÍ skupinu (findGroupForListing) — robustní i kdyby se mezitím složení
// skupiny změnilo (přibyl/zmizel portál).

import { nowIso, updateListingFields } from "./db.js";
import { groupListings, mergedStatus, primaryListing, findGroupForListing, saleVerdict, pickOwnValue, isHidden } from "./group.js";
import { sendTelegramMessage, getTelegramUpdates, answerTelegramCallback, editTelegramMessageReplyMarkup } from "../lib/telegram.js";
import { addressNoticeLines, buildAddressContext, resolveForGroup, knInfoForGroup, describeKn } from "./auto-address.js";
import { assessSale } from "./sale-triage.js";
import { buildSaleTrack } from "./kn-schedule.js";
import { loadKnScans } from "./kn-scan.js";
import { analyzePlombas, plombaHintLine } from "./kn-plomba.js";
import { parseUnitNumber } from "./kn-api.js";

const OFFSET_KEY = "telegram_update_offset";
// Kolik bytů se vypíše v jedné zprávě; zbytek přijde příště (nedoznačený
// kontrolní bod se ohlásí při dalším běhu).
const DIGEST_MAX_ITEMS = 8;

function getOffset(db) {
  const row = db.prepare("SELECT value FROM app_state WHERE key = ?").get(OFFSET_KEY);
  return row ? parseInt(row.value, 10) : undefined;
}

function setOffset(db, offset) {
  db.prepare("INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(OFFSET_KEY, String(offset));
}

function specsText(rep) {
  const specs = [rep.disposition, rep.area_m2 ? `${rep.area_m2} m²` : null].filter(Boolean).join(", ");
  const price = rep.price_czk != null ? `${rep.price_czk.toLocaleString("cs-CZ")} Kč` : "cena na vyžádání";
  return { specs: specs || "byt", price };
}

/**
 * Pošle JEDNU zprávu o bytech, kterým nastal kontrolní bod (viz
 * kn-schedule.js) a které se dají v katastru dohledat — mají přesnou adresu.
 * Spouští ji jen byt, o jehož aktuálním bodu ještě nešla zpráva; ostatní
 * čekající jen doplní počet. Byty bez přesné adresy jdou jen jako počet (bez
 * adresy je v katastru nejde najít). Selhání odeslání (výpadek Telegramu)
 * body neoznačí, zkusí se příští běh.
 */
export async function sendKnCheckDigest(db, log, now = Date.now()) {
  const listings = db.prepare("SELECT * FROM listings").all();
  const groups = groupListings(listings);
  const eventsByListing = new Map();
  for (const e of db.prepare("SELECT listing_id, event_type, occurred_at FROM events WHERE event_type IN ('reserved', 'unreserved')").all()) {
    if (!eventsByListing.has(e.listing_id)) eventsByListing.set(e.listing_id, []);
    eventsByListing.get(e.listing_id).push(e);
  }

  const due = [];
  for (const group of groups) {
    if (isHidden(group.members)) continue; // "tohle mě nezajímá"
    const events = group.members.flatMap((m) => eventsByListing.get(m.id) || []);
    const track = buildSaleTrack(group.members, events, now);
    if (!track?.due) continue;
    due.push({ group, track, exact: pickOwnValue(group.members, "exact_address") });
  }
  const checkable = due.filter((d) => d.exact);
  const fresh = checkable.filter((d) => pickOwnValue(d.group.members, "kn_digest_cp") !== String(d.track.dueAt));
  if (!fresh.length) return;

  const actx = buildAddressContext(db, listings, groups);
  const scans = loadKnScans(db);
  const shown = fresh.slice(0, DIGEST_MAX_ITEMS);
  const lines = [`🏛️ Kontrola v katastru (${fresh.length})`, ""];
  for (const d of shown) {
    const members = d.group.members;
    const rep = primaryListing(members);
    const { specs, price } = specsText(rep);
    const unit = pickOwnValue(members, "unit_number");
    const lv = pickOwnValue(members, "lv_number");
    const kn = knInfoForGroup(actx, d.group, resolveForGroup(actx, d.group));
    lines.push(`• ${specs}${rep.address ? `, ${rep.address}` : ""} — ${price}`);
    lines.push(`  📍 ${[d.exact, unit ? `jednotka ${unit}` : null, lv ? `LV ${lv}` : null].filter(Boolean).join(" · ")}`);
    if (kn) lines.push(`  🏛️ ${describeKn(kn)}`);
    // Co o domě říká API katastru (kn-scan.js) — jen když tam něco je.
    const scan = kn?.building?.isknId ? scans.get(kn.building.isknId) : null;
    const hint = scan ? plombaHintLine(analyzePlombas(scan, { reservedAt: d.track.reservedAt, unitNumber: parseUnitNumber(unit) ?? parseUnitNumber(pickOwnValue(members, "kn_auto_unit")) })) : null;
    if (hint) lines.push(`  ${hint}`);
    lines.push(`  ⏰ ${d.track.reason}${d.track.stage === "price" ? "" : ` (rezervováno ${formatDay(d.track.reservedAt)})`}`);
  }
  const more = fresh.length - shown.length;
  const waiting = checkable.length - fresh.length;
  const noAddress = due.length - checkable.length;
  const tail = [
    more > 0 ? `… a ${more} dalších příště` : null,
    waiting > 0 ? `Z minula čeká dalších ${waiting}.` : null,
    noAddress > 0 ? `Bez přesné adresy (nejdou dohledat): ${noAddress}.` : null,
  ].filter(Boolean);
  if (tail.length) lines.push("", ...tail);
  lines.push("", "Výsledek zapiš v appce (Katastr): vklad podán, nebo cena.");

  try {
    await sendTelegramMessage(lines.join("\n"));
  } catch (err) {
    log(`Telegram souhrn kontrol v katastru selhal: ${err.message}`);
    return; // body zůstanou neoznačené, zkusí se příští běh
  }
  for (const d of shown) {
    for (const m of d.group.members) updateListingFields(db, m.id, { kn_digest_cp: String(d.track.dueAt) });
  }
  log(`Telegram souhrn kontrol v katastru odeslán: ${shown.length} bytů (+${more} příště)`);
}

function formatDay(iso) {
  return new Date(iso).toLocaleDateString("cs-CZ");
}

/**
 * Text upozornění "rezervovaný byt zmizel z nabídky". Inzerát je pryč, takže
 * rady jako "doplň adresu, dokud je online" už neplatí — uživatel potřebuje
 * vědět, jestli má adresu pro katastr, a kdy byt rezervovaný byl.
 */
export function buildPossibleSaleText(db, group, triage) {
  const rep = primaryListing(group.members);
  const { specs, price } = specsText(rep);
  const exact = pickOwnValue(group.members, "exact_address");
  const unit = pickOwnValue(group.members, "unit_number");
  const addressLines =
    exact || unit
      ? addressNoticeLines(db, rep.id)
      : [group.members.some((m) => m.address_unknown) ? "📍 Přesná adresa: neznámá" : "📍 Přesná adresa nebyla zapsaná — v katastru půjde byt hledat jen podle přibližného místa."];
  return [
    `🔎 Zmizel z nabídky po rezervaci — možný prodej: ${specs}${rep.address ? `, ${rep.address}` : ""}`,
    price,
    `Rezervováno od ${formatDay(triage.reservedAt)} → zmizelo ${formatDay(triage.removedAt)}`,
    ...addressLines,
    "",
    "Zkus v katastru dohledat kupní cenu a datum prodeje a zapiš je v appce (Katastr → Zmizelé byty).",
  ].join("\n");
}

/**
 * Pošle upozornění na každý byt, který zmizel z nabídky po rezervaci
 * ("možný prodej" — po rezervaci se inzerát stahuje) a ještě nemá verdikt z
 * katastru. Jednou na zmizení: `possible_sale_notified_at` se píše na všechny
 * členy skupiny (viz migrace v db.js — starší zmizení jsou vyřízená) a maže
 * se, když je byt zase v nabídce, takže další zmizení upozorní znovu.
 * Selhání odeslání marker nezapíše — zkusí se příští běh.
 */
export async function notifyPossibleSales(db, log) {
  const groups = groupListings(db.prepare("SELECT * FROM listings").all());

  for (const group of groups) {
    const members = group.members;
    const status = mergedStatus(members);

    if (status === "active" || status === "reserved") {
      // Zpátky v nabídce — příští zmizení je nová událost.
      if (members.some((m) => m.possible_sale_notified_at)) {
        for (const m of members) updateListingFields(db, m.id, { possible_sale_notified_at: null });
      }
      continue;
    }
    if (status !== "removed" || saleVerdict(members)) continue;
    if (members.every((m) => m.possible_sale_notified_at)) continue;

    const placeholders = members.map(() => "?").join(",");
    const events = db.prepare(`SELECT * FROM events WHERE listing_id IN (${placeholders})`).all(...members.map((m) => m.id));
    const triage = assessSale(members, events);
    if (!triage.wasReserved) continue;

    try {
      await sendTelegramMessage(buildPossibleSaleText(db, group, triage));
    } catch (err) {
      log(`Telegram upozornění na možný prodej selhalo (${members[0].id}): ${err.message}`);
      continue;
    }
    const stamp = nowIso();
    for (const m of members) updateListingFields(db, m.id, { possible_sale_notified_at: stamp });
    log(`Telegram upozornění na možný prodej odesláno: ${members[0].id}`);
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
    // Tlačítko ze starší zprávy: "odložit" = tuhle kontrolu jsem udělal, další
    // přijde podle rozvrhu (viz kn-schedule.js), ne po pevných 3 týdnech.
    for (const m of group.members) updateListingFields(db, m.id, { kn_checked_at: nowIso() });
    confirmation = `⏳ ${label} — odloženo, další kontrola podle rozvrhu.`;
    log(`Telegram: ${listingId} odloženo (kontrola podle rozvrhu).`);
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
