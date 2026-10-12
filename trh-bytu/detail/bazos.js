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
//
// PSČ ale strukturované je: řádek "Lokalita:" v detailu má odkaz
// `title="Přibližná lokalita"` s viditelným textem PSČ ("564 01") — sám
// Bazoš si ho geokóduje z toho, co inzerent zadal, takže je spolehlivější
// než hádání města z volného textu (viz parse.js zipToKnownPlace). Ne
// každý inzerát ho má (starší/bez geokódování prostě řádek chybí) —
// fail-soft, prázdný řetězec `.text()` dá `zip: null`.
import * as cheerio from "cheerio";
import { fetchText } from "../../lib/http.js";
import { parseCzechDateToIso } from "../parse.js";

export async function fetchBazosDetail(url) {
  try {
    const html = await fetchText(url);
    const $ = cheerio.load(html);

    const description = $(".popisdetail").first().text().replace(/\s+/g, " ").trim() || null;
    const zip = $('a[title="Přibližná lokalita"]').first().text().replace(/\s+/g, "") || null;
    // Datum přidání je hned vedle nadpisu inzerátu: "Byt 1kk 28m2 - [29.9.
    // 2026]" — appka bere jen ten span, ne celou stránku, protože stejné
    // datové tvary se objevují i jinde (postranní panel s podobnými
    // inzeráty).
    const listedAt = parseCzechDateToIso($(".inzeratydetnadpis .velikost10").first().text());

    // Fotky inzerátu mají v cestě jeho ID (`/img/<n>t/<xxx>/<id inzerátu>.jpg`);
    // blok "podobné inzeráty" na stejné stránce má stejný tvar cesty, ale
    // jiné ID — bez téhle kontroly se u inzerátu s pár fotkami dostahovaly
    // fotky cizích bytů. Miniatury (`<n>t`) jsou jen u inzerátu s víc
    // fotkami; inzerát s jedinou fotkou má na stránce jen velkou hlavní
    // (`/img/1/…`), která se v tom případě bere (dřív by neměl žádnou vlastní).
    const adId = url.match(/\/inzerat\/(\d+)\//)?.[1];
    const collect = (pattern) => {
      const urls = [];
      const seen = new Set();
      $("img").each((_, el) => {
        const src = $(el).attr("src");
        if (!src || !pattern.test(src)) return;
        if (adId && !src.includes(`/${adId}.jpg`)) return;
        if (seen.has(src)) return;
        seen.add(src);
        urls.push(src);
      });
      return urls;
    };
    let photoUrls = collect(/bazos\.cz\/img\/\d+t\//);
    if (photoUrls.length === 0) photoUrls = collect(/bazos\.cz\/img\/\d+\//);

    return { description, photoUrls, reserved: false, params: {}, zip, listedAt };
  } catch (err) {
    console.warn(`[detail/bazos] ${url}: ${err.message}`);
    return { description: null, photoUrls: [], reserved: false, params: {}, zip: null, listedAt: null };
  }
}
