// Úklid "fotek", které nejsou obrázky. iDNES míchá do galerie videa (`…/thumbs/video/<id>.mp4`);
// starší verze appky je stáhla jako `N.jpg`, prohlížeč je v `<img>` nezobrazí (náhled bytu zůstane
// prázdný) a každé video zabírá desítky MB. Nové se už nestahují (viz detail/idnes.js, photos.js).
//
//   node trh-bytu/cleanup-non-image-photos.js            # jen vypíše, co by smazal
//   node trh-bytu/cleanup-non-image-photos.js --apply    # záloha databáze, pak smaže
//
// Region podle TRH_REGION jako všude. Rozhoduje obsah souboru (prvních 16 bajtů), ne přípona:
// smaže se řádek `photos` a soubor jen tam, kde to NENÍ jpeg/png/webp/gif/avif. Soubor, který na
// disku chybí, se nechává být (to je jiná závada). Před smazáním se zkopíruje databáze do
// `<složka dat>/backup-photos-<čas>.sqlite`; běží jen když neprobíhá sběr.

import { copyFileSync, existsSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { openDb, DATA_DIR } from "./db.js";
import { REGION } from "./region.js";
import { imageKindOfFile } from "./photos.js";
import { acquireTrackLock, releaseTrackLock } from "./track-lock.js";

const apply = process.argv.includes("--apply");
const db = openDb();
const rows = db.prepare("SELECT id, listing_id, local_path, source_url FROM photos").all();

const bad = [];
for (const r of rows) {
  const file = path.join(DATA_DIR, r.local_path);
  if (!existsSync(file)) continue;
  if (!imageKindOfFile(file)) bad.push({ ...r, file, size: statSync(file).size });
}

const mb = (n) => (n / 1048576).toFixed(1);
const totalBytes = bad.reduce((sum, b) => sum + b.size, 0);
console.log(`Sekce „${REGION.label}“: ${rows.length} fotek, z toho ${bad.length} není obrázek (${mb(totalBytes)} MB).`);
for (const b of bad) console.log(`  ${b.listing_id} | ${b.local_path} | ${mb(b.size)} MB | ${b.source_url}`);
if (!bad.length) process.exit(0);
if (!apply) {
  console.log("\nNic se nesmazalo. Smazání: node trh-bytu/cleanup-non-image-photos.js --apply");
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
  const backup = path.join(DATA_DIR, `backup-photos-${stamp}.sqlite`);
  copyFileSync(path.join(DATA_DIR, "trh-bytu.sqlite"), backup);
  console.log(`\nZáloha databáze: ${backup}`);

  db.exec("BEGIN");
  try {
    for (const b of bad) db.prepare("DELETE FROM photos WHERE id = ?").run(b.id);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  // Soubory až po úspěšném potvrzení databáze.
  for (const b of bad) rmSync(b.file, { force: true });
  console.log(`Smazáno ${bad.length} souborů (${mb(totalBytes)} MB) a jejich řádků ve fotkách.`);
} finally {
  releaseTrackLock(lockPath);
}
