// Centrální konfigurace filtrů hlídacího psa.
// Změna parametrů tady se projeví ve všech zdrojích (portálech) najednou.

export const config = {
  // Typ nabídky a nemovitosti — zatím podporujeme jen "prodej bytů",
  // rozšíření na pronájem/domy by vyžadovalo úpravu jednotlivých zdrojů v sources/.
  offerType: "prodej",
  propertyType: "byt",

  location: {
    label: "Ústí nad Orlicí (PSČ 562 01) + 5 km",
    zip: "56201",
    // Přibližný střed — centrum Ústí nad Orlicí. Používá se pro výpočet
    // vzdálenosti u zdrojů, které vrací GPS souřadnice (Sreality, Bezrealitky).
    centerLat: 49.9739,
    centerLng: 16.3958,
    radiusKm: 5,
  },

  // Cena a plocha bez omezení (dle zadání) — pole tu zůstávají jako
  // dokumentace/rozšiřitelnost, zdroje je aktuálně nepoužívají.
  priceMin: null,
  priceMax: null,
  areaMin: null,
  areaMax: null,

  // Kolik ID na zdroj si pamatovat ve stavovém souboru (ochrana proti
  // neomezenému růstu data/seen.json). Staré položky beztak vypadnou
  // z "nejnovější" stránky výsledků dřív, než by na tenhle limit došlo.
  maxSeenPerSource: 500,
};
