// Poloha bytu: uložení toho, co o ní řekl portál (viz detail/*.js `geo`),
// a zpětné geokódování bodů (souřadnice -> nejbližší dům s číslem).
//
// Proč se to řeší hned při prvním spatření inzerátu: souřadnice i
// strukturovaná adresa zmizí ze stránky spolu s inzerátem (ověřeno na
// zmizelých inzerátech iDNES), takže pozdější dohledání je mnohem těžší.
//
// Geokodér je veřejná služba OpenStreetMap (Nominatim) — její pravidla
// dovolují max. 1 dotaz za sekundu a vyžadují identifikující User-Agent;
// výsledek se proto ukládá do `geocode_cache` a stejný bod se nikdy
// nedotazuje dvakrát. Posílají se jen souřadnice veřejných inzerátů.

import { nowIso } from "./db.js";

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/reverse";
const USER_AGENT = "hlidaci-pes-trh-bytu/1.0 (osobni nekomercni pouziti)";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function geoKey(lat, lon) {
  return `${lat.toFixed(6)},${lon.toFixed(6)}`;
}

/** `geo` z detail/*.js -> sloupce tabulky listings (lat, lon, geo_json). */
export function geoFields(geo) {
  if (!geo) return {};
  const fields = {};
  if (typeof geo.lat === "number" && typeof geo.lon === "number") {
    fields.lat = geo.lat;
    fields.lon = geo.lon;
  }
  const { lat, lon, ...rest } = geo;
  if (Object.values(rest).some((v) => v != null)) fields.geo_json = JSON.stringify(rest);
  return fields;
}

/** Načte mezipaměť geokódování do mapy klíč -> výsledek (objekt | null). */
export function loadGeocodeCache(db) {
  const cache = new Map();
  for (const r of db.prepare("SELECT key, result_json FROM geocode_cache").all()) {
    cache.set(r.key, r.result_json ? JSON.parse(r.result_json) : null);
  }
  return cache;
}

/** Jeden zpětný dotaz; vrací objekt Nominatimu, nebo null, když nic nenašel. Při chybě sítě/HTTP vyhodí. */
export async function reverseGeocode(lat, lon) {
  const url = `${NOMINATIM_URL}?format=jsonv2&addressdetails=1&zoom=18&accept-language=cs&lat=${lat}&lon=${lon}`;
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const json = await res.json();
  return json && !json.error ? json : null;
}

/**
 * Doplní do mezipaměti body, které tam ještě nejsou. Sreality body s
 * hrubou přesností (obec/část obce/ulice) se přeskakují — jsou to středy,
 * ne budovy. Fail-soft: výpadek služby sběr nezastaví, dokončí se příště.
 */
export async function geocodePending(db, log, { limit = 80, delayMs = 1100 } = {}) {
  const pins = db
    .prepare(
      `SELECT DISTINCT lat, lon FROM listings
       WHERE lat IS NOT NULL AND lon IS NOT NULL
         AND (source != 'sreality' OR json_extract(geo_json, '$.precision') = 'address')`
    )
    .all();
  const cache = loadGeocodeCache(db);
  const todo = pins.filter((p) => !cache.has(geoKey(p.lat, p.lon))).slice(0, limit);
  let done = 0;
  let failures = 0;
  for (const p of todo) {
    try {
      const result = await reverseGeocode(p.lat, p.lon);
      db.prepare("INSERT OR REPLACE INTO geocode_cache (key, result_json, fetched_at) VALUES (?, ?, ?)").run(
        geoKey(p.lat, p.lon),
        result ? JSON.stringify(result) : null,
        nowIso()
      );
      done++;
      failures = 0;
    } catch (err) {
      failures++;
      log(`[geo] zpětné geokódování selhalo (${p.lat},${p.lon}): ${err.message}`);
      if (failures >= 3) {
        log("[geo] třikrát po sobě selhalo, zbytek se zkusí při příštím běhu.");
        break;
      }
    }
    await sleep(delayMs);
  }
  if (todo.length > 0) log(`[geo] geokódováno ${done} z ${todo.length} nových bodů.`);
  return { done, pending: Math.max(0, todo.length - done) };
}
