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
import { groupListings, bestAddress } from "./group.js";
import { extractCity } from "./parse.js";
import { updateListingFields } from "./db.js";
import { geoKey, loadGeocodeCache } from "./geo.js";
import { resolveAddress, distanceMeters } from "./geo-suggest.js";

const BYTY_WATCH = watches.find((w) => w.key === "byty");
const SHARED_PIN_RADIUS_M = 8;

/** Společný kontext pro vyhodnocení víc skupin najednou (mezipaměť geokódování + body všech bytů). */
export function buildAddressContext(db, listings, groups = groupListings(listings)) {
  const groupIndex = new Map();
  groups.forEach((g, i) => g.members.forEach((m) => groupIndex.set(m.id, i)));
  const pins = listings
    .filter((m) => typeof m.lat === "number" && typeof m.lon === "number")
    .map((m) => ({ gid: groupIndex.get(m.id), lat: m.lat, lon: m.lon }));
  return { groups, pins, cache: loadGeocodeCache(db) };
}

export function resolveForGroup(actx, group) {
  const gid = actx.groups.indexOf(group);
  // Město pro zobrazení adresy: z adresy inzerátu (sjednocené názvy jako v
  // celé appce), jinak od portálu, jinak z geokodéru. `extractCity` v
  // krajním případě vrátí poslední segment adresy, i když je to ulice
  // ("ul. Ústecká") — takový výsledek se zahazuje.
  const geoCity = group.members.map((m) => (m.geo_json ? JSON.parse(m.geo_json).city : null)).find(Boolean);
  const osmCity = group.members
    .filter((m) => typeof m.lat === "number" && typeof m.lon === "number")
    .map((m) => actx.cache.get(geoKey(m.lat, m.lon))?.address)
    .map((a) => a?.town || a?.city || a?.village)
    .find(Boolean);
  const adCity = extractCity(bestAddress(group.members), BYTY_WATCH);
  const ctx = {
    city: (adCity && !/^ul\./i.test(adCity) ? adCity : null) || geoCity || osmCity || null,
    geocodes: (lat, lon) => {
      const key = geoKey(lat, lon);
      return actx.cache.has(key) ? actx.cache.get(key) : undefined;
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

/** Stručný popis důkazů pro uživatele: "Sreality: adresa z inzerátu · bod z iDNES uvnitř budovy…" */
export function describeEvidence(result) {
  return [...new Set(result.evidence.map((e) => e.note))].join(" · ");
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
