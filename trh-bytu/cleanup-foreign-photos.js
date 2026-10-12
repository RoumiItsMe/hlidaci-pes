// Jednorázový úklid fotek, které se dřív stáhly k bytu omylem — detailní
// stránky RealityMIX, iDNES a Bazoš mají vedle galerie bytu i fotku makléře,
// logo realitky a "podobné nabídky" (fotky úplně jiných bytů) a starší
// parsery (viz detail/*.js) braly všechny obrázky na stránce.
//
//   node trh-bytu/cleanup-foreign-photos.js            # jen vypíše, co by smazal
//   node trh-bytu/cleanup-foreign-photos.js --apply    # smaže a doplní chybějící
//
// Maže se jen fotka, u které je JISTÉ, že není z galerie bytu:
//  - RealityMIX: v cestě chybí ID téhle nabídky + `nab_` (makléř, logo, cizí nabídka);
//  - Bazoš: v cestě chybí ID tohoto inzerátu (podobné inzeráty);
//  - iDNES, inzerát ještě v nabídce: fotka leží na aktuální stránce MIMO galerii
//    (`.b-gallery` — makléř, logo, podobné nabídky);
//  - iDNES (i zmizelé inzeráty, jejichž stránku už nejde stáhnout): stejná fotka
//    je u víc iDNES inzerátů — galerie bytu je unikátní, sdílená je jen fotka a
//    logo makléře.
// Nemaže se podle "není v aktuální galerii": iDNES občas změní adresy všech
// náhledů a uložené kopie jsou pořád fotky téhož bytu.
// U inzerátů v nabídce se po úklidu stáhnou vlastní fotky, které chyběly (třeba
// Bazoš s jedinou fotkou, kde se dřív stáhly jen cizí) — iDNES jen když o
// všechny fotky přišel.
//
// Mazání je trvalé, proto je výchozí běh jen náhled. Fotky jsou kopie z
// portálů, žádná uživatelova data.

import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as cheerio from "cheerio";
import { fetchText } from "../lib/http.js";
import { openDb, nowIso, insertPhoto, DATA_DIR, PHOTOS_DIR } from "./db.js";
import { MAX_PHOTOS_PER_LISTING } from "./photos.js";
import { fetchRealitymixDetail } from "./detail/realitymix.js";
import { fetchBazosDetail } from "./detail/bazos.js";

const APPLY = process.argv.includes("--apply");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const IDNES_THUMBS = "sta-reality2.1gr.cz/sta/compile/thumbs/";

const db = openDb();
const listings = db.prepare("SELECT id, source, url, status FROM listings WHERE source IN ('idnes','realitymix','bazos')").all();
const photosOf = db.prepare("SELECT id, listing_id, local_path, source_url FROM photos WHERE listing_id = ? ORDER BY id");
const live = (l) => l.status === "active" || l.status === "reserved";

// iDNES: u kolika různých inzerátů se která fotka vyskytuje.
const idnesUrlCount = new Map();
for (const l of listings.filter((x) => x.source === "idnes")) {
  for (const p of photosOf.all(l.id)) {
    if (!idnesUrlCount.has(p.source_url)) idnesUrlCount.set(p.source_url, new Set());
    idnesUrlCount.get(p.source_url).add(l.id);
  }
}

function isOwnByUrl(l, sourceUrl) {
  if (l.source === "realitymix") {
    const offerId = l.url.match(/-(\d+)\.html/)?.[1];
    return Boolean(offerId) && new RegExp(`st\\.realitymix\\.cz/i/\\d+/${offerId}/nab_`).test(sourceUrl) && !sourceUrl.includes("_nahled");
  }
  if (l.source === "bazos") {
    const adId = l.url.match(/\/inzerat\/(\d+)\//)?.[1];
    return Boolean(adId) && sourceUrl.includes(`/${adId}.jpg`);
  }
  return true;
}

// iDNES: obrázky aktuální stránky mimo galerii bytu (makléř, logo, podobné nabídky).
async function idnesNonGallery(url) {
  const $ = cheerio.load(await fetchText(url));
  const gallery = new Set();
  $(".b-gallery img").each((_, el) => gallery.add($(el).attr("src") || $(el).attr("data-src")));
  const other = new Set();
  $("img").each((_, el) => {
    const src = $(el).attr("src") || $(el).attr("data-src");
    if (src?.includes(IDNES_THUMBS) && !gallery.has(src)) other.add(src);
  });
  return { gallery: [...gallery].filter(Boolean), other };
}

function deletePhoto(p) {
  db.prepare("DELETE FROM photos WHERE id = ?").run(p.id);
  const file = path.join(DATA_DIR, p.local_path);
  if (existsSync(file)) unlinkSync(file);
}

async function downloadExtra(l, urls) {
  const dir = path.join(PHOTOS_DIR, l.id.replace(/[^a-zA-Z0-9_-]/g, "_"));
  mkdirSync(dir, { recursive: true });
  let added = 0;
  for (const url of urls) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const ext = (url.match(/\.(jpe?g|png|webp)(?:$|\?)/i)?.[1] || "jpg").toLowerCase().replace("jpeg", "jpg");
      const filename = `fix_${Date.now()}_${added + 1}.${ext}`;
      writeFileSync(path.join(dir, filename), Buffer.from(await res.arrayBuffer()));
      insertPhoto(db, { listing_id: l.id, local_path: `photos/${path.basename(dir)}/${filename}`, source_url: url, downloaded_at: nowIso() });
      added++;
    } catch (err) {
      console.warn(`  nepodařilo se stáhnout ${url}: ${err.message}`);
    }
    await sleep(200);
  }
  return added;
}

let totalBad = 0;
let totalAdded = 0;
for (const l of listings) {
  const stored = photosOf.all(l.id);
  let bad;
  let fresh = null; // vlastní fotky podle aktuální stránky (jen inzerát v nabídce, jen když se stránka načetla)

  try {
    if (l.source === "idnes") {
      const shared = (p) => idnesUrlCount.get(p.source_url).size >= 2;
      let other = new Set();
      if (live(l)) {
        const page = await idnesNonGallery(l.url);
        await sleep(250);
        other = page.other;
        fresh = page.gallery.slice(0, MAX_PHOTOS_PER_LISTING);
      }
      bad = stored.filter((p) => shared(p) || other.has(p.source_url));
    } else {
      bad = stored.filter((p) => !isOwnByUrl(l, p.source_url));
      if (live(l)) {
        const detail = await (l.source === "bazos" ? fetchBazosDetail : fetchRealitymixDetail)(l.url);
        await sleep(250);
        fresh = detail.photoUrls.slice(0, MAX_PHOTOS_PER_LISTING);
      }
    }
  } catch (err) {
    console.warn(`${l.id}: stránku se nepodařilo načíst (${err.message}), doplnění přeskočeno`);
    bad = bad ?? [];
  }

  const remaining = stored.filter((p) => !bad.includes(p));
  let missing = [];
  if (fresh && fresh.length) {
    const have = new Set(remaining.map((p) => p.source_url));
    // iDNES mění adresy náhledů, "chybějící" by tam byly duplicity téhož bytu — doplňuje se jen při úplné ztrátě.
    missing = fresh.filter((u) => !have.has(u));
    if (l.source === "idnes" && remaining.length > 0) missing = [];
    missing = missing.slice(0, Math.max(0, MAX_PHOTOS_PER_LISTING - remaining.length));
  }

  if (bad.length === 0 && missing.length === 0) continue;
  console.log(`${l.id} [${l.status}]: ${stored.length} uložených → cizích ${bad.length}, doplnit ${missing.length}`);
  totalBad += bad.length;
  if (!APPLY) continue;
  bad.forEach(deletePhoto);
  if (missing.length) totalAdded += await downloadExtra(l, missing);
}

console.log(`\n${APPLY ? "Smazáno" : "Ke smazání"}: ${totalBad} cizích fotek${APPLY ? `, doplněno ${totalAdded} vlastních.` : ". Spusť s --apply."}`);
