// Pojistka proti nabídkám MIMO sledovanou oblast.
//
// Proč: RealityMIX u malého města (např. Letohrad) výpis doplní nabídkami odjinud
// — "podobné" z okresu (Králíky, Červená Voda) a klidně z jiného kraje
// (Pardubice). Sdílený zdroj (sources/realitymix.js, používá ho i hlídací pes)
// je nefiltruje, takže se v appce objevily jako nové nabídky. Sdílené soubory se
// tu neupravují; appka si hlídá oblast sama, ve dvou krocích:
//  1. podle TEXTU adresy z výpisu (jen RealityMIX, ještě před stažením detailu):
//     adresa, která nejmenuje žádnou sledovanou lokalitu, je mimo;
//  2. podle GPS BODU z detailu inzerátu (všechny portály): bod dál než okruh
//     lokality + rezerva od každého středu je mimo. Chytí i nabídku bez adresy.
// Bez adresy / bez bodu se nic nevylučuje — nejistota nesmí schovat skutečnou
// nabídku ("nic nesmí propadnout").

import { haversineKm } from "../lib/geo.js";
import { stripDiacritics } from "./geo-suggest.js";

// Okruh lokality (config.js: 5 km) + tolik km navíc — bod portálu bývá posazený
// do středu obce nebo ulice a okraj okruhu by jinak chytl i nabídky z jeho kraje.
export const OUTSIDE_MARGIN_KM = 8;
const DEFAULT_RADIUS_KM = 5;

// Poloha použitelná pro Česko; cokoli jiného (0,0, prohozené souřadnice) je chybný
// údaj portálu, ne důkaz, že je nabídka daleko.
const plausible = (lat, lon) => typeof lat === "number" && typeof lon === "number" && lat > 48 && lat < 52 && lon > 12 && lon < 19;

/** Vzdálenost bodu k nejbližšímu středu lokality v km (null při nepoužitelné poloze). */
export function nearestCenterKm(lat, lon, watch) {
  if (!plausible(lat, lon)) return null;
  const km = (watch?.locations ?? []).filter((l) => typeof l.centerLat === "number" && typeof l.centerLng === "number").map((l) => haversineKm(lat, lon, l.centerLat, l.centerLng));
  return km.length ? Math.min(...km) : null;
}

/** Leží bod mimo okruh (+ rezerva) VŠECH lokalit? Neznámá poloha = ne (nevylučuje se). */
export function isOutsideByPoint(lat, lon, watch, marginKm = OUTSIDE_MARGIN_KM) {
  if (!plausible(lat, lon)) return false;
  const locations = (watch?.locations ?? []).filter((l) => typeof l.centerLat === "number" && typeof l.centerLng === "number");
  if (!locations.length) return false;
  return locations.every((l) => haversineKm(lat, lon, l.centerLat, l.centerLng) > (l.radiusKm ?? DEFAULT_RADIUS_KM) + marginKm);
}

/**
 * Nejmenuje adresa z výpisu žádnou sledovanou lokalitu? ("Gagarinova, Pardubice II,
 * Pardubice" ano; "Nádražní, Králíky, okr. Ústí nad Orlicí" ne — okres lokalitu jmenuje,
 * takovou nabídku dál rozhodne bod z detailu.) Prázdná adresa = neznámo = ne.
 */
export function isOutsideByAddress(address, watch) {
  const text = stripDiacritics(address).replace(/\s+/g, " ").trim();
  if (!text) return false;
  const labels = (watch?.locations ?? []).map((l) => stripDiacritics(l.label)).filter(Boolean);
  if (!labels.length) return false;
  return !labels.some((label) => text.includes(label));
}

/** Zbytek výpisu bez nabídek, jejichž adresa míří mimo oblast; `dropped` jsou ty vyřazené. */
export function splitByAddress(items, watch) {
  const kept = [];
  const dropped = [];
  for (const item of items) (isOutsideByAddress(item.address, watch) ? dropped : kept).push(item);
  return { kept, dropped };
}

/**
 * Proč je už uložená nabídka mimo oblast: "point" (poloha), "address" (jen RealityMIX,
 * adresa nejmenuje žádnou lokalitu), jinak null. Stejná pravidla jako při sběru.
 */
export function outsideReason(listing, watch) {
  if (isOutsideByPoint(listing.lat, listing.lon, watch)) return "point";
  if (listing.source === "realitymix" && isOutsideByAddress(listing.address, watch)) return "address";
  return null;
}
