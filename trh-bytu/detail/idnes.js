// iDNES detail — server-rendered HTML, žádný embedded JSON (stejně jako
// sources/idnes.js pro search výpis).
//
// `params` (strukturovaná pole jako vlastnictví/stav/podlaží, viz
// ../params.js) appka odsud nezíská — bez embedded JSON by šly vytáhnout
// jen nespolehlivě regexem z HTML, proto se vrací prázdné (fail-soft, jen
// Sreality a Bezrealitky mají pro tohle strukturovaná data).
//
// Zjištěno naostro: popis je v `.b-desc.pt-10.mt-10` (obsahuje ale na
// začátku zopakovaný titulek — ořezává se). Galerie fotek má konzistentní
// CDN cestu `sta-reality2.1gr.cz/sta/compile/thumbs/...` — placeholder
// (žádná fotka) i logo mají jiné cesty, takže se snadno vyfiltrují.
//
// Štítek "prodáno" je JEN na detailu (`.labels__item`), ve výpisu ho karta
// nemá — prodaný byt tam má obyčejně jen "Zlevněno" a cenu, a štítek
// "Rezervováno" z karty zmizí (appka by to bez detailu vyhodnotila jako
// zrušenou rezervaci). Prodejce na prodaný inzerát dává skutečnou prodejní
// cenu, takže poslední cena inzerátu = za kolik se byt prodal. Hledá se jen
// ve štítcích, ne v celém textu stránky — v popisu může "prodáno" stát v
// jiném smyslu.

import * as cheerio from "cheerio";
import { fetchText } from "../../lib/http.js";

export async function fetchIdnesDetail(url) {
  try {
    const html = await fetchText(url);
    const $ = cheerio.load(html);

    const sold = $(".labels__item, .badges__item")
      .toArray()
      .some((el) => /^prodáno$/i.test($(el).text().replace(/\s+/g, " ").trim()));

    let description = $(".b-desc.pt-10.mt-10").first().text().replace(/\s+/g, " ").trim() || null;
    // Odstranit zopakovaný titulek na začátku popisu, pokud tam je.
    const title = $("h1").first().text().trim();
    if (description && title && description.startsWith(title)) {
      description = description.slice(title.length).trim();
    }

    const photoUrls = [];
    const seen = new Set();
    $("img").each((_, el) => {
      const src = $(el).attr("src") || $(el).attr("data-src");
      if (!src || !src.includes("sta-reality2.1gr.cz/sta/compile/thumbs/")) return;
      if (seen.has(src)) return;
      seen.add(src);
      photoUrls.push(src);
    });

    return { description, photoUrls, reserved: false, sold, params: {} };
  } catch (err) {
    console.warn(`[detail/idnes] ${url}: ${err.message}`);
    // `sold: null` = nezjištěno (selhalo stažení) — stav se nemění, stejná
    // zásada jako u `reserved`, viz reservation.js.
    return { description: null, photoUrls: [], reserved: false, sold: null, params: {} };
  }
}
