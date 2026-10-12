// RealityMIX detail — server-rendered HTML pro fotky, ale POPIS na téhle
// stránce v syrovém HTML vůbec není (ověřeno naostro: žádné "Popis",
// text se zjevně dotahuje až přes JS hydrataci na klientovi, kterou
// fetchText logicky nevidí) — description proto zůstává vždy null. Stejný
// fail-soft přístup jako u zbytku projektu s RealityMIX: raději chybějící
// pole než shozený běh (viz komentáře v sources/realitymix.js). Ze stejného
// důvodu se nezískají ani strukturovaná pole `params` (viz ../params.js) —
// vrací se prázdné.
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

    return { description: null, photoUrls, reserved: false, params: {}, geo: extractGeo(html, $) };
  } catch (err) {
    console.warn(`[detail/realitymix] ${url}: ${err.message}`);
    return { description: null, photoUrls: [], reserved: false, params: {}, geo: null };
  }
}
