// Co se má zapsat, když sběr u už známého inzerátu zjistí cenu. Čistá logika bez DB, aby šla otestovat.
//
// Appka při každém sběru projde všechny nabídky, porovná je s tím, co zná, a zapíše rozdíl:
//  - cena se změnila (zlevnění i zdražení) → nová cena + událost "změna ceny";
//  - z "Dohodou" (bez ceny) se stala konkrétní cena → totéž (původní cena je prázdná). Dřív se zapsala jen změna u
//    nabídky, která už nějakou cenu měla, takže nabídka založená jako "Dohodou" zůstala bez ceny navždy, i když ji
//    portál mezitím uvedl (Dukelská, 10/2026: Sreality 2 990 000 Kč, appka dál ukazovala 3 290 000 Kč);
//  - cena z textu inzerátu (`price_from_text`) přestane být "z textu", jakmile ji portál sám uvádí.
// Opačný směr — cena → "Dohodou" — se NEzapisuje: portál cenu často jen skrývá a appka drží poslední známou cenu
// (stejně jako u nabídky, která zmizela).

/**
 * @param existing      uložený inzerát (`price_czk`, `price_from_text`)
 * @param itemPriceCzk  cena, kterou portál uvádí teď (`null` = "Dohodou" / na vyžádání)
 * @returns `null` (nic se nemění), nebo `{ fields, event }`: `fields` = sloupce k zápisu, `event` = údaje události
 *          "změna ceny" (`{ old_price_czk, new_price_czk }`), nebo `null`, když se mění jen příznak ceny z textu.
 */
export function planPriceUpdate(existing, itemPriceCzk) {
  if (itemPriceCzk == null) return null;
  const changed = itemPriceCzk !== (existing.price_czk ?? null);
  const fromText = Boolean(existing.price_from_text);
  if (!changed && !fromText) return null;
  return {
    fields: { ...(changed ? { price_czk: itemPriceCzk } : {}), ...(fromText ? { price_from_text: 0 } : {}) },
    event: changed ? { old_price_czk: existing.price_czk ?? null, new_price_czk: itemPriceCzk } : null,
  };
}
