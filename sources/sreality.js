// Sreality.cz — data se čtou přímo z embedded JSON (__NEXT_DATA__), který
// stránka posílá server-side rendered. Žádné volání API navíc není potřeba.
//
// Lokality: fetchujeme jedním dotazem za celý okres Ústí nad Orlicí (ten
// pokrývá VŠECHNY nakonfigurované lokality — Ústí n. O., Letohrad, Žamberk
// i Českou Třebovou, protože všechny leží ve stejném okrese), a pak každý
// inzerát otestujeme, jestli spadá do okruhu ALESPOŇ JEDNÉ z nich (přes GPS
// souřadnice). Sreality neumí "adresa + poloměr" hledání přes URL/parametry,
// ale ke každému inzerátu vrací lat/lng, takže si radius dopočítáme sami —
// a díky jednomu společnému fetchi za celý okres nepotřebujeme samostatný
// dotaz na lokalitu (na rozdíl od Bezrealitky/iDNES/RealityMIX/Bazoše).

import { haversineKm } from "../lib/geo.js";
import { fetchText } from "../lib/http.js";

const SEARCH_URL = "https://www.sreality.cz/hledani/prodej/byty/usti-nad-orlici";

function extractNextData(html) {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) {
    throw new Error(
      "sreality: __NEXT_DATA__ nenalezen — struktura stránky se pravděpodobně změnila."
    );
  }
  return JSON.parse(m[1]);
}

function buildDetailUrl(item) {
  const disposition = item.categorySubCb?.name || "";
  const loc = item.locality || {};
  const parts = [loc.citySeoName, loc.cityPartSeoName, loc.streetSeoName].filter(Boolean);
  const slug = parts.length ? parts.join("-") : "byt";
  return `https://www.sreality.cz/detail/prodej/byt/${encodeURIComponent(
    disposition
  )}/${slug}/${item.id}`;
}

function formatPrice(priceCzk) {
  if (!priceCzk) return "Cena na vyžádání";
  return `${priceCzk.toLocaleString("cs-CZ")} Kč`;
}

// U měst bez konkrétní čtvrti vrací Sreality cityPart === city (např. obojí
// "Ústí nad Orlicí") — bez téhle deduplikace by adresa vyšla "Ústí nad
// Orlicí, Ústí nad Orlicí".
function formatAddress(locality) {
  const cityPart = locality?.cityPart;
  const city = locality?.city;
  if (cityPart && cityPart !== city) return `${cityPart}, ${city}`;
  return city || "";
}

export async function fetchSreality(config) {
  const html = await fetchText(SEARCH_URL);
  const data = extractNextData(html);
  const dehydrated = data?.props?.pageProps?.dehydratedState;
  if (!dehydrated) {
    throw new Error("sreality: dehydratedState chybí — struktura stránky se změnila.");
  }
  const query = dehydrated.queries.find((q) => q.queryKey?.[0] === "estatesSearch");
  const results = query?.state?.data?.results || [];

  const items = [];
  for (const r of results) {
    const lat = r.locality?.latitude;
    const lng = r.locality?.longitude;
    if (lat == null || lng == null) continue;

    const withinAnyLocation = config.locations.some(
      (loc) => haversineKm(loc.centerLat, loc.centerLng, lat, lng) <= loc.radiusKm
    );
    if (!withinAnyLocation) continue;

    items.push({
      source: "sreality",
      sourceLabel: "Sreality.cz",
      id: String(r.id),
      title: r.name || "Byt na prodej",
      price: formatPrice(r.priceCzk),
      address: formatAddress(r.locality),
      url: buildDetailUrl(r),
    });
  }
  return items;
}
