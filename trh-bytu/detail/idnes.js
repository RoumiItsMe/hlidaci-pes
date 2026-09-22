// iDNES detail — server-rendered HTML, žádný embedded JSON (stejně jako
// sources/idnes.js pro search výpis).
//
// Zjištěno naostro: popis je v `.b-desc.pt-10.mt-10` (obsahuje ale na
// začátku zopakovaný titulek — ořezává se). Galerie fotek má konzistentní
// CDN cestu `sta-reality2.1gr.cz/sta/compile/thumbs/...` — placeholder
// (žádná fotka) i logo mají jiné cesty, takže se snadno vyfiltrují. Žádný
// "rezervováno"/"prodáno" text se na vzorku nenašel — reserved-detekce pro
// iDNES není k dispozici, jen removed přes zmizení z výpisu.

import * as cheerio from "cheerio";
import { fetchText } from "../../lib/http.js";

export async function fetchIdnesDetail(url) {
  try {
    const html = await fetchText(url);
    const $ = cheerio.load(html);

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

    return { description, photoUrls, reserved: false };
  } catch (err) {
    console.warn(`[detail/idnes] ${url}: ${err.message}`);
    return { description: null, photoUrls: [], reserved: false };
  }
}
