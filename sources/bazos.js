// Bazoš.cz (reality.bazos.cz) — má nativní RSS feed přesně pro tenhle účel,
// včetně parametrů pro adresu + okruh v km. Nejjednodušší a nejstabilnější
// ze všech pěti zdrojů.
//
// cat=65 = kategorie "Byty" v rubrice "Prodej" (Reality), typ=1 = Prodej,
// hlokalita = PSČ bez mezery, humkreis = okruh v km.

import * as cheerio from "cheerio";
import { fetchText } from "../lib/http.js";

function buildRssUrl(config) {
  const zip = config.location.zip;
  const radiusKm = config.location.radiusKm;
  const params = new URLSearchParams({
    rub: "re",
    cat: "65",
    typ: "1",
    hlokalita: zip,
    humkreis: String(radiusKm),
  });
  return `https://www.bazos.cz/rss.php?${params.toString()}`;
}

export async function fetchBazos(config) {
  const xml = await fetchText(buildRssUrl(config));
  const $ = cheerio.load(xml, { xmlMode: true });

  const items = [];
  $("item").each((_, el) => {
    const $el = $(el);
    const link = $el.find("link").first().text().trim();
    const rawTitle = $el.find("title").first().text().trim();

    const idMatch = link.match(/\/inzerat\/(\d+)\//);
    if (!idMatch) return;
    const id = idMatch[1];

    // Titulek bývá ve tvaru "Název inzerátu: 4 160 000" (cena bez "Kč" na konci).
    const splitMatch = rawTitle.match(/^(.*):\s*([\d\s]+)$/);
    const title = splitMatch ? splitMatch[1].trim() : rawTitle;
    const price = splitMatch ? `${splitMatch[2].replace(/\s+/g, " ").trim()} Kč` : "Cena na vyžádání";

    items.push({
      source: "bazos",
      sourceLabel: "Bazoš.cz",
      id,
      title: title || "Byt na prodej",
      price,
      address: "",
      url: link,
    });
  });
  return items;
}
