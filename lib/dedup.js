// Rozpoznání "téhož" bytu napříč portály pro notifikace (nová nabídka, změna ceny).
//
// Stejná nemovitost se inzeruje na víc portálech najednou a RK/prodejce ji (i její
// cenu) typicky upraví na všech zároveň — bez dedup by o jedné slevě přišlo tolik
// zpráv, kolik je portálů. Dvě vrstvy:
//
//  1. OTISK NEMOVITOSTI (`computeFingerprint`): cena + plocha z titulku. Platí napříč
//     všemi zdroji a oběma typy notifikací, bez časového limitu.
//  2. OTISK ZMĚNY CENY (`changeKey`): dvojice "stará > nová cena", jen pro změny ceny a jen
//     pár dní. Pro případ, že titulek plochu nemá a otisk (1) nejde spočítat — Bazoš
//     (RSS dává jen titulek a cenu) píše "Prodej garsonky se zahradou v České Třebové" a
//     stejný byt na iDNES "prodej bytu 1+kk 32 m²" tak vedl ke dvěma zprávám o téže slevě.
//     Samotná cena by nestačila (dva různé byty za 2 490 000 Kč jsou běžné), ale přesně
//     stejný SKOK u dvou různých bytů ve stejných dnech je vzácný. Zdroj musí být JINÝ: dva
//     různé byty na jednom portálu se nesmí potlačit navzájem.

/** Jak dlouho se změna ceny považuje za "čerstvou" pro dedup přes dvojici cen. */
export const CHANGE_WINDOW_MS = 72 * 60 * 60 * 1000;

// Plocha v titulku: "X m²"/"X m2" je napříč zdroji konzistentní. Když cenu nebo plochu
// nejde zjistit, radši nededuplikovat vůbec (null) než riskovat, že se dvě různé
// nemovitosti mylně sloučí a jedna z nich zmizí.
const AREA_M2_RE = /(\d+(?:[.,]\d+)?)\s*m[²2]/i;

export function computeFingerprint(item) {
  if (item.priceCzk == null) return null;
  const m = item.title?.match(AREA_M2_RE);
  if (!m) return null;
  const areaM2 = Math.round(parseFloat(m[1].replace(",", ".")));
  if (!Number.isFinite(areaM2)) return null;
  return `${item.priceCzk}_${areaM2}`;
}

/** Klíč změny ceny: "2490000>2350000". */
export function changeKey(oldPriceCzk, newPriceCzk) {
  return `${oldPriceCzk}>${newPriceCzk}`;
}

/**
 * Je tahle změna ceny jen opakováním té, kterou už ohlásil jiný portál?
 * Vrací `{ reason: "flat" | "change", via }` (via = čím už byla ohlášená), jinak null.
 * `recentChanges` je Mapa klíč změny → `{ source, sourceLabel, at }` (viz state.js).
 */
export function priceChangeDuplicate({ item, oldPriceCzk, newPriceCzk, seenFingerprints, recentChanges, now = Date.now() }) {
  const fingerprint = computeFingerprint(item);
  if (fingerprint && seenFingerprints.has(fingerprint)) {
    return { reason: "flat", via: seenFingerprints.get(fingerprint), fingerprint };
  }
  const recent = recentChanges.get(changeKey(oldPriceCzk, newPriceCzk));
  if (recent && recent.source !== item.source && now - Date.parse(recent.at) <= CHANGE_WINDOW_MS) {
    return { reason: "change", via: recent.sourceLabel ?? recent.source };
  }
  return null;
}
