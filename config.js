// Centrální konfigurace hlídacího psa — pole "watches" (sledování). Každé
// sledování je nezávislý filtr (typ nemovitosti, lokality, cenový strop) se
// svým vlastním stavem a Telegram štítkem — takže žádné sledování neovlivní
// dedup logiku jiného, i kdyby náhodou běžela na stejném portálu.

export const watches = [
  {
    key: "byty",
    label: "Byty na prodej",
    emoji: "🏠",
    offerType: "prodej",
    propertyType: "byt",

    // Bez cenového/plošného omezení (dle původního zadání).
    priceMaxCzk: null,

    // Sledované lokality — každá se svým vlastním středem + okruhem.
    // Všechna čtyři místa leží ve stejném okrese (Ústí nad Orlicí, Pardubický
    // kraj) — proto Sreality (fetchuje rovnou celý okres) i RealityMIX
    // (sdílený "region" segment v URL) nepotřebují pro každou lokalitu
    // samostatný dotaz, viz komentáře v příslušných sources/*.js.
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
  },

  {
    key: "pozemky-glamping",
    label: "Pozemek (bydlení/zahrada)",
    emoji: "🏕️",
    offerType: "prodej",
    propertyType: "pozemek",

    // Primárně stavební/bydlení a zahradní pozemky — glamping-kandidáti.
    // Portály nemají kategorii "rekreační pozemek" jako takovou; toho se
    // nejvíc blíží právě "bydlení" (stavební parcela) a "zahrada" — čistě
    // zemědělská půda, lesy, louky a rybníky se vynechávají (viz per-zdroj
    // subtype filtrování v sources/*.js).
    priceMaxCzk: 1_500_000,

    locations: [
      {
        key: "usti-nad-orlici",
        label: "Ústí nad Orlicí",
        zip: "56201",
        citySlug: "usti-nad-orlici",
        centerLat: 49.9739,
        centerLng: 16.3958,
        radiusKm: 20,

        // iDNES nemá přesný km-radius, jen diskrétní úrovně "okolí" (1-5).
        // Úroveň 4 je nejširší, co ještě nepřekračuje 20 km (úroveň 5 už
        // sahá 30+ km) — viz README, sekce "Přesnost lokality u pozemků".
        idnesRadiusTier: 4,

        // RealityMIX nemá GPS u inzerátů ani radius-search vůbec — jako
        // near-náhradu za okruh 20 km bereme stejná 3 sousední města jako
        // u bytů (pokrývá hlavní obce v okolí, ne úplně každou vesnici).
        extraCitySlugs: ["letohrad", "zamberk", "ceska-trebova"],
      },
    ],
  },
];

// Kolik ID na (sledování + zdroj) si pamatovat ve stavovém souboru (ochrana
// proti neomezenému růstu data/seen.json). Staré položky beztak vypadnou
// z "nejnovější" stránky výsledků dřív, než by na tenhle limit došlo.
export const maxSeenPerSource = 500;

// Úřední desky obcí — hledá se v nich záměr prodeje bytu, dražba apod. (viz
// sources/uredni-desky.js a lib/notice-filter.js). Nezávislé na `watches`
// výše: deska nemá cenu ani lokalitu, jen seznam oznámení, takže se
// nefiltruje podle cen/okruhu, ale podle klíčových slov v textu oznámení.
//  - `key`   — stabilní identifikátor (klíč ve stavovém souboru, neměnit)
//  - `type`  — parser desky: "vismo" | "joomla" | "ginis"
//  - `url`   — vismo: kořen webu obce; joomla: adresa desky; ginis: adresa desky
export const noticeBoards = [
  { key: "usti-nad-orlici", label: "Ústí nad Orlicí", type: "joomla", url: "https://www.ustinadorlici.cz/cs/urad/uredni-deska" },
  { key: "letohrad", label: "Letohrad", type: "vismo", url: "https://www.letohrad.eu" },
  { key: "zamberk", label: "Žamberk", type: "vismo", url: "https://www.zamberk.cz" },
  { key: "ceska-trebova", label: "Česká Třebová", type: "vismo", url: "https://www.ceska-trebova.cz" },
  { key: "lanskroun", label: "Lanškroun", type: "ginis", url: "https://ude.ginis.cloud/mesto-lanskroun/" },
];

// Úřední deska drží oznámení, dokud nevyprší lhůta vyvěšení; celý seznam
// najednou vidíme jen u GINIS (Lanškroun, stovky záznamů), ostatní desky
// se čtou po posledních ~100. Vyšší strop než `maxSeenPerSource`, ať se
// oznámení z velké desky neztratí ze stavu a nenahlásí se podruhé.
export const maxSeenPerBoard = 1500;
