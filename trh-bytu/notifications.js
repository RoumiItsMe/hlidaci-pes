// Upozornění (zvoneček v appce): rezervace, změny cen a nové nabídky.
// Vznikají z historie událostí bytů (`events`) — nic se neukládá navíc,
// kromě dvou údajů v tabulce app_state: kdy uživatel upozornění naposledy
// přečetl a odkdy se sledují nové nabídky. Nepřečtené = upozornění
// zaznamenaná po okamžiku posledního přečtení.
//
// Jedno upozornění = jeden BYT (skupina napříč portály), ne jeden inzerát,
// a vždy jen NOVÁ informace:
//  - události téhož druhu u téhož bytu do 10 minut od sebe (= jeden sběrný
//    běh) se slučují — byt rezervovaný na třech portálech je jedno upozornění;
//  - portály ukazují změny s různým zpožděním, takže když další portál
//    "dožene" informaci, kterou už appka hlásila (byt už je rezervovaný;
//    cena už je na téhle hodnotě), nové upozornění nevzniká.
//
// Druhy:
//  - rezervace: byt přešel z "nerezervovaný" na "rezervovaný" (i když je
//    skrytý — rezervace se zobrazuje vždy, viz README);
//  - změna ceny: nová cena bytu (včetně "cena → na vyžádání" u znovu
//    vloženého inzerátu);
//  - nová nabídka: byt, který appka dřív neznala (nejstarší inzerát skupiny
//    je zaevidovaný po zapnutí této funkce — jinak by 100 bytů z prvního
//    sběru bylo "nových").
// Skryté byty nehlásí změny cen ani nové nabídky (uživatel je vyřadil).

import { groupListings, isHidden } from "./group.js";
import { nowIso } from "./db.js";

const CLUSTER_WINDOW_MS = 10 * 60 * 1000;
const SEEN_KEY = "notifications_seen_at";
const NEW_SINCE_KEY = "new_offers_since";

const EVENT_TYPES = ["created", "reserved", "unreserved", "removed", "relisted", "reactivated", "price_change"];

function timeOf(iso) {
  return new Date(iso).getTime();
}

// Přechod nerezervovaný → rezervovaný (viz komentář výš).
function reservedNotifications(group, events) {
  const out = [];
  const reservedMembers = new Set();
  let current = null;
  for (const e of events) {
    if (e.type === "unreserved" || e.type === "removed" || e.type === "relisted" || e.type === "reactivated") {
      reservedMembers.delete(e.memberId); // rezervace zrušena / inzerát zmizel, byl znovu vložen nebo znovu aktivní
      continue;
    }
    if (e.type !== "reserved") continue;
    const inCurrentRun = current && timeOf(e.at) - timeOf(current.lastAt) <= CLUSTER_WINDOW_MS;
    if (inCurrentRun) {
      current.sources.add(e.source);
      current.lastAt = e.at;
    } else if (reservedMembers.size === 0) {
      current = { type: "reserved", group, occurredAt: e.at, lastAt: e.at, sources: new Set([e.source]) };
      out.push(current);
    }
    reservedMembers.add(e.memberId);
  }
  return out;
}

// Nová cena bytu. `newPrice` null = "na vyžádání".
function priceNotifications(group, events) {
  const out = [];
  let current = null;
  let lastReportedPrice; // undefined = zatím nic nehlášeno
  for (const e of events) {
    const isPriceEvent = e.type === "price_change" || (e.type === "relisted" && e.oldPrice !== e.newPrice);
    if (!isPriceEvent) continue;
    if (current && timeOf(e.at) - timeOf(current.lastAt) <= CLUSTER_WINDOW_MS) {
      current.sources.add(e.source);
      current.lastAt = e.at;
      continue;
    }
    if (lastReportedPrice !== undefined && e.newPrice === lastReportedPrice) continue; // jiný portál dohání už hlášenou cenu
    current = {
      type: "price",
      group,
      occurredAt: e.at,
      lastAt: e.at,
      sources: new Set([e.source]),
      detail: { oldPrice: e.oldPrice, newPrice: e.newPrice },
    };
    out.push(current);
    lastReportedPrice = e.newPrice;
  }
  return out;
}

// Nová nabídka: jen když je NEJSTARŠÍ inzerát skupiny zaevidovaný po
// `newSince` — byt, který jiný portál znal dřív, není nový.
function newOfferNotification(group, events, newSince) {
  const created = events.filter((e) => e.type === "created");
  if (!created.length || created[0].at <= newSince) return null;
  const first = created[0];
  const sources = new Set(created.filter((e) => timeOf(e.at) - timeOf(first.at) <= CLUSTER_WINDOW_MS).map((e) => e.source));
  return { type: "new", group, occurredAt: first.at, lastAt: first.at, sources };
}

/**
 * Čistá funkce: ze skupin bytů a jejich událostí (`{ listing_id, event_type,
 * old_price_czk, new_price_czk, occurred_at }`) poskládá upozornění, nejnovější
 * první: `{ type, group, occurredAt, sources, detail? }`.
 */
export function buildNotifications(groups, events, { newSince }) {
  const eventsByListing = new Map();
  for (const e of events) {
    if (!eventsByListing.has(e.listing_id)) eventsByListing.set(e.listing_id, []);
    eventsByListing.get(e.listing_id).push(e);
  }

  const notifications = [];
  for (const group of groups) {
    const groupEvents = group.members
      .flatMap((m) =>
        (eventsByListing.get(m.id) || []).map((e) => ({
          at: e.occurred_at,
          type: e.event_type,
          memberId: m.id,
          source: m.source,
          oldPrice: e.old_price_czk ?? null,
          newPrice: e.new_price_czk ?? null,
        }))
      )
      .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

    notifications.push(...reservedNotifications(group, groupEvents));
    if (isHidden(group.members)) continue;
    notifications.push(...priceNotifications(group, groupEvents));
    const newOffer = newOfferNotification(group, groupEvents, newSince);
    if (newOffer) notifications.push(newOffer);
  }
  return notifications.sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : a.occurredAt > b.occurredAt ? -1 : 0));
}

/** Všechna upozornění z databáze (viz buildNotifications). */
export function getNotifications(db) {
  const groups = groupListings(db.prepare("SELECT * FROM listings").all());
  const placeholders = EVENT_TYPES.map(() => "?").join(",");
  const events = db
    .prepare(`SELECT listing_id, event_type, old_price_czk, new_price_czk, occurred_at FROM events WHERE event_type IN (${placeholders})`)
    .all(...EVENT_TYPES);
  return buildNotifications(groups, events, { newSince: getStateTimestamp(db, NEW_SINCE_KEY) });
}

// Časový údaj z app_state; když ještě není, uloží se "teď" — historie před
// prvním použitím se tak nepočítá jako nepřečtená ani jako nová.
function getStateTimestamp(db, key) {
  const row = db.prepare("SELECT value FROM app_state WHERE key = ?").get(key);
  if (row) return row.value;
  const now = nowIso();
  db.prepare("INSERT INTO app_state (key, value) VALUES (?, ?)").run(key, now);
  return now;
}

/** Okamžik, kdy uživatel naposledy upozornění přečetl. */
export function getNotificationsSeenAt(db) {
  return getStateTimestamp(db, SEEN_KEY);
}

/** Označí všechna dosavadní upozornění jako přečtená. */
export function markNotificationsSeen(db) {
  db.prepare("INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(SEEN_KEY, nowIso());
}

export function countUnread(notifications, seenAt) {
  return notifications.filter((n) => n.occurredAt > seenAt).length;
}
