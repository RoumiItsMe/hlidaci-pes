// Automatické doplnění přesné adresy bytu z polohy (viz geo-suggest.js pro
// pravidla a geo.js pro sběr dat). Zapisuje do `exact_address` jen při
// vysoké důvěře a vždy s příznakem `address_auto = 1`, aby šlo poznat, co
// doplnil automat a co uživatel:
//
//  - adresu zapsanou nebo označenou uživatelem ("neznámá", ruční text)
//    automat NIKDY nepřepíše ani nesmaže;
//  - adresu, kterou zapsal sám, přepočítává při každém běhu a když přestane
//    být vysoce jistá (třeba proto, že bod začal sdílet další byt), ODVOLÁ —
//    radši žádná adresa než špatná;
//  - jednotku (`unit_number`) automat nikdy nevyplňuje, ta v inzerátech ani
//    v registrech není.

import { watches } from "../config.js";
import { groupListings, bestAddress, pickOwnValue, isCooperativeOwnership } from "./group.js";
import { extractCity } from "./parse.js";
import { updateListingFields } from "./db.js";
import { geoKey, loadGeocodeCache } from "./geo.js";
import { loadRuianCache, loadRuianFetchedAt, isRuianEntryStale, pointKey, addressKey, parseExactAddress, ruianLookupAddress, saveRuian } from "./ruian.js";
import { resolveAddress, distanceMeters } from "./geo-suggest.js";
import { addressInfo } from "./address-info.js";

const BYTY_WATCH = watches.find((w) => w.key === "byty");
const SHARED_PIN_RADIUS_M = 8;

/** Společný kontext pro vyhodnocení víc skupin najednou (mezipaměť geokódování + body všech bytů). */
export function buildAddressContext(db, listings, groups = groupListings(listings)) {
  const groupIndex = new Map();
  groups.forEach((g, i) => g.members.forEach((m) => groupIndex.set(m.id, i)));
  const pins = listings
    .filter((m) => typeof m.lat === "number" && typeof m.lon === "number")
    .map((m) => ({ gid: groupIndex.get(m.id), lat: m.lat, lon: m.lon }));
  return { groups, pins, cache: loadGeocodeCache(db), ruianCache: loadRuianCache(db) };
}

/**
 * Katastrální údaje bytu z RÚIAN (viz ruian.js): katastrální území (kód +
 * název — potřeba v katastru vedle čísla popisného) a údaje o domě (všechna
 * čísla popisná, počet bytů a podlaží). Bere se z adresy bytu (zapsané nebo
 * vyhodnocené), jinak z bodu v inzerátu. `null`, když zatím nic nevíme.
 */
export function knInfoForGroup(actx, group, resolution) {
  const found = [];
  const parsed = parseExactAddress(pickOwnValue(group.members, "exact_address") || resolution?.text);
  if (parsed) {
    const r = actx.ruianCache.get(addressKey(parsed.street, parsed.number, parsed.city));
    if (r?.ku) found.push({ via: "adresa", r });
  }
  for (const m of group.members) {
    if (typeof m.lat !== "number" || typeof m.lon !== "number") continue;
    const r = actx.ruianCache.get(pointKey(m.lat, m.lon));
    if (r?.ku) found.push({ via: "bod", r });
  }
  const best = found.find((f) => f.r.building && !f.r.ambiguous) || found[0];
  if (!best) return null;
  const b = best.r.building;
  return {
    ku: best.r.ku,
    via: best.via,
    building: b ? { cp: b.cp, flats: b.flats, floors: b.floors, completed: b.completed, isknId: b.isknId ?? null } : null,
  };
}

/**
 * Řádky o adrese bytu do upozornění (Telegram): zapsaná adresa + jednotka a
 * katastrální údaje, nebo upozornění, že adresa chybí. Rezervace je
 * poslední rozumná chvíle ji doplnit, dokud inzerát ještě běží.
 */
export function addressNoticeLines(db, listingId) {
  const listings = db.prepare("SELECT * FROM listings").all();
  const actx = buildAddressContext(db, listings);
  const group = actx.groups.find((g) => g.members.some((m) => m.id === listingId));
  if (!group) return [];
  const exact = pickOwnValue(group.members, "exact_address");
  const unit = pickOwnValue(group.members, "unit_number");
  if (!exact && !unit) {
    // Družstevní byt se v katastru nedá ověřit, takže přesná adresa nic nepřinese.
    if (isCooperativeOwnership(group.members) && bestAddress(group.members)) {
      return ["🏢 Družstevní byt — v katastru nejde ověřit, přesná adresa není potřeba."];
    }
    return [group.members.some((m) => m.address_unknown) ? "📍 Přesná adresa: nedohledatelná" : "⚠️ Přesná adresa není zapsaná — doplň ji, dokud je byt v nabídce."];
  }
  const lines = [`📍 ${[exact, unit ? `jednotka ${unit}` : null].filter(Boolean).join(", ")}`];
  const kn = knInfoForGroup(actx, group, resolveForGroup(actx, group));
  if (kn) lines.push(`🏛️ ${describeKn(kn)}`);
  return lines;
}

/** "k.ú. Česká Třebová [621757] · dům: č.p. 1736, 1737 · 4 podlaží · 12 bytů" */
export function describeKn(kn) {
  if (!kn) return "";
  const parts = [`k.ú. ${kn.ku.nazev} [${kn.ku.kod}]`];
  if (kn.building) {
    parts.push(`dům: č.p. ${kn.building.cp.join(", ")}`);
    if (kn.building.floors) parts.push(`${kn.building.floors} podlaží`);
    if (kn.building.flats) parts.push(`${kn.building.flats} bytů`);
  } else {
    parts.push("budova v bodě nenalezena");
  }
  return parts.join(" · ");
}

/**
 * Město pro zobrazení adresy a dotazy do RÚIAN: z adresy inzerátu (sjednocené
 * názvy jako v celé appce), jinak od portálu, jinak z geokodéru. `extractCity` v
 * krajním případě vrátí poslední segment adresy, i když je to ulice
 * ("ul. Ústecká") — takový výsledek se zahazuje.
 */
export function groupCity(actx, group) {
  const geoCity = group.members.map((m) => (m.geo_json ? JSON.parse(m.geo_json).city : null)).find(Boolean);
  const osmCity = group.members
    .filter((m) => typeof m.lat === "number" && typeof m.lon === "number")
    .map((m) => actx.cache.get(geoKey(m.lat, m.lon))?.address)
    .map((a) => a?.town || a?.city || a?.village)
    .find(Boolean);
  const adCity = extractCity(bestAddress(group.members), BYTY_WATCH);
  return (adCity && !/^ul\./i.test(adCity) ? adCity : null) || geoCity || osmCity || null;
}

export function resolveForGroup(actx, group) {
  const gid = actx.groups.indexOf(group);
  const ctx = {
    city: groupCity(actx, group),
    // Adresní místo z textu inzerátu v RÚIAN (viz ruianPendingTextAddresses);
    // undefined = zatím se nezjišťovalo.
    ruianAddress: (street, number, city) => {
      const key = addressKey(street, number, city);
      return actx.ruianCache.has(key) ? actx.ruianCache.get(key) : undefined;
    },
    geocodes: (lat, lon) => {
      const key = geoKey(lat, lon);
      return actx.cache.has(key) ? actx.cache.get(key) : undefined;
    },
    ruian: (lat, lon) => {
      const key = pointKey(lat, lon);
      return actx.ruianCache.has(key) ? actx.ruianCache.get(key) : undefined;
    },
    // Kolik JINÝCH bytů má bod do pár metrů — sdílený bod nelze přiřadit
    // (je to střed ulice, nebo stejný dům, a to z bodu nepoznáme).
    pinSharedBy: (lat, lon) => {
      const others = new Set();
      for (const p of actx.pins) {
        if (p.gid !== gid && distanceMeters(lat, lon, p.lat, p.lon) <= SHARED_PIN_RADIUS_M) others.add(p.gid);
      }
      return others.size;
    },
  };
  return resolveAddress(group.members, ctx);
}

/**
 * Navržená adresa, kterou appka nedoplnila sama, protože si není dost jistá
 * (střední jistota) — čeká na potvrzení uživatele. Jen u bytu, který nemá
 * žádnou adresu ani jednotku (a není družstevní / označený jako neznámá).
 * `{ text, why }` nebo null; `group` musí být ze seznamu `actx.groups`.
 */
export function addressSuggestion(actx, group) {
  if (addressInfo(group.members).state !== "missing") return null;
  const r = resolveForGroup(actx, group);
  return r.level === "medium" && r.text ? { text: r.text, why: describeEvidence(r) } : null;
}

/** Stručný popis důkazů pro uživatele: "Sreality: adresa z inzerátu · bod z iDNES uvnitř budovy…" */
export function describeEvidence(result) {
  return [...new Set(result.evidence.map((e) => e.note))].join(" · ");
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Ověří v RÚIAN adresy, které appka zatím jen vyčetla z textu inzerátu (ulice +
 * číslo popisné bez dalšího důkazu): jedna se uloží do mezipaměti (kladně i
 * záporně) a vyhodnocení adresy ji pak umí potvrdit, viz resolveAddress.
 * Dotazuje se jen na byty, které ještě nemají adresu; fail-soft jako ruianPending.
 */
export async function ruianPendingTextAddresses(db, log, { limit = 40, delayMs = 250 } = {}) {
  const listings = db.prepare("SELECT * FROM listings").all();
  const groups = groupListings(listings);
  const actx = buildAddressContext(db, listings, groups);
  const fetchedAt = loadRuianFetchedAt(db);
  const todo = [];
  for (const group of groups) {
    const members = group.members;
    // Stejné výjimky jako applyAutoAddresses: ruční adresa a vědomé "neznámá" se nechají být.
    if (members.some((m) => m.address_unknown || m.address_auto === -1 || (m.exact_address && !m.address_auto))) continue;
    const r = resolveForGroup(actx, group);
    if (r.level !== "medium" || !r.street || !r.number || !r.evidence.some((e) => e.type === "text" || e.needsRegister)) continue;
    const city = groupCity(actx, group);
    if (!city) continue;
    const key = addressKey(r.street, r.number, city);
    const known = actx.ruianCache.has(key) && !isRuianEntryStale(key, actx.ruianCache.get(key), fetchedAt.get(key));
    if (known || todo.some((t) => t.key === key)) continue;
    todo.push({ key, street: r.street, number: r.number, city });
  }

  let done = 0;
  let failures = 0;
  for (const job of todo.slice(0, limit)) {
    try {
      saveRuian(db, job.key, await ruianLookupAddress(job.street, job.number, job.city));
      done++;
      failures = 0;
    } catch (err) {
      failures++;
      log(`[ruian] ověření adresy z textu selhalo (${job.street} ${job.number}, ${job.city}): ${err.message}`);
      if (failures >= 3) {
        log("[ruian] třikrát po sobě selhalo, zbytek se zkusí při příštím běhu.");
        break;
      }
    }
    await sleep(delayMs);
  }
  if (todo.length > 0) log(`[ruian] ověřeno ${done} z ${Math.min(todo.length, limit)} adres z textu inzerátů.`);
  return { done, pending: Math.max(0, todo.length - done) };
}

/** Projde všechny byty a doplní/odvolá automatické adresy. */
export function applyAutoAddresses(db, log) {
  const listings = db.prepare("SELECT * FROM listings").all();
  const groups = groupListings(listings);
  const actx = buildAddressContext(db, listings, groups);
  let assigned = 0;
  let revoked = 0;

  for (const group of groups) {
    const members = group.members;
    if (members.some((m) => m.address_unknown)) continue;
    if (members.some((m) => m.address_auto === -1)) continue; // uživatel automatickou adresu smazal
    if (members.some((m) => m.exact_address && !m.address_auto)) continue; // ruční adresa vždy vyhrává

    const result = resolveForGroup(actx, group);
    if (result.level === "high") {
      const upToDate = members.every((m) => m.exact_address === result.text && m.address_auto);
      if (upToDate) continue;
      for (const m of members) updateListingFields(db, m.id, { exact_address: result.text, address_auto: 1 });
      assigned++;
      log(`[geo] adresa doplněna automaticky: ${result.text} (${describeEvidence(result)})`);
    } else if (members.some((m) => m.address_auto)) {
      for (const m of members) updateListingFields(db, m.id, { exact_address: null, address_auto: null });
      revoked++;
      log(`[geo] automatická adresa odvolána (už není dost jistá): ${members[0].id}`);
    }
  }
  return { assigned, revoked };
}
