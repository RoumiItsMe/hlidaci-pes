// Čistá výpočetní logika kalkulačky marže re-flipu — žádná DB/HTTP
// závislost, jen čísla dovnitř, čísla ven (stejná filozofie jako parse.js/
// group.js/detect-own-fields.js). Implementuje metodiku z uživatelova
// návodu: odhadni prodejní cenu → odečti náklady na reko/RK/carry →
// spočítej marži → z CÍLOVÉ marže dopočítej maximální nákupní cenu.
//
// Klíčový detail metodiky (Krok pátý návodu): "Čistý zisk děleno součtem
// VŠECH nákladů krát 100 = marže v procentech" — marže je zisk/NÁKLADY (tj.
// návratnost investovaných peněz vč. nákupní ceny), NE zisk/prodejní cena
// (běžnější "marže na tržbách" jinde). To dělá výpočet maximální nákupní
// ceny kruhovým (nákupní cena je součástí nákladů, ze kterých se marže
// počítá) — řešeno algebraicky níž, ne jen "prodejní cena minus náklady
// minus zisk" z návodu doslova (to by fungovalo, jen kdyby "zisk" byl
// předem daná částka v Kč, ne procento z něčeho, co samo závisí na
// nákupní ceně).
//
// Odvození (m = cílová marže jako desetinné číslo, S = prodejní cena,
// N = náklady BEZ nákupní ceny, B = nákupní cena, hledáme B):
//   m = zisk / (B + N) = (S − B − N) / (B + N)
//   m·(B+N) = S − B − N
//   m·B + m·N = S − B − N
//   B·(1+m) = S − N·(1+m)
//   B = S/(1+m) − N

export const DEFAULT_FLIP_INPUTS = {
  salePriceCzk: null, // appka nemá spolehlivý default, uživatel zadává vždy sám
  currentAskingPriceCzk: null,
  areaM2: null,
  renoRatePerM2Czk: 19000, // střed rozsahu 18 000 - 20 000 Kč/m² z návodu
  kitchenCostCzk: 100000,
  clearingCostCzk: 30000, // střed rozsahu 20 000 - 40 000 Kč
  photographerCostCzk: 7000, // střed rozsahu 4 000 - 10 000 Kč
  lawyerCostCzk: 15000, // střed rozsahu 10 000 - 20 000 Kč
  sellViaAgent: true,
  agentCommissionPct: 4.5, // střed rozsahu 3 - 6 %
  vatPct: 21,
  carryMonthlyCostCzk: 0,
  carryMonths: 4,
  targetMarginPct: 25, // střed cílového rozsahu 20 - 30 % z návodu
};

/**
 * Spočítá náklady na reko, provizi RK, carry náklady, maximální nákupní
 * cenu pro zadanou cílovou marži, a (pokud je zadaná `currentAskingPriceCzk`)
 * kontrolní zisk/marži při koupi za dnešní inzerovanou cenu. Chybějící
 * povinné vstupy (salePriceCzk, areaM2) dávají `null` u výsledků, které bez
 * nich nejdou spočítat — appka si nic nevymýšlí.
 */
export function calculateFlip(rawInputs) {
  const i = { ...DEFAULT_FLIP_INPUTS, ...rawInputs };

  const renoCost = i.areaM2 != null ? i.areaM2 * i.renoRatePerM2Czk : null;
  const softCosts = i.kitchenCostCzk + i.clearingCostCzk + i.photographerCostCzk + i.lawyerCostCzk;
  const totalRenoCost = renoCost != null ? renoCost + softCosts : null;

  const agentCommission = i.sellViaAgent && i.salePriceCzk != null ? i.salePriceCzk * (i.agentCommissionPct / 100) * (1 + i.vatPct / 100) : 0;

  const carryCost = i.carryMonthlyCostCzk * i.carryMonths;

  // Náklady BEZ nákupní ceny (viz odvození v hlavičce souboru) — základ pro
  // dopočet maximální nákupní ceny i pro kontrolní pohled při dnešní ceně.
  const costsWithoutBuy = totalRenoCost != null ? totalRenoCost + agentCommission + carryCost : null;

  let maxBuyPrice = null;
  let profitAtMaxBuy = null;
  if (i.salePriceCzk != null && costsWithoutBuy != null) {
    const m = i.targetMarginPct / 100;
    maxBuyPrice = i.salePriceCzk / (1 + m) - costsWithoutBuy;
    // Zisk při MAXIMÁLNÍ nákupní ceně = přesně cílová marže z konstrukce
    // (maxBuyPrice je odvozená tak, aby to sedělo, viz odvození výš) —
    // dopočítá se stejnou definicí (S − náklady celkem), ne jako
    // `prodejní cena × m`, ať oba výsledky v appce vždy sedí na stejný
    // vzorec.
    profitAtMaxBuy = i.salePriceCzk - (maxBuyPrice + costsWithoutBuy);
  }

  let profitAtAsking = null;
  let marginAtAsking = null;
  if (i.currentAskingPriceCzk != null && i.salePriceCzk != null && costsWithoutBuy != null) {
    const totalCostAtAsking = i.currentAskingPriceCzk + costsWithoutBuy;
    profitAtAsking = i.salePriceCzk - totalCostAtAsking;
    marginAtAsking = totalCostAtAsking > 0 ? (profitAtAsking / totalCostAtAsking) * 100 : null;
  }

  return { renoCost, softCosts, totalRenoCost, agentCommission, carryCost, costsWithoutBuy, maxBuyPrice, profitAtMaxBuy, profitAtAsking, marginAtAsking };
}
