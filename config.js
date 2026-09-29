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

// Dotazy pro API edesky.cz (viz `queries` u desky okresu níž) — sdílené i s
// per-obecním záložním čtením (`edeskyFallbackId`), ať se hledá všude stejně.
export const EDESKY_QUERIES = [
  { keywords: "draž* OR aukc* OR aukč*", texts: true },
  { keywords: "byt OR bytu OR bytů OR bytové OR bytová OR bytový OR bytovou OR bytovém" },
  { keywords: "prodej* OR prodat OR zcizen* OR odprodej*" },
];

// Úřední desky obcí — hledá se v nich záměr prodeje bytu, dražba apod. (viz
// sources/uredni-desky.js a lib/notice-filter.js). Nezávislé na `watches`
// výše: deska nemá cenu ani lokalitu, jen seznam oznámení, takže se
// nefiltruje podle cen/okruhu, ale podle klíčových slov v textu oznámení.
//  - `key`   — stabilní identifikátor (klíč ve stavovém souboru, neměnit)
//  - `type`  — parser desky: "vismo" | "joomla" | "ginis"
//  - `url`   — vismo: kořen webu obce; joomla: adresa desky; ginis: adresa desky
//  - `edeskyFallbackId` — ID téže obce na edesky.cz (`lib/okres-obce.json`).
//    Když přímé čtení selže (viz sources/uredni-desky.js), zkusí se místo
//    něj JEDNORÁZOVĚ za tenhle běh dotáhnout stejná obec přes edesky API
//    (to samo o sobě z GitHub Actions funguje spolehlivě, viz deska okresu
//    níž). Jakmile přímé čtení zase projde, vrátí se k němu samo — nic se
//    trvale nepřepíná. Zjištěno naostro 2026-09-29: Letohrad/Žamberk/Česká
//    Třebová/Králíky (všechny na CMS Vismo) přestaly být z GitHub Actions
//    dostupné (funguje odjinud, vypadá na blokaci datacenter IP na jejich
//    hostingu) — bez záložního zdroje by byl hlídací pes na tyhle 4 obce
//    slepý po celou dobu výpadku.
//    Vědomý kompromis: záložní oznámení mají jiné ID (`e<docId>` z edesky
//    místo `d-…`/`f-…` z Visma) a chybí jim datum „vyvěšeno do" — po
//    zotavení přímého čtení se tak stejné oznámení může nahlásit podruhé.
//    Levnější než zůstat slepý po dobu výpadku.
export const noticeBoards = [
  { key: "usti-nad-orlici", label: "Ústí nad Orlicí", type: "joomla", url: "https://www.ustinadorlici.cz/cs/urad/uredni-deska" },
  { key: "letohrad", label: "Letohrad", type: "vismo", url: "https://www.letohrad.eu", edeskyFallbackId: 299 },
  { key: "zamberk", label: "Žamberk", type: "vismo", url: "https://www.zamberk.cz", edeskyFallbackId: 1196 },
  { key: "ceska-trebova", label: "Česká Třebová", type: "vismo", url: "https://www.ceska-trebova.cz", edeskyFallbackId: 131 },
  { key: "lanskroun", label: "Lanškroun", type: "ginis", url: "https://ude.ginis.cloud/mesto-lanskroun/" },

  // Další města okresu přes otevřená data úřední desky (OFN, JSON-LD) —
  // adresy feedů z Národního katalogu otevřených dat (data.gov.cz).
  { key: "kraliky", label: "Králíky", type: "ofn", url: "https://www.kraliky.eu/opendata-uredni-deska", edeskyFallbackId: 381 },
  { key: "vysoke-myto", label: "Vysoké Mýto", type: "ofn", url: "https://www.vysoke-myto.cz/opendata-board.php" },

  // Obce na centrálně hostovaném GINIS (stejný systém jako Lanškroun). Adresa
  // `ude.ginis.cloud/<obec>/` se dá uhodnout, ale NESMÍ se brát naslepo:
  // "mesto-albrechtice" je Albrechtice u Karviné, ne naše. Tyhle tři jsou
  // ověřené (odkaz z webu obce, resp. shoda obsahu s tím, co o obci víme).
  { key: "lukova", label: "Luková", type: "ginis", url: "https://ude.ginis.cloud/lukova/" },
  { key: "tatenice", label: "Tatenice", type: "ginis", url: "https://ude.ginis.cloud/tatenice/" },
  { key: "anenska-studanka", label: "Anenská Studánka", type: "ginis", url: "https://ude.ginis.cloud/anenska-studanka/" },

  // Ostatní obce okresu Ústí nad Orlicí (115) přes OFICIÁLNÍ API agregátoru
  // edesky.cz. Jeho deska okresu (id 1033) má obce jako podřízené desky, takže
  // jeden dotaz vrací dokumenty z nich všech (agregátor sbírá 97 ze 115 obcí;
  // seznam obcí s weby: lib/okres-obce.json). Webové stránky edesky.cz se z
  // GitHub Actions číst nedají (robot-check, zjištěno 2026-09-28) — API ano, ale
  // potřebuje osobní klíč: GitHub Secret `EDESKY_API_KEY` (viz README).
  //  - `queries` — API hledá podle PŘESNÝCH tvarů slov (bez skloňování), proto
  //    hvězdička a `OR`. `texts: true` přibalí rozpoznaný text příloh (z něj se
  //    pozná předmět a výměra dražby, aniž by se stahovala PDF).
  //  - `minIntervalMinutes` — oznámení o prodeji a dražbě visí týdny, a jde o
  //    cizí bezplatnou službu v testovacím provozu; stačí se ptát jednou za hodinu.
  //  - `skipBoardIds` — obce, které se čtou přímo z vlastní desky výše (ids na
  //    edesky.cz = klíče v lib/okres-obce.json), tu nejsou podruhé.
  {
    key: "okres-usti-nad-orlici",
    label: "Okres Ústí nad Orlicí",
    type: "edesky-api",
    edeskyId: 1033,
    url: "https://edesky.cz/desky/1033",
    minIntervalMinutes: 60,
    queries: EDESKY_QUERIES,
    // Ústí n. O., Č. Třebová, Lanškroun, Letohrad, Žamberk, Králíky, Vysoké Mýto, Luková, Tatenice, Anenská Studánka
    skipBoardIds: [100, 131, 229, 299, 1196, 381, 215, 2252, 2088, 5211],
  },
];

// Úřední deska drží oznámení, dokud nevyprší lhůta vyvěšení; celý seznam
// najednou vidíme jen u GINIS (Lanškroun, stovky záznamů), ostatní desky
// se čtou po posledních ~100. Vyšší strop než `maxSeenPerSource`, ať se
// oznámení z velké desky neztratí ze stavu a nenahlásí se podruhé.
export const maxSeenPerBoard = 1500;
