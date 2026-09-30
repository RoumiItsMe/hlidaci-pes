// Sdílené popisky pro strukturované parametry bytu ("Vlastnictví", "Stav"
// atd. — podobně jako je Sreality/Bazoš ukazují u vlastní nabídky). Pořadí
// pole = pořadí zobrazení v detailu.
//
// Data k těmhle polím umí dodat jen Sreality a Bezrealitky (obě mají
// strukturovaný JSON na detailu — viz detail/sreality.js a
// detail/bezrealitky.js). iDNES/RealityMIX/Bazoš vracejí prázdný objekt —
// nemají strukturovaná data, jen HTML popisek, ze kterého by se tohle dalo
// vytáhnout jen nespolehlivě regexem. Pole, které žádný zdroj nevyplnil, se
// v detailu prostě nezobrazí (fail-soft, stejný princip jako u popisu).
export const PARAM_FIELDS = [
  ["ownership", "Vlastnictví"],
  ["condition", "Stav"],
  ["buildingType", "Typ budovy"],
  ["floorInfo", "Podlaží"],
  ["energyRating", "Energetická náročnost"],
  ["elevator", "Výtah"],
  ["balcony", "Balkón"],
  ["loggia", "Lodžie"],
  ["terrace", "Terasa"],
  ["cellar", "Sklep"],
  ["parking", "Parkování"],
  ["garage", "Garáž"],
];

// Vlastní hodnocení uživatele (sloupec v `listings`, viz db.js). Appka se
// TEĎ (na rozdíl od dřívějšího "nikdy z portálu") pokusí tahle pole
// odhadnout z klíčových slov v title/description při zaevidování (viz
// detect-own-fields.js, volané z track.js) — ale VŽDY jen jako výchozí
// návrh: jakmile má pole hodnotu (ať od appky, nebo od uživatele), appka ji
// sama od sebe už nikdy nepřepíše, jedině uživatel přes <select> v tabulce
// srovnání nebo v detailu. Tvar `{ column, label, options: [[hodnota,
// popisek], …] }` — `options` slouží jak pro <select>, tak pro překlad
// uložené hodnoty na český popisek při zobrazení. Uložená hodnota, která v
// `options` není (např. po ruční úpravě DB), se zobrazí jako prázdná —
// appka si nic nevymýšlí.
export const OWN_FIELDS = [
  {
    column: "own_condition",
    label: "Stav",
    options: [
      ["needs_reno", "Nutná rekonstrukce"],
      ["maintained", "Udržovaný"],
      ["renovated", "Po rekonstrukci"],
      ["novostavba", "Novostavba"],
    ],
  },
  {
    column: "own_construction",
    label: "Konstrukce",
    options: [
      ["panel", "Panel"],
      ["brick", "Cihla"],
    ],
  },
  {
    column: "own_revitalized",
    label: "Revitalizace domu",
    options: [
      ["yes", "Ano"],
      ["no", "Ne"],
    ],
  },
  // Přehlasování automatického zařazení do statistik "ceny po reko" (viz
  // stats_include v db.js) — NENÍ vlastnost bytu jako předchozí tři pole,
  // je to řízení appky. Přesto stejný <select> mechanismus (auto-submit,
  // sdílená validace v POST handleru) sedí beze změny: prázdná volba "—" =
  // auto podle kritéria, zbylé dvě = vědomá ruční výjimka.
  {
    column: "stats_include",
    label: "Ve statistice",
    options: [
      ["include", "Zahrnout"],
      ["exclude", "Vynechat"],
    ],
  },
];
