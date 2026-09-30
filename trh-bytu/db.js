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

-- Drobný stav appky (zatím: kdy uživatel naposledy přečetl upozornění)
CREATE TABLE IF NOT EXISTS app_state (
  key TEXT PRIMARY KEY,
  value TEXT
);
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
  { table: "listings", column: "replaced_by", ddl: "TEXT" }, // ID inzerátu, který tenhle nahradil při opětovném vložení na portálu, viz relist.js
  { table: "listings", column: "missed_since", ddl: "TEXT" }, // kdy se inzerát poprvé nenašel ve výpisu; "zmizel" se potvrdí až dalším během, viz relist.js
  { table: "listings", column: "price_from_text", ddl: "INTEGER NOT NULL DEFAULT 0" }, // 1 = cenu portál neuvedl, appka ji vyčetla z popisu (může být zastaralá)
  // Vlastní hodnocení uživatele — NIKDY z portálu (na rozdíl od params_json
  // condition/buildingType, které jsou skoro vždy prázdné, viz params.js).
  // Hodnoty jsou stabilní anglické klíče, viz OWN_FIELDS v params.js pro
  // popisky a povolené volby; NULL = zatím nezhodnoceno.
  { table: "listings", column: "own_condition", ddl: "TEXT" }, // needs_reno | maintained | renovated | novostavba
  { table: "listings", column: "own_construction", ddl: "TEXT" }, // panel | brick
  { table: "listings", column: "own_revitalized", ddl: "TEXT" }, // yes | no
  // Volný text — proč prodávající prodává (dědictví, rozvod, stěhování...),
  // zjištěné typicky až prvním telefonátem. Nikdy z portálu, appka na to
  // pole jen ukládá to, co uživatel sám vyplní (stejná úvaha jako notes).
  { table: "listings", column: "seller_motivation", ddl: "TEXT" },
  // Ruční přehlasování automatického zařazení do statistik "ceny po reko"
  // (viz OWN_FIELDS v params.js a renderRenovatedStats v server.js). NULL =
  // auto (rozhodne kritérium status=removed + own_condition=renovated),
  // "include"/"exclude" = uživatel to vědomě přehlasoval podle vlastního
  // úsudku (např. prodej mezi příbuznými pod cenou, nebo naopak byt bez
  // nálepky "renovated", který se prodal jako plně zrekonstruovaný).
  { table: "listings", column: "stats_include", ddl: "TEXT" },
  // Ruční doplnění/oprava strukturovaných parametrů (patro, výtah, sklep,
  // vlastnictví...), kde portál nic nedal a appka to ani nevytěžila z textu
  // (viz extract-params.js) — JSON objekt `{ pole: hodnota }`, stejný tvar
  // jako params_json, jen PSANÝ uživatelem. Má vždy přednost před
  // params_json, viz mergeParams v group.js.
  { table: "listings", column: "params_override_json", ddl: "TEXT" },
  // Skutečné datum zveřejnění inzerátu PODLE PORTÁLU (Sreality "Vloženo:",
  // Bazoš "[D.M. RRRR]" u nadpisu) — na rozdíl od `first_seen_at` (kdy ho
  // poprvé uviděla APPKA, může být klidně týdny/měsíce po skutečném
  // vystavení). NULL, když ho zdroj neumí dát (iDNES/RealityMIX/
  // Bezrealitky nemají tohle pole vůbec, viz detail/*.js) — appka pak
  // padá zpátky na first_seen_at, nikdy netvrdí datum, které nezná.
  { table: "listings", column: "listed_at", ddl: "TEXT" },
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
       price_czk, status, first_seen_at, last_seen_at, removed_at, params_json, price_from_text)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
    listing.params_json ?? null,
    listing.price_from_text ? 1 : 0
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
