// Změny v katastru jako události (do zvonečku a na přehled). Sken domu
// (kn-api.js) drží jen aktuální stav, takže "co je nového" se zjistí porovnáním
// nového skenu s předchozím a zapíše do tabulky kn_events:
//
//  - filing:  appka přiřadila podaný vklad ke KONKRÉTNÍMU bytu (kn-scan.js,
//             matchFilings) — "Vklad podán v katastru";
//  - plomba:  v domě se objevila nová plomba (řízení typu V), kterou appka k
//             žádnému sledovanému bytu nepřiřadila — pokud je jednotka zapsaná
//             u některého bytu, událost se k němu váže, jinak je to událost domu;
//  - ended:   řízení o vkladu skončilo (plomba zmizela) — u bytu s jednotkou
//             to znamená, že jde zjistit kupní cena.
//
// Čistá logika (diffKnScan) bez DB, aby šla otestovat; DB část je dole.
// První sken domu žádné události "plomba"/"ended" nevyrobí — nemáme s čím
// porovnat, takže by všechno, co v domě bylo vždycky, vypadalo jako novinka.

import { formatUnitNumber } from "./kn-api.js";

const DAY_MS = 24 * 60 * 60 * 1000;
// Datum přijetí návrhu je jen den (bez hodiny) a katastr plombu ukáže se
// zpožděním — plomba podaná těsně před minulým skenem se proto ještě bere jako
// nová, ale ta z doby dávno před ním ne (ta tu byla, jen ji částečný sken
// neviděl, viz scanBuilding).
const NEW_GRACE_DAYS = 2;

export const KN_EVENTS_DDL = `
-- Změny v katastru (viz kn-events.js): vklad podán u bytu, nová plomba v domě,
-- konec řízení. Unikátní ref = jedna událost se nezapíše dvakrát.
CREATE TABLE IF NOT EXISTS kn_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ref TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,            -- filing | plomba | ended
  occurred_at TEXT NOT NULL,
  building_id INTEGER,
  listing_id TEXT,               -- inzerát bytu, ke kterému se událost váže (NULL = událost domu)
  detail_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_kn_events_time ON kn_events(occurred_at);
-- "Není to ten byt": událost domu (bez bytu), kterou uživatel u daného bytu odmítl — byt už se k ní nenabízí.
CREATE TABLE IF NOT EXISTS kn_event_dismissals (
  event_ref TEXT NOT NULL,
  listing_id TEXT NOT NULL,
  dismissed_at TEXT NOT NULL,
  PRIMARY KEY (event_ref, listing_id)
);
`;

/**
 * Události, které vznikly přechodem z `prev` na `scan` (viz hlavička).
 *
 * @param prev    předchozí sken téhož domu, nebo null (první sken)
 * @param scan    nový sken
 * @param entries sledované byty domu: `[{ listingId, unit, address }]` (unit = číslo jednotky z API, nebo null)
 * @param matches vklady přiřazené k bytům tímto skenem: `[{ listingId, filedAt, unit, lv, via, proceedingIds }]`
 * @returns `[{ ref, kind, occurredAt, buildingId, listingId, detail }]`
 */
export function diffKnScan(prev, scan, { entries = [], matches = [] } = {}) {
  const events = [];
  const at = scan.scannedAt;
  const houseAddress = entries.find((e) => e.address)?.address ?? null;
  const entryOfUnit = (unit) => entries.find((e) => e.unit != null && e.unit === unit) ?? null;
  const matched = new Set(matches.flatMap((m) => m.proceedingIds ?? []));

  for (const m of matches) {
    const entry = entries.find((e) => e.listingId === m.listingId);
    events.push({
      ref: `filing:${m.listingId}:${m.filedAt}`,
      kind: "filing",
      occurredAt: at,
      buildingId: scan.buildingId,
      listingId: m.listingId,
      detail: { unit: formatUnitNumber(m.unit), lv: m.lv ?? null, filedAt: m.filedAt, via: m.via, address: entry?.address ?? houseAddress },
    });
  }

  if (!prev) return events;

  const prevClosed = new Set((prev.closed ?? []).map((c) => c.proceeding.id));
  const known = new Set([...(prev.plomby ?? []).flatMap((p) => p.rizeni.map((r) => r.id)), ...prevClosed]);
  const since = Date.parse(prev.scannedAt) - NEW_GRACE_DAYS * DAY_MS;

  for (const p of scan.plomby ?? []) {
    for (const r of p.rizeni) {
      if (r.typ !== "V" || known.has(r.id) || matched.has(r.id)) continue;
      if (!r.datumPrijeti || Date.parse(r.datumPrijeti) < since) continue;
      const entry = entryOfUnit(p.unit);
      events.push({
        ref: `plomba:${r.id}`,
        kind: "plomba",
        occurredAt: at,
        buildingId: scan.buildingId,
        listingId: entry?.listingId ?? null,
        detail: { unit: formatUnitNumber(p.unit), lv: p.lv ?? null, filedAt: r.datumPrijeti.slice(0, 10), address: entry?.address ?? houseAddress },
      });
    }
  }

  for (const c of scan.closed ?? []) {
    if (c.proceeding.typ !== "V" || prevClosed.has(c.proceeding.id)) continue;
    const entry = entryOfUnit(c.unit);
    events.push({
      ref: `ended:${c.proceeding.id}`,
      kind: "ended",
      occurredAt: at,
      buildingId: scan.buildingId,
      listingId: entry?.listingId ?? null,
      detail: {
        unit: formatUnitNumber(c.unit),
        lv: c.lv ?? null,
        filedAt: c.proceeding.datumPrijeti?.slice(0, 10) ?? null,
        state: c.proceeding.stav ?? null,
        address: entry?.address ?? houseAddress,
      },
    });
  }
  return events;
}

/** Zapíše události; už zapsané (stejný `ref`) přeskočí. Vrací počet nových. */
export function saveKnEvents(db, events) {
  const insert = db.prepare("INSERT OR IGNORE INTO kn_events (ref, kind, occurred_at, building_id, listing_id, detail_json) VALUES (?, ?, ?, ?, ?, ?)");
  let added = 0;
  for (const e of events) {
    added += Number(insert.run(e.ref, e.kind, e.occurredAt, e.buildingId ?? null, e.listingId ?? null, JSON.stringify(e.detail ?? {})).changes);
  }
  return added;
}

/**
 * Všechny události, nejnovější první: `{ ref, kind, occurred_at, building_id, listing_id, detail, dismissed }`.
 * `dismissed` = inzeráty, u kterých uživatel událost domu odmítl ("Není to ten byt").
 */
export function loadKnEvents(db) {
  const dismissed = new Map();
  for (const { event_ref, listing_id } of db.prepare("SELECT event_ref, listing_id FROM kn_event_dismissals").all()) {
    if (!dismissed.has(event_ref)) dismissed.set(event_ref, []);
    dismissed.get(event_ref).push(listing_id);
  }
  return db
    .prepare("SELECT ref, kind, occurred_at, building_id, listing_id, detail_json FROM kn_events ORDER BY occurred_at DESC, id DESC")
    .all()
    .map(({ detail_json, ...row }) => ({ ...row, detail: JSON.parse(detail_json || "{}"), dismissed: dismissed.get(row.ref) ?? [] }));
}

/**
 * Uživatel říká, že událost domu `ref` není byt `listingId`. Zapíše se jen pro existující událost bez bytu (u
 * události přiřazené k bytu není co odmítat). Vrací, jestli se odmítnutí zapsalo (poprvé).
 */
export function dismissKnEvent(db, ref, listingId, now = new Date().toISOString()) {
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO kn_event_dismissals (event_ref, listing_id, dismissed_at)
       SELECT ref, ?, ? FROM kn_events WHERE ref = ? AND listing_id IS NULL`
    )
    .run(listingId, now, String(ref ?? ""));
  return Number(result.changes) > 0;
}
