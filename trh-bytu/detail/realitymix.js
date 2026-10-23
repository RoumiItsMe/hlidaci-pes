// RealityMIX detail — server-rendered HTML pro fotky, ale POPIS na téhle
// stránce v syrovém HTML vůbec není (ověřeno naostro: žádné "Popis",
// text se zjevně dotahuje až přes JS hydrataci na klientovi, kterou
// fetchText logicky nevidí) — description proto zůstává vždy null. Stejný
// fail-soft přístup jako u zbytku projektu s RealityMIX: raději chybějící
// pole než shozený běh (viz komentáře v sources/realitymix.js). Strukturovaná pole
// `params` (viz ../params.js) ale na stránce JSOU, v bloku "Podrobné informace"
// (`.detail-information__data-item`: Vlastnictví, Druh objektu, Stav objektu,
// Balkon, Sklep…) — čtou se v extractRealitymixParams. Dřív se vracel prázdný
// objekt, takže se o družstevním bytě (Vlastnictví: družstevní) nevědělo a appka
// po rezervaci připomínala kontrolu v katastru, kde se družstevní byt ověřit nedá.
//
// Fotky mají konzistentní CDN cestu `st.realitymix.cz/i/...` (zjištěno
// naostro) — `_nahled` varianta je duplicitní náhled první fotky, vyřazuje
// se, ať se nestáhne dvakrát totéž.

import * as cheerio from "cheerio";
import { fetchText } from "../../lib/http.js";

// Poloha (viz db.js lat/lon/geo_json): bod z atributů `lat`/`lon` na stránce
// (nemají ho všechny inzeráty). Popis TADY JE (`.advert-description__text-
// inner-inner`, JS ho jen přesouvá) — starší komentář výš tvrdí opak. Do
// sloupce `description` se přesto NEUKLÁDÁ: ten rozhoduje o slučování bytů
// napříč portály (group.js descriptionsMatch) a přidání RealityMIX textu by
// mohlo rozbít seskupení, které dnes funguje. Text slouží jen k hledání
// čísla domu (`geo.text`, viz geo-suggest.js).
function extractGeo(html, $) {
  const lat = html.match(/\blat="(\d+\.\d+)"/);
  const lon = html.match(/\blon="(\d+\.\d+)"/);
  const text = $(".advert-description__text-inner-inner").first().text().replace(/\s+/g, " ").trim().slice(0, 4000) || null;
  if (!lat || !lon) return text ? { lat: null, lon: null, precision: null, street: null, houseNumber: null, text } : null;
  return { lat: Number(lat[1]), lon: Number(lon[1]), precision: null, street: null, houseNumber: null, text };
}

// "družstevní" → "Družstevní" (tvar jako u Sreality/Bezrealitky, viz params.js).
const capitalize = (text) => (text ? text.charAt(0).toLocaleUpperCase("cs") + text.slice(1).toLocaleLowerCase("cs") : null);

// "ano" → "Ano", "ne" → "Ne", "5 m²" → "Ano (5 m²)"; cokoli jiného nic (raději nic než špatně).
function yesNo(value) {
  const text = String(value ?? "").trim();
  if (/^ano\b/i.test(text)) return "Ano";
  if (/^ne\b/i.test(text)) return "Ne";
  const area = text.match(/^(\d+(?:[.,]\d+)?)\s*m/i);
  return area ? `Ano (${area[1].replace(".", ",")} m²)` : null;
}

/**
 * Strukturované parametry bytu z dvojic "popisek → hodnota" z bloku Podrobné informace (popisky bez dvojtečky, malými
 * písmeny). Jen to, co je jednoznačné; podlaží se záměrně nečte — "Číslo podlaží v domě" nerozlišuje patro a nadzemní
 * podlaží, takže by šlo o odhad. Vrací jen vyplněná pole (tvar jako detail/bezrealitky.js).
 * @param pairs Map, nebo objekt typu { "vlastnictví": "družstevní", … }
 */
export function paramsFromPairs(pairs) {
  const get = (label) => (pairs instanceof Map ? pairs.get(label) : pairs[label]);
  const energy = String(get("energetická náročnost budovy") ?? "").match(/^([A-G])\b/);
  const params = {
    ownership: capitalize(get("vlastnictví")),
    condition: capitalize(get("stav objektu")),
    buildingType: capitalize(get("druh objektu")),
    energyRating: energy ? energy[1] : null,
    elevator: yesNo(get("výtah")),
    balcony: yesNo(get("balkon")),
    loggia: yesNo(get("lodžie")),
    terrace: yesNo(get("terasa")),
    cellar: yesNo(get("sklep")),
    parking: yesNo(get("parkování")),
    garage: yesNo(get("garáž")),
  };
  return Object.fromEntries(Object.entries(params).filter(([, value]) => value));
}

/** Blok "Podrobné informace" načteného detailu (cheerio) → parametry bytu. */
export function extractRealitymixParams($) {
  const pairs = new Map();
  $(".detail-information__data-item").each((_, el) => {
    const spans = $(el).children("span");
    if (spans.length < 2) return;
    const label = $(spans[0]).text().replace(/\s+/g, " ").trim().replace(/:$/, "").toLowerCase();
    const value = $(spans[1]).text().replace(/\s+/g, " ").trim();
    if (label && value && !pairs.has(label)) pairs.set(label, value);
  });
  return paramsFromPairs(pairs);
}

export async function fetchRealitymixDetail(url) {
  try {
    const html = await fetchText(url);
    const $ = cheerio.load(html);

    // Na stránce je i fotka makléře, logo realitky a karusel "podobné
    // nabídky" (fotky ÚPLNĚ JINÝCH bytů, i od jiných realitek) — bez
    // filtrování se to nastahovalo jako fotky tohohle bytu. Vlastní fotky
    // nabídky mají v cestě její ID a `nab_` (`/i/<firma>/<id nabídky>/nab_*`);
    // makléř je `/makleri/`, logo `/logo/`, cizí nabídka má jiné ID.
    const offerId = url.match(/-(\d+)\.html/)?.[1];
    const ownPhoto = offerId ? new RegExp(`st\\.realitymix\\.cz/i/\\d+/${offerId}/nab_`) : null;
    const photoUrls = [];
    const seen = new Set();
    $("img").each((_, el) => {
      const src = $(el).attr("src") || $(el).attr("data-src");
      if (!src || !ownPhoto?.test(src)) return;
      if (src.includes("_nahled")) return;
      if (seen.has(src)) return;
      seen.add(src);
      photoUrls.push(src);
    });

    return { description: null, photoUrls, reserved: false, params: extractRealitymixParams($), geo: extractGeo(html, $) };
  } catch (err) {
    console.warn(`[detail/realitymix] ${url}: ${err.message}`);
    return { description: null, photoUrls: [], reserved: false, params: {}, geo: null };
  }
}
