// Centrální konfigurace filtrů hlídacího psa.
// Změna parametrů tady se projeví ve všech zdrojích (portálech) najednou.

export const config = {
  // Typ nabídky a nemovitosti — zatím podporujeme jen "prodej bytů",
  // rozšíření na pronájem/domy by vyžadovalo úpravu jednotlivých zdrojů v sources/.
  offerType: "prodej",
  propertyType: "byt",

  // Sledované lokality — každá se svým vlastním středem + okruhem.
  // Všechna čtyři místa leží ve stejném okrese (Ústí nad Orlicí, Pardubický
  // kraj) — proto Sreality (fetchuje rovnou celý okres) i RealityMIX
  // (sdílený "region" segment v URL) nepotřebují pro každou lokalitu
  // samostatný dotaz, viz komentáře v příslušných sources/*.js.
  //
  // `zip` = PSČ (bez mezery) pro Bazoš, `citySlug` = URL slug města pro
  // iDNES/RealityMIX, `centerLat/centerLng` = přibližný střed pro výpočet
  // vzdálenosti (Sreality/Bezrealitky).
  locations: [
    {
      key: "usti-nad-orlici",
      label: "Ústí nad Orlicí",
      zip: "56201",
      citySlug: "usti-nad-orlici",
      centerLat: 49.9739,
      centerLng: 16.3958,
      radiusKm: 5,
    },
    {
      key: "letohrad",
      label: "Letohrad",
      zip: "56151",
      citySlug: "letohrad",
      centerLat: 50.0352,
      centerLng: 16.5056,
      radiusKm: 5,
    },
    {
      key: "zamberk",
      label: "Žamberk",
      zip: "56401",
      citySlug: "zamberk",
      centerLat: 50.0735,
      centerLng: 16.4351,
      radiusKm: 5,
    },
    {
      key: "ceska-trebova",
      label: "Česká Třebová",
      zip: "56002",
      citySlug: "ceska-trebova",
      centerLat: 49.8998,
      centerLng: 16.4519,
      radiusKm: 5,
    },
  ],

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
