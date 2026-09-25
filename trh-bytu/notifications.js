// Upozornění (zvoneček v appce): "byt byl rezervován". Vznikají z událostí
// `reserved` v `events` — nic se neukládá navíc, kromě jediného údaje, kdy
// uživatel upozornění naposledy přečetl (tabulka app_state). Nepřečtené =
// rezervace zaznamenané po tomhle okamžiku.
//
// Jedno upozornění = jeden BYT (skupina napříč portály), ne jeden inzerát,
// a vzniká, když byt PŘEJDE z "nerezervovaný" na "rezervovaný":
//  - byt rezervovaný na třech portálech zaznamená při jednom sběru tři
//    události `reserved`, ale uživatel má dostat jedno upozornění (události
//    do 10 minut od sebe = jeden sběrný běh se slučují);
//  - když už byt na jednom portálu rezervovaný byl a rezervaci začne ukazovat
//    další portál, není to nová informace (portály ji ukazují s různým
//    zpožděním) — nové upozornění by bylo jen šum.

import { groupListings } from "./group.js";
import { nowIso } from "./db.js";

const CLUSTER_WINDOW_MS = 10 * 60 * 1000;
const SEEN_KEY = "notifications_seen_at";

// Události, které mění to, jestli je inzerát rezervovaný.
const STATE_EVENTS = ["reserved", "unreserved", "removed", "relisted", "reactivated"];

/** Všechna upozornění na rezervace, nejnovější první: `{ group, occurredAt, sources }`. */
export function reservationNotifications(db) {
  const groups = groupListings(db.prepare("SELECT * FROM listings").all());
  const eventsByListing = new Map();
  const placeholders = STATE_EVENTS.map(() => "?").join(",");
  for (const e of db.prepare(`SELECT listing_id, event_type, occurred_at FROM events WHERE event_type IN (${placeholders})`).all(...STATE_EVENTS)) {
    if (!eventsByListing.has(e.listing_id)) eventsByListing.set(e.listing_id, []);
    eventsByListing.get(e.listing_id).push(e);
  }

  const notifications = [];
  for (const group of groups) {
    const events = group.members
      .flatMap((m) => (eventsByListing.get(m.id) || []).map((e) => ({ at: e.occurred_at, type: e.event_type, memberId: m.id, source: m.source })))
      .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

    const reservedMembers = new Set();
    let current = null;
    for (const e of events) {
      if (e.type !== "reserved") {
        reservedMembers.delete(e.memberId); // zrušená rezervace, zmizelý/znovu vložený/znovu aktivní inzerát
        continue;
      }
      const alreadyReserved = reservedMembers.size > 0;
      const inCurrentRun = current && new Date(e.at).getTime() - new Date(current.lastAt).getTime() <= CLUSTER_WINDOW_MS;
      if (inCurrentRun) {
        current.sources.add(e.source);
        current.lastAt = e.at;
      } else if (!alreadyReserved) {
        current = { group, occurredAt: e.at, lastAt: e.at, sources: new Set([e.source]) };
        notifications.push(current);
      }
      reservedMembers.add(e.memberId);
    }
  }
  return notifications.sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : a.occurredAt > b.occurredAt ? -1 : 0));
}

/**
 * Okamžik, kdy uživatel naposledy upozornění přečetl. Když ještě nikdy —
 * bere se "teď" (a uloží se), takže historie před prvním otevřením appky
 * s touhle funkcí se nepočítá jako nepřečtená.
 */
export function getNotificationsSeenAt(db) {
  const row = db.prepare("SELECT value FROM app_state WHERE key = ?").get(SEEN_KEY);
  if (row) return row.value;
  const now = nowIso();
  db.prepare("INSERT INTO app_state (key, value) VALUES (?, ?)").run(SEEN_KEY, now);
  return now;
}

/** Označí všechna dosavadní upozornění jako přečtená. */
export function markNotificationsSeen(db) {
  db.prepare("INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(SEEN_KEY, nowIso());
}

export function countUnread(notifications, seenAt) {
  return notifications.filter((n) => n.occurredAt > seenAt).length;
}
