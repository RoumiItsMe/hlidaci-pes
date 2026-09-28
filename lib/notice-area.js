// Výměra pozemku z textu oznámení ("o výměře 1 276 m2", "výměra 620 m²",
// "0,5 ha"). Čistá funkce bez sítě — filtr úředních desek podle ní vyřazuje
// drobné pozemky (viz lib/notice-enrich.js).
//
// Bere se jen číslo, za kterým hned stojí jednotka (m2 / m² / ha), takže
// čísla parcel ("1080/36"), paragrafů ("250/2023 Sb.") ani ceny nevadí.
// Když je v textu víc výměr (víc parcel, nebo parcela + zastavěná plocha),
// vrací se ta NEJVĚTŠÍ — rozhoduje, jestli je v oznámení aspoň něco většího
// než limit, ne součet.

// Česky se tisíce oddělují mezerou ("1 276"), často nezlomitelnou.
const AREA_RE = /(\d{1,3}(?:[\s ]\d{3})+|\d+)(?:,(\d+))?\s*(m2|ha)(?![a-z0-9])/g;

/** Text bez diakritiky, malými písmeny a s "m²" zapsaným jako "m2". */
function normalize(text) {
  return (text ?? "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");
}

/**
 * Největší výměra zmíněná v textu v m², nebo `null`, když v něm žádná není.
 */
export function extractAreaM2(text) {
  let max = null;
  for (const m of normalize(text).matchAll(AREA_RE)) {
    const whole = Number(m[1].replace(/[\s ]/g, ""));
    const value = Number(`${whole}.${m[2] ?? "0"}`) * (m[3] === "ha" ? 10_000 : 1);
    if (Number.isFinite(value) && (max === null || value > max)) max = value;
  }
  return max;
}

/** "1276" → "1 276" (nezlomitelná mezera, ať se číslo v Telegramu nerozdělí). */
export function formatAreaM2(value) {
  return Math.round(value).toLocaleString("cs-CZ");
}
