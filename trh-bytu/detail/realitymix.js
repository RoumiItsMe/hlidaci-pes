// RealityMIX detail — server-rendered HTML pro fotky, ale POPIS na téhle
// stránce v syrovém HTML vůbec není (ověřeno naostro: žádné "Popis",
// text se zjevně dotahuje až přes JS hydrataci na klientovi, kterou
// fetchText logicky nevidí) — description proto zůstává vždy null. Stejný
// fail-soft přístup jako u zbytku projektu s RealityMIX: raději chybějící
// pole než shozený běh (viz komentáře v sources/realitymix.js).
//
// Fotky mají konzistentní CDN cestu `st.realitymix.cz/i/...` (zjištěno
// naostro) — `_nahled` varianta je duplicitní náhled první fotky, vyřazuje
// se, ať se nestáhne dvakrát totéž.

import * as cheerio from "cheerio";
import { fetchText } from "../../lib/http.js";

export async function fetchRealitymixDetail(url) {
  try {
    const html = await fetchText(url);
    const $ = cheerio.load(html);

    const photoUrls = [];
    const seen = new Set();
    $("img").each((_, el) => {
      const src = $(el).attr("src") || $(el).attr("data-src");
      if (!src || !src.includes("st.realitymix.cz/i/")) return;
      if (src.includes("_nahled")) return;
      if (seen.has(src)) return;
      seen.add(src);
      photoUrls.push(src);
    });

    return { description: null, photoUrls, reserved: false };
  } catch (err) {
    console.warn(`[detail/realitymix] ${url}: ${err.message}`);
    return { description: null, photoUrls: [], reserved: false };
  }
}
