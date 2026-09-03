// Sreality.cz — data se čtou přímo z embedded JSON (__NEXT_DATA__), který
// stránka posílá server-side rendered. Žádné volání API navíc není potřeba.
//
// Lokalita: fetchujeme za celý okres Ústí nad Orlicí (širší než 5 km), pak
// filtrujeme přes GPS souřadnice každého inzerátu na skutečný poloměr —
// Sreality neumí "adresa + poloměr" hledání přes URL/parametry, ale ke
// každému inzerátu vrací lat/lng, takže si radius dopočítáme sami.

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

export async function fetchSreality(config) {
  const html = await fetchText(SEARCH_URL);
  const data = extractNextData(html);
  const dehydrated = data?.props?.pageProps?.dehydratedState;
  if (!dehydrated) {
    throw new Error("sreality: dehydratedState chybí — struktura stránky se změnila.");
  }
  const query = dehydrated.queries.find((q) => q.queryKey?.[0] === "estatesSearch");
  const results = query?.state?.data?.results || [];

  const { centerLat, centerLng, radiusKm } = config.location;
  const items = [];
  for (const r of results) {
    const lat = r.locality?.latitude;
    const lng = r.locality?.longitude;
    if (lat == null || lng == null) continue;
    if (haversineKm(centerLat, centerLng, lat, lng) > radiusKm) continue;

    items.push({
      source: "sreality",
      sourceLabel: "Sreality.cz",
      id: String(r.id),
      title: r.name || "Byt na prodej",
      price: formatPrice(r.priceCzk),
      address: [r.locality?.cityPart, r.locality?.city].filter(Boolean).join(", "),
      url: buildDetailUrl(r),
    });
  }
  return items;
}
