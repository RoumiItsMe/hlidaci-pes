// SQLite úložiště pro Trh bytů — čistě lokální (na rozdíl od hlídacího psa,
// který svůj stav commituje do gitu, protože běží na efemérním GitHub
// Actions runneru). Tady žádný GitHub Actions není, appka běží na uživatelově
// PC natrvalo, takže obyčejný souborový SQLite stačí a je nejjednodušší.
//
// `node:sqlite` je vestavěné v Node (ověřeno funkční, žádná nová npm
// závislost) — držíme se stejné "minimum závislostí" filozofie jako
// zbytek repa (cheerio je jediná).

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.join(__dirname, "data");
export const PHOTOS_DIR = path.join(DATA_DIR, "photos");
const DB_PATH = path.join(DATA_DIR, "trh-bytu.sqlite");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS listings (
  id TEXT PRIMARY KEY,              -- "<source>:<source_id>"
  source TEXT NOT NULL,
  source_id TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT,
  disposition TEXT,
  area_m2 REAL,
  address TEXT,
  description TEXT,
  price_czk INTEGER,
  status TEXT NOT NULL DEFAULT 'active',   -- active | reserved | removed
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  removed_at TEXT,
  notes TEXT,
  verified_sale_price_czk INTEGER,
  verified_sale_date TEXT,
  params_json TEXT          -- strukturované parametry (vlastnictví, stav, podlaží...) jako JSON, viz params.js
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id TEXT NOT NULL REFERENCES listings(id),
  event_type TEXT NOT NULL,   -- created | price_change | reserved | removed | reactivated
  old_price_czk INTEGER,
  new_price_czk INTEGER,
  occurred_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_listing ON events(listing_id);

CREATE TABLE IF NOT EXISTS photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id TEXT NOT NULL REFERENCES listings(id),
  local_path TEXT NOT NULL,
  source_url TEXT,
  downloaded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_photos_listing ON photos(listing_id);
`;

let db;

// `CREATE TABLE IF NOT EXISTS` nedoplní nový sloupec do UŽ existující
// tabulky (DB tady žije napříč verzemi appky, ne že by se zakládala
// pokaždé znovu) — nové sloupce se proto přidávají tady, idempotentně
// (kontrola existence, ne "IF NOT EXISTS" — SQLite ho u ADD COLUMN nemá).
const COLUMN_MIGRATIONS = [
  { table: "listings", column: "params_json", ddl: "TEXT" },
  { table: "listings", column: "hidden", ddl: "INTEGER NOT NULL DEFAULT 0" },
  { table: "listings", column: "starred", ddl: "INTEGER NOT NULL DEFAULT 0" },
];

function runMigrations(db) {
  for (const { table, column, ddl } of COLUMN_MIGRATIONS) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!cols.some((c) => c.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    }
  }
}

/** Otevře (a při prvním spuštění založí) SQLite databázi + schéma. */
export function openDb() {
  if (db) return db;
  mkdirSync(DATA_DIR, { recursive: true });
  mkdirSync(PHOTOS_DIR, { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);
  runMigrations(db);
  return db;
}

export function nowIso() {
  return new Date().toISOString();
}

export function getListing(db, id) {
  return db.prepare("SELECT * FROM listings WHERE id = ?").get(id);
}

export function insertListing(db, listing) {
  db.prepare(
    `INSERT INTO listings
      (id, source, source_id, url, title, disposition, area_m2, address, description,
       price_czk, status, first_seen_at, last_seen_at, removed_at, params_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    listing.id,
    listing.source,
    listing.source_id,
    listing.url,
    listing.title ?? null,
    listing.disposition ?? null,
    listing.area_m2 ?? null,
    listing.address ?? null,
    listing.description ?? null,
    listing.price_czk ?? null,
    listing.status,
    listing.first_seen_at,
    listing.last_seen_at,
    listing.removed_at ?? null,
    listing.params_json ?? null
  );
}

export function updateListingFields(db, id, fields) {
  const keys = Object.keys(fields);
  if (keys.length === 0) return;
  const setClause = keys.map((k) => `${k} = ?`).join(", ");
  db.prepare(`UPDATE listings SET ${setClause} WHERE id = ?`).run(...keys.map((k) => fields[k]), id);
}

export function insertEvent(db, event) {
  db.prepare(
    `INSERT INTO events (listing_id, event_type, old_price_czk, new_price_czk, occurred_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(event.listing_id, event.event_type, event.old_price_czk ?? null, event.new_price_czk ?? null, event.occurred_at);
}

export function insertPhoto(db, photo) {
  db.prepare(
    `INSERT INTO photos (listing_id, local_path, source_url, downloaded_at) VALUES (?, ?, ?, ?)`
  ).run(photo.listing_id, photo.local_path, photo.source_url ?? null, photo.downloaded_at);
}

/** Všechna ID inzerátů daného zdroje, co dnes máme v DB jako active/reserved. */
export function getActiveListingIdsForSource(db, source) {
  return db
    .prepare("SELECT id FROM listings WHERE source = ? AND status IN ('active','reserved')")
    .all(source)
    .map((r) => r.id);
}
