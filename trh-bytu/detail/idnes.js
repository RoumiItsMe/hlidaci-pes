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

// Poloha bytu (viz db.js lat/lon/geo_json): iDNES dává jen bod
// (`listing_lat`/`listing_lon` v datové vrstvě stránky), žádnou adresu —
// a o přesnosti bodu nic neříká (RK může zadat jen ulici), proto se bod
// u iDNES nikdy nebere naslepo, viz geo-suggest.js.
function extractGeo(html) {
  const lat = html.match(/"listing_lat"\s*:\s*(\d+\.\d+)/);
  const lon = html.match(/"listing_lon"\s*:\s*(\d+\.\d+)/);
  if (!lat || !lon) return null;
  return { lat: Number(lat[1]), lon: Number(lon[1]), precision: null, street: null, houseNumber: null };
}

const THUMBS = "sta-reality2.1gr.cz/sta/compile/thumbs/";

// Galerie iDNES míchá fotky s videi (`…/thumbs/video/<id>.mp4`, desítky MB). Video se dřív stahovalo
// jako `1.jpg`, prohlížeč ho jako obrázek nezobrazil a byt zůstal bez náhledu (22. 10. 2026: 20 inzerátů).
const isVideo = (src) => /\/thumbs\/video\/|\.(mp4|mov|webm|m4v)(?:$|\?)/i.test(src);

/**
 * Adresy fotek bytu z galerie `.b-gallery` (viz komentáře výše): plné velikosti z odkazů pro lightbox,
 * bez nich miniatury z `<img>`. Videa se přeskakují; pořadí fotek zůstává.
 * @param $ cheerio načtený detail inzerátu
 */
export function extractPhotoUrls($) {
  const photoUrls = [];
  const seen = new Set();
  const add = (src) => {
    if (!src || !src.includes(THUMBS) || isVideo(src) || seen.has(src)) return;
    seen.add(src);
    photoUrls.push(src);
  };
  $(".b-gallery a[data-fancybox]").each((_, el) => add(($(el).attr("href") || "").replace(/\?.*$/, "")));
  if (photoUrls.length === 0) {
    $(".b-gallery img").each((_, el) => add($(el).attr("src") || $(el).attr("data-src")));
  }
  return photoUrls;
}

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

    // Jen galerie bytu (`.b-gallery`). Stejné CDN cesty mají i fotka a logo
    // makléře (`.b-author`, `.b-sticky`) a karusel podobných nabídek
    // (`.grid-similar-offers`) — ty se dřív nastahovaly jako fotky bytu.
    //
    // Fotky v PLNÉ velikosti (cca 1333×1000, stovky kB) jsou v odkazech
    // galerie pro lightbox (`a[data-fancybox]`) — `<img>` v galerii jsou jen
    // miniatury (pár kB) a lazy načítané velké náhledy. Adresa se bere bez
    // `?gt=r` (stejný soubor, stabilnější identita). Bez odkazů (změna
    // stránky) se spadne na `<img>`, ať appka nezůstane úplně bez fotek.
    const photoUrls = extractPhotoUrls($);

    return { description, photoUrls, reserved: false, sold, params: {}, geo: extractGeo(html) };
  } catch (err) {
    console.warn(`[detail/idnes] ${url}: ${err.message}`);
    // `sold: null` = nezjištěno (selhalo stažení) — stav se nemění, stejná
    // zásada jako u `reserved`, viz reservation.js.
    return { description: null, photoUrls: [], reserved: false, sold: null, params: {}, geo: null };
  }
}
