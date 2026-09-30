// Sdílené popisky pro strukturované parametry bytu ("Vlastnictví", "Stav"
// atd. — podobně jako je Sreality/Bazoš ukazují u vlastní nabídky). Pořadí
// pole = pořadí zobrazení v detailu.
//
// Strukturovaně (JSON na detailu) je dávají jen Sreality a Bezrealitky —
// viz detail/sreality.js a detail/bezrealitky.js. iDNES/RealityMIX/Bazoš
// vracejí prázdný objekt, ale appka pro floorInfo/cellar/ownership zkouší
// aspoň záchrannou síť z volného textu popisu (viz extract-params.js) —
// funguje i tam, kde by strukturovaná data čekala marně, a doplní i
// Sreality/Bezrealitky inzeráty, které mají dané pole nativně prázdné
// (reálný případ, ne teorie). Pole, které se nepodaří vyplnit ani tak, se
// v detailu prostě nezobrazí (fail-soft, stejný princip jako u popisu) —
// nebo si ho uživatel dopíše ručně, viz PARAM_OVERRIDE_FIELDS níž.
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

// Podmnožina PARAM_FIELDS, kterou appka dovolí ručně dopsat/opravit, když
// portál ani text popisu nic neřekly (nebo řekly špatně) — přesně ty pole,
// co uživatel v tabulce srovnání vidí prázdná nejčastěji. `type: "select"`
// s `options` sdílí stejný `ownFieldSelectHtml` mechanismus jako OWN_FIELDS
// (prázdná volba "—" = appka se vrátí k portálové/text hodnotě, viz
// mergeParams v group.js); `type: "text"` je volné pole (podlaží a sklep
// mívají doplňkovou informaci v závorce — "2. patro z 4", "Ano (5 m²)" —
// kterou pevný výběr nepokryje).
export const PARAM_OVERRIDE_FIELDS = [
  { column: "floorInfo", label: "Podlaží", type: "text" },
  { column: "elevator", label: "Výtah", type: "select", options: [["Ano", "Ano"], ["Ne", "Ne"]] },
  { column: "balcony", label: "Balkón", type: "text" },
  { column: "cellar", label: "Sklep", type: "text" },
  { column: "ownership", label: "Vlastnictví", type: "select", options: [["Osobní", "Osobní"], ["Družstevní", "Družstevní"]] },
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
