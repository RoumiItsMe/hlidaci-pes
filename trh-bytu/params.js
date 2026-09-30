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

// Vlastní hodnocení uživatele (sloupec v `listings`, viz db.js) — na rozdíl
// od PARAM_FIELDS výš to NIKDY nepřijde z portálu, appka to jen ukládá a
// zobrazuje. Tvar `{ column, label, options: [[hodnota, popisek], …] }` —
// `options` slouží jak pro <select> v tabulce srovnání, tak pro překlad
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
];
