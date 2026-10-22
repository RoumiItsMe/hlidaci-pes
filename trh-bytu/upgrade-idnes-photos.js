// Jednorázové nahrazení miniatur z iDNES fotkami v plné velikosti.
//
// Starší verze appky z iDNES ukládala miniatury (pár kB) — plné fotky
// (cca 1333×1000, stovky kB) jsou v odkazech galerie, viz detail/idnes.js.
// Tenhle skript projde iDNES inzeráty, které jsou ještě v nabídce (u zmizelých
// už stránka s plnými adresami neexistuje, ty zůstanou s tím, co mají), stáhne
// jim plné fotky a TEPRVE když se stáhnou všechny, smaže původní miniatury.
// Když cokoli selže, inzerát zůstane beze změny.
//
//   node trh-bytu/upgrade-idnes-photos.js

import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { openDb, nowIso, insertPhoto, DATA_DIR, PHOTOS_DIR } from "./db.js";
import { MAX_PHOTOS_PER_LISTING, fetchImageBuffer } from "./photos.js";
import { fetchIdnesDetail } from "./detail/idnes.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const db = openDb();
const listings = db
  .prepare("SELECT id, url, status FROM listings WHERE source = 'idnes' AND status IN ('active','reserved')")
  .all();
const photosOf = db.prepare("SELECT id, local_path, source_url FROM photos WHERE listing_id = ? ORDER BY id");

let upgraded = 0;
let skipped = 0;
let failed = 0;
let bytes = 0;

for (const l of listings) {
  const stored = photosOf.all(l.id);
  const detail = await fetchIdnesDetail(l.url);
  await sleep(250);
  const urls = detail.photoUrls.slice(0, MAX_PHOTOS_PER_LISTING);
  if (urls.length === 0) {
    console.log(`${l.id}: stránka nevrátila fotky, přeskočeno`);
    skipped++;
    continue;
  }
  if (stored.length > 0 && stored.every((p) => urls.includes(p.source_url))) {
    skipped++; // už plné fotky
    continue;
  }

  const safeDir = l.id.replace(/[^a-zA-Z0-9_-]/g, "_");
  const dir = path.join(PHOTOS_DIR, safeDir);
  mkdirSync(dir, { recursive: true });
  const stamp = Date.now();
  const written = [];
  let ok = true;
  for (let i = 0; i < urls.length; i++) {
    try {
      const buf = await fetchImageBuffer(urls[i]);
      const ext = (urls[i].match(/\.(jpe?g|png|webp)$/i)?.[1] || "jpg").toLowerCase().replace("jpeg", "jpg");
      const filename = `full_${stamp}_${i + 1}.${ext}`;
      writeFileSync(path.join(dir, filename), buf);
      written.push({ filename, sourceUrl: urls[i], size: buf.length });
    } catch (err) {
      console.warn(`${l.id}: ${urls[i]}: ${err.message}`);
      ok = false;
      break;
    }
    await sleep(150);
  }

  if (!ok) {
    for (const w of written) unlinkSync(path.join(dir, w.filename)); // nic se nemění
    failed++;
    continue;
  }

  for (const p of stored) {
    db.prepare("DELETE FROM photos WHERE id = ?").run(p.id);
    const file = path.join(DATA_DIR, p.local_path);
    if (existsSync(file)) unlinkSync(file);
  }
  const now = nowIso();
  for (const w of written) {
    insertPhoto(db, { listing_id: l.id, local_path: `photos/${safeDir}/${w.filename}`, source_url: w.sourceUrl, downloaded_at: now });
    bytes += w.size;
  }
  upgraded++;
  console.log(`${l.id}: ${stored.length} miniatur → ${written.length} plných fotek`);
}

console.log(`\nHotovo. Nahrazeno ${upgraded} inzerátů (${(bytes / 1048576).toFixed(1)} MB), beze změny ${skipped}, selhalo ${failed}.`);
