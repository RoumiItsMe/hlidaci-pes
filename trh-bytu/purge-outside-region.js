// Úklid nabídek MIMO sledovanou oblast (stejná pravidla jako při sběru, viz
// region-guard.js) — pro nabídky, které se do databáze dostaly dřív, než pojistka
// existovala (RealityMIX u Letohradu doplnil výpis Pardubicemi).
//
//   node trh-bytu/purge-outside-region.js            # jen vypíše, co by smazal
//   node trh-bytu/purge-outside-region.js --apply    # záloha databáze, pak smaže
//
// Region podle TRH_REGION jako všude. Smaže se nabídka, její události, fotky
// (řádky i soubory) a události z katastru. Před smazáním se zkopíruje databáze do
// `<složka dat>/backup-purge-<čas>.sqlite`; běží jen když neprobíhá sběr.
// Důležité: smazat PŘED dalším sběrem — kdyby cizí nabídka v DB zůstala, další
// sběr ji (už vyfiltrovanou z výpisu) vyhodnotí jako "zmizelou z nabídky".

import { copyFileSync, existsSync, rmSync, rmdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { openDb, DATA_DIR } from "./db.js";
import { REGION, REGION_WATCH } from "./region.js";
import { outsideReason } from "./region-guard.js";
import { acquireTrackLock, releaseTrackLock } from "./track-lock.js";

const apply = process.argv.includes("--apply");
const db = openDb();
const rows = db.prepare("SELECT id, source, address, status, first_seen_at, lat, lon FROM listings").all();
const candidates = rows.map((r) => ({ ...r, reason: outsideReason(r, REGION_WATCH) })).filter((r) => r.reason);

console.log(`Sekce „${REGION.label}“: ${rows.length} nabídek, mimo sledovanou oblast ${candidates.length}.`);
for (const c of candidates) {
  console.log(`  ${c.id} | ${c.status} | od ${c.first_seen_at.slice(0, 10)} | ${c.address || "(bez adresy)"} | ${c.reason === "point" ? "poloha" : "adresa"}`);
}
if (!candidates.length) process.exit(0);
if (!apply) {
  console.log("\nNic se nesmazalo. Smazání: node trh-bytu/purge-outside-region.js --apply");
  process.exit(0);
}

const lockPath = path.join(DATA_DIR, "track.lock");
if (!acquireTrackLock(lockPath)) {
  console.error("Právě běží sběr dat — úklid se nespustil, zkus to za chvíli.");
  process.exit(1);
}
try {
  db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = path.join(DATA_DIR, `backup-purge-${stamp}.sqlite`);
  copyFileSync(path.join(DATA_DIR, "trh-bytu.sqlite"), backup);
  console.log(`\nZáloha databáze: ${backup}`);

  const ids = candidates.map((c) => c.id);
  const photoPaths = [];
  // Tabulka událostí z katastru vzniká až při jejich prvním zápisu.
  const hasKnEvents = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'kn_events'").get());
  db.exec("BEGIN");
  try {
    for (const id of ids) {
      for (const p of db.prepare("SELECT local_path FROM photos WHERE listing_id = ?").all(id)) photoPaths.push(p.local_path);
      db.prepare("DELETE FROM photos WHERE listing_id = ?").run(id);
      db.prepare("DELETE FROM events WHERE listing_id = ?").run(id);
      if (hasKnEvents) db.prepare("DELETE FROM kn_events WHERE listing_id = ?").run(id);
      db.prepare("DELETE FROM listings WHERE id = ?").run(id);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  // Soubory fotek až po úspěšném potvrzení databáze.
  const dirs = new Set();
  for (const rel of photoPaths) {
    const file = path.join(DATA_DIR, rel);
    rmSync(file, { force: true });
    dirs.add(path.dirname(file));
  }
  for (const dir of dirs) {
    try {
      if (existsSync(dir) && readdirSync(dir).length === 0) rmdirSync(dir);
    } catch {
      // složka zůstane — nevadí
    }
  }
  console.log(`Smazáno ${ids.length} nabídek (a jejich události, fotky: ${photoPaths.length}).`);
} finally {
  releaseTrackLock(lockPath);
}
