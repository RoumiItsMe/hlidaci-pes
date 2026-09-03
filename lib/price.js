// Sdílené pomocné funkce pro práci s cenou — parsing z textu a kontrola
// cenového stropu daného sledování ("watch").

/** Vytáhne cenu v Kč z textu jako "1 250 000 Kč". Vrátí null pro
 * "Cena na vyžádání", "Dohodou" apod. (nejde parsovat). */
export function parsePriceCzkFromText(text) {
  if (!text) return null;
  const digits = text.replace(/[^\d]/g, "");
  if (!digits) return null;
  return parseInt(digits, 10);
}

/**
 * Je cena v rámci cenového stropu sledování? `capCzk = null` = bez omezení.
 * Neznámá cena (null — "Cena na vyžádání"/"Dohodou") se NEfiltruje pryč —
 * radši ukázat i nejistou nabídku, než aby unikla ta jedna dobrá.
 */
export function withinPriceCap(priceCzk, capCzk) {
  if (capCzk == null) return true;
  if (priceCzk == null) return true;
  return priceCzk <= capCzk;
}
