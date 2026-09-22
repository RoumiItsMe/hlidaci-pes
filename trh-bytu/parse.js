// Sdílené parsování dispozice/plochy/ceny/lokality z VOLNÉHO TEXTU —
// funkce berou libovolný text, ne jen titulek. Primárně se volají na
// titulek inzerátu (všech 5 portálů dává dispozici i m² přímo do něj,
// ověřeno naostro na reálném vzorku z každého zdroje):
//   Sreality:    "Prodej bytu 2+1 70 m²"
//   Bezrealitky: "1+1 • 39 m²"
//   iDNES:       "prodej bytu 2+1 70 m²"
//   RealityMIX:  "Prodej bytu, 4+kk, 155 m²"
//   Bazoš:       "Prodej bytu 3+1, 67 m², Ústí nad Orlicí, ul. Quido Kociana"
// Když titulek pole nemá (kratší/neformátované titulky, hlavně Bazoš a
// RealityMIX), track.js zavolá TYTÉŽ funkce znovu na popis z detailu —
// ten dispozici/plochu skoro vždy zmiňuje taky, viz reálný příklad níže.

const DISPOSITION_RE = /(\d)\s*\+\s*(kk|\d)/i;
const AREA_M2_RE = /(\d+(?:[.,]\d+)?)\s*m[²2]/i;

/** Vrátí dispozici jako "2+1"/"4+kk", nebo null když text nic takového neobsahuje. */
export function parseDisposition(text) {
  const m = text?.match(DISPOSITION_RE);
  if (!m) return null;
  return `${m[1]}+${m[2].toLowerCase()}`;
}

/** Vrátí plochu v m² jako číslo, nebo null. */
export function parseAreaM2(text) {
  const m = text?.match(AREA_M2_RE);
  if (!m) return null;
  const val = parseFloat(m[1].replace(",", "."));
  return Number.isFinite(val) ? val : null;
}

// Záchranná síť pro cenu — když ji portál u samotné nabídky nedal (typicky
// "Cena na vyžádání"/"Dohodou"), popis stejně často konkrétní číslo
// zmiňuje, viz reálný příklad ze Sreality: "...Cena: 3.950.000 Kč..."
// (tečky jako oddělovač tisíců, ne jen mezery — proto se ze shody prostě
// odstraní všechno, co není číslice). Dolní mez 300 000 Kč je pojistka
// proti omylem chycené ceně "za m²" (desítky tisíc) místo celkové ceny
// bytu (statisíce/miliony) — byt levnější než 300 tis. Kč se v regionu
// nevyskytuje.
const PRICE_IN_TEXT_RE = /cena\s*:?\s*([\d][\d.,\s]{3,}\d)\s*k[čc]/i;

/** Vytáhne zmínku ceny z volného textu (viz komentář výš), nebo null. */
export function parsePriceFromDescription(text) {
  const m = text?.match(PRICE_IN_TEXT_RE);
  if (!m) return null;
  const digits = m[1].replace(/[^\d]/g, "");
  if (!digits) return null;
  const val = parseInt(digits, 10);
  return Number.isFinite(val) && val >= 300_000 ? val : null;
}

/**
 * Poslední záchranná síť pro adresu — když ji nedal ani portál, ani
 * titulek (viz parseAddressFromTitle), zkusí v textu najít aspoň JMÉNO
 * sledovaného města (ze stejné konfigurace jako watch "byty" v
 * config.js). Ne přesná adresa, ale "aspoň víme, kde to je" — přesně to,
 * co uživatel chtěl u nabídek, které jinak žádnou adresu vůbec nemají.
 */
export function findKnownPlace(text, watch) {
  if (!text) return null;
  for (const loc of watch.locations) {
    if (text.includes(loc.label)) return loc.label;
  }
  return null;
}

// Bazoš nemá samostatné pole s adresou (na rozdíl od ostatních 4 portálů) —
// lokalita, a často i ulice, bývá připsaná na konci titulku hned za
// plochou, např. "... 67 m², Ústí nad Orlicí, ul. Quido Kociana". Použije
// se jen jako záchranná síť, když portál žádnou adresu nedal — ne každý
// Bazoš titulek ten formát dodrží (řada nemá vůbec lokalitu v titulku), pak
// zůstává null (fail-soft, žádná nabídka kvůli tomu nezmizí).
const ADDRESS_AFTER_AREA_RE = /m[²2]\s*,\s*(.+)$/i;

/** Vytáhne lokalitu/adresu z konce titulku (viz komentář výš), nebo null. */
export function parseAddressFromTitle(title) {
  const m = title?.match(ADDRESS_AFTER_AREA_RE);
  return m ? m[1].trim() : null;
}
