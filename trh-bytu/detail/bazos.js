// Bazoš detail — server-rendered HTML.
//
// Zjištěno naostro: popis je vždy v `<div class="popisdetail">` (jediný
// výskyt té třídy na stránce s reálným obsahem inzerátu — na rozdíl od
// generických selektorů typu "obsahuje slovo popis", které chytaly i popisy
// PODOBNÝCH inzerátů v postranním panelu). Fotky mají cestu
// `bazos.cz/img/<N>t/...` (miniatury z galerie) — menší soubory než
// plnohodnotné fotky, ale pro účel appky (rychlý vizuální přehled) stačí a
// šetří místo na disku. Žádný "rezervováno"/"prodáno" text na vzorku nebyl
// — reserved-detekce pro Bazoš není k dispozici. Strukturovaná pole
// `params` (viz ../params.js) Bazoš vůbec nenabízí — bez embedded JSON by
// šla vytáhnout jen nespolehlivě z volného textu popisu, vrací se prázdné.

import * as cheerio from "cheerio";
import { fetchText } from "../../lib/http.js";

export async function fetchBazosDetail(url) {
  try {
    const html = await fetchText(url);
    const $ = cheerio.load(html);

    const description = $(".popisdetail").first().text().replace(/\s+/g, " ").trim() || null;

    const photoUrls = [];
    const seen = new Set();
    $("img").each((_, el) => {
      const src = $(el).attr("src");
      if (!src || !/bazos\.cz\/img\/\d+t\//.test(src)) return;
      if (seen.has(src)) return;
      seen.add(src);
      photoUrls.push(src);
    });

    return { description, photoUrls, reserved: false, params: {} };
  } catch (err) {
    console.warn(`[detail/bazos] ${url}: ${err.message}`);
    return { description: null, photoUrls: [], reserved: false, params: {} };
  }
}
