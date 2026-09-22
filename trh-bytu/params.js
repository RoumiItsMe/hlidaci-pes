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
