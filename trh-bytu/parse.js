// Sdílené parsování dispozice a plochy z titulku inzerátu. Všech 5 portálů
// dává dispozici i m² přímo do titulku (ověřeno naostro na reálném vzorku
// z každého zdroje — viz komentáře níže), takže tohle funguje univerzálně
// bez ohledu na zdroj a nepotřebuje detail stránku:
//   Sreality:    "Prodej bytu 2+1 70 m²"
//   Bezrealitky: "1+1 • 39 m²"
//   iDNES:       "prodej bytu 2+1 70 m²"
//   RealityMIX:  "Prodej bytu, 4+kk, 155 m²"
//   Bazoš:       "Prodej bytu 3+1, 67 m², Ústí nad Orlicí, ul. Quido Kociana"

const DISPOSITION_RE = /(\d)\s*\+\s*(kk|\d)/i;
const AREA_M2_RE = /(\d+(?:[.,]\d+)?)\s*m[²2]/i;

/** Vrátí dispozici jako "2+1"/"4+kk", nebo null když titulek nic takového neobsahuje. */
export function parseDisposition(title) {
  const m = title?.match(DISPOSITION_RE);
  if (!m) return null;
  return `${m[1]}+${m[2].toLowerCase()}`;
}

/** Vrátí plochu v m² jako číslo, nebo null. */
export function parseAreaM2(title) {
  const m = title?.match(AREA_M2_RE);
  if (!m) return null;
  const val = parseFloat(m[1].replace(",", "."));
  return Number.isFinite(val) ? val : null;
}
