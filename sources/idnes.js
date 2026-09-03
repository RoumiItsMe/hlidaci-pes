// Reality.iDNES.cz — klasicky server-rendered HTML (žádný embedded JSON),
// parsuje se přes CSS selektory (cheerio).
//
// Lokalita: hledání je na úrovni "město Ústí nad Orlicí" (bez okolí +5 km —
// iDNES nenabízí radius filtr ani GPS souřadnice u jednotlivých inzerátů
// v seznamu, takže přesný 5km filtr tu nejde spočítat jako u Sreality/
// Bezrealitky). Drobné podhodnocení oproti +5 km je vědomý kompromis.

import * as cheerio from "cheerio";
import { fetchText } from "../lib/http.js";

const SEARCH_URL = "https://reality.idnes.cz/s/prodej/byty/usti-nad-orlici/";

export async function fetchIdnes() {
  const html = await fetchText(SEARCH_URL);
  const $ = cheerio.load(html);

  const items = [];
  $(".c-products__inner").each((_, el) => {
    const $el = $(el);
    const link = $el.find("a.c-products__link").first();
    const href = link.attr("href");
    if (!href) return;

    const idMatch = href.match(/\/([0-9a-f]{24})\/?$/i);
    const id = idMatch ? idMatch[1] : href;

    const title = $el.find(".c-products__title").first().text().replace(/\s+/g, " ").trim();
    const address = $el.find(".c-products__info").first().text().replace(/\s+/g, " ").trim();
    const price = $el.find(".c-products__price").first().text().replace(/\s+/g, " ").trim();

    items.push({
      source: "idnes",
      sourceLabel: "Reality.iDNES.cz",
      id,
      title: title || "Byt na prodej",
      price: price || "Cena na vyžádání",
      address,
      url: href,
    });
  });
  return items;
}
