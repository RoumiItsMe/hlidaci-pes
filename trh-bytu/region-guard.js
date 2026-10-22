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
import { listingText } from "./listing-text.js";

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

// Poptávky ("Poptávka bytu v …", "Koupím byt …") se na Bazoši občas objeví mezi nabídkami
// k prodeji; nejsou to byty na prodej, do přehledu ani statistik nepatří. Jen začátek titulku.
const DEMAND_TITLE_RE = /^\s*(?:poptáv(?:ka|ám|áme)|koupím|koupíme|sháním|sháníme|hledám\s+(?:ke\s+koupi|koupit)|odkoupím|vykoupím)(?![\p{L}])/iu;

/** Je titulek poptávka (někdo byt shání), ne nabídka k prodeji? */
export function isDemandAd(title) {
  return DEMAND_TITLE_RE.test(String(title ?? ""));
}

// Pronájem mezi nabídkami k prodeji (agentura zařadí inzerát do špatné kategorie, nebo ho portál
// propíše): reálně 3+kk v Letohradě za 19 200 Kč na Sreality, iDNES ("Pronájem bytu 3+kk, 62 m2")
// i RealityMIX (URL .../pronajem-bytu-3-kk-62-m-….html) — za prodej se počítal a po zmizení
// vypadal jako byt prodaný bez rezervace. Pozná se podle (a) slova "pronájem" v URL nebo na
// začátku titulku, (b) ceny pod MIN_SALE_PRICE_CZK (měsíční nájem, ne cena bytu).
const RENTAL_URL_RE = /\/pronajem|pronajem-bytu|\/pronajmu/i;
const RENTAL_TITLE_RE = /^\s*(?:pronájem|pronájmu|k\s+pronájmu|pronajmu|pronajmeme|nájem)(?![\p{L}])/iu;
export const MIN_SALE_PRICE_CZK = 100_000;

/** Je to pronájem, ne prodej bytu? (URL, titulek, nebo cena v řádu měsíčního nájmu) */
export function isRentalAd({ title, url, price_czk: price, priceCzk }) {
  const amount = price ?? priceCzk;
  return RENTAL_URL_RE.test(String(url ?? "")) || RENTAL_TITLE_RE.test(String(title ?? "")) || (typeof amount === "number" && amount > 0 && amount < MIN_SALE_PRICE_CZK);
}

// Podíl na bytě (id. 1/2, "spoluvlastnický podíl o velikosti 1/2 bytové jednotky", dražba poloviny):
// kupuje se část bytu a cena je za ni, takže v přehledu cen bytů nemá co dělat (zkresluje
// statistiky; reálně dražba poloviny bytu v Knapovci za 680 000 Kč). Nehledá se holé slovo
// "podíl" — podíl na společných částech domu ("1656/10000") nebo na pozemku je u běžného bytu
// normální — ale zlomek u slova byt/jednotka/nemovitost/dům nebo za "id."/"ideální". Patro
// ("2/5") nebo velký jmenovatel se tím nechytí.
const FRACTION = String.raw`(?:(?<![\d/])[1-9]\d?\s?\/\s?[1-9]\d?(?![\d/])|[½⅓⅔¼¾⅕⅙⅛])`;
const OF_SIZE = String.raw`(?:(?:o|ve)\s+velikosti\s+|ve\s+výši\s+)?`;
const FLAT_WORD = String.raw`(?:byt|bytov|jednotk|nemovit|dom|dům)`;
const SHARE_RES = [
  // "id. 1/2", "ideální 1/2", "id. podíl o velikosti 1/2", "ideální spoluvlastnický podíl ½"
  new RegExp(String.raw`(?<![\p{L}])(?:id\.|ideáln\p{L}*)\s*(?:spoluvlastnick\p{L}*\s+)?(?:podíl\p{L}*\s+)?${OF_SIZE}${FRACTION}`, "iu"),
  // "podíl o velikosti 1/2 bytové jednotky", "spoluvlastnický podíl 1/3 na bytě"
  new RegExp(String.raw`podíl\p{L}*\s+${OF_SIZE}${FRACTION}\s+(?:na\s+)?${FLAT_WORD}`, "iu"),
  // "prodej 1/2 bytu", "nabízíme polovinu bytové jednotky", "předmětem dražby je ideální ½ nemovitosti"
  new RegExp(String.raw`(?<![\p{L}])(?:prodej\p{L}*|prodám|prodáme|nabízím|nabízíme|dražb\p{L}*|předmětem\s+\p{L}+(?:\s+je)?)\s+(?:se\s+)?(?:ideáln\p{L}*\s+)?(?:${FRACTION}|polovin\p{L}*|půlk\p{L}*)\s+(?:z\s+)?${FLAT_WORD}`, "iu"),
];

/** Je to prodej jen PODÍLU na bytě (id. 1/2…), ne celého bytu? Text = titulek + popis. */
export function isSharePurchase(text) {
  const value = String(text ?? "");
  return SHARE_RES.some((re) => re.test(value));
}

/**
 * Proč záznam není nabídka bytu k prodeji: "demand" (poptávka), "rental" (pronájem), "share"
 * (jen podíl na bytě), jinak null. Podíl se pozná z textu, takže ho jde posoudit jen tam, kde
 * záznam nese popis (`description` / `geo_json`) — výpis ho nemá, viz track.js.
 */
export function notAnOfferReason(listing) {
  if (isDemandAd(listing.title)) return "demand";
  if (isRentalAd(listing)) return "rental";
  if (isSharePurchase(listingText(listing))) return "share";
  return null;
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
