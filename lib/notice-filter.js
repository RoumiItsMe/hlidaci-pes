// Filtr oznámení z úředních desek: vybere jen ta, o kterých chce uživatel
// vědět — prodej bytu, dražba/aukce, prodej domu či jiné nemovitosti.
//
// Čistá funkce nad textem (bez sítě), ať jde snadno ladit nad reálnými
// oznámeními (viz scripts/check-boards.js).
//
// Co se ZÁMĚRNĚ nehlásí (na úředních deskách je to většina "majetkových"
// oznámení, ověřeno nad živými deskami všech pěti obcí):
//  - pronájem / výpůjčka / směna (i "Vyhlášení bytu k pronájmu" — nájem
//    obecního bytu není prodej),
//  - prodej samotného pozemku (nejčastější oznámení, ale není to byt ani dům).
//
// Úrovně (od nejzajímavější):
//  A "flat"    — prodej bytu / bytové jednotky (i bytového domu)
//  B "auction" — dražba či aukce (exekutorská, ÚZSVM, …), kromě dražby čistě
//                movitých věcí; v titulku se z dražby nemovitých věcí často
//                nepozná, jestli je v ní byt, proto se hlásí všechny
//  C "house"   — prodej domu, budovy, objektu, areálu, "nemovitosti"
//  D "unknown" — krátký nic neříkající název (typicky "Vyhláška č. 190")
//                v kategorii věnované prodejům/aukcím — z titulku nepoznáme,
//                čeho se týká, ale kategorie napovídá, že jde o prodej majetku
//
// Text se před porovnáním zbaví diakritiky a velkých písmen — "Bytů",
// "BYTU" i "bytu" pak dají totéž a čeština se skloňuje jen v koncovkách,
// které regulární výrazy níž pokrývají.

/** Malá písmena bez diakritiky. */
export function fold(text) {
  return (text ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

// Regulární výrazy jsou zapsané jako ŘETĚZCE (ne RegExp), protože `near()`
// je skládá do větších výrazů. `\b` jen na začátku slova: "byt" nesmí
// chytit "nebytový" (nebytový prostor není byt) ani "kobyt…".

// Prodej. "prodejn*" (prodejna, prodejní) je obchod, ne prodej — a v titulku
// stavebního povolení ("úpravy prodejny") by jinak vznikl planý poplach.
const SALE = String.raw`\b(?:prodej(?!n)\w*|prodat|prodava\w*|odprodej\w*|zcizen\w*|zcizit|privatizac\w*|koupe\b|koupit|kupn\w*|vyprodej\w*)`;

// Byt: "byt", "bytu", "bytů", "byty", "byt." (zkratka) a bytový/bytová/bytové…
const FLAT = String.raw`\bbyt(?:u|y|em|ech|ove\w*|ova\w*|ovy\w*|ovou)?\b`;

// Dům/budova/objekt/areál jako předmět prodeje. "č.p." samotné se nebere
// (bývá jen upřesnění polohy: "pozemek u domu čp. 133").
const HOUSE = String.raw`\b(?:dum|domu|domy|domek|domku|domech|budov\w*|objekt\w*|areal\w*)\b`;

// Obecné "nemovitost / nemovité věci" — u samotného pozemku se říká úplně
// stejně ("Záměr prodeje nemovitých věcí — pozemků"), proto se bere jen
// tehdy, když v textu není zmínka o pozemku (viz classifyNotice).
const REAL_ESTATE = String.raw`\bnemovit\w*`;

const RENT_RE = /\b(?:pronaj\w*|najem\w*|najm\w*|pacht\w*|vypujck\w*|podnajm\w*)/;
const SWAP_GIFT_RE = /\b(?:smen\w*|darov\w*|dar\b)/;
const LAND_RE = /\b(?:pozem\w*|ppc\b|parc\w*|p\.\s?p\.\s?c)/;
const AUCTION_RE = /\b(?:draz(?:b|eb)\w*|aukc\w*)/;
const MOVABLE_RE = /\bmovit\w*/; // "movité" — díky \b nechytí "nemovité"
const IMMOVABLE_RE = /\b(?:nemovit\w*|pozem\w*|budov\w*|dum\b|domu\b|domek|byt\b|bytu\b|jednotk\w*|stavb\w*)/;

// Kategorie desky, která je vyhrazená prodejům/aukcím/majetku obce.
const SALE_CATEGORY_RE = /prodej|aukc|drazb|majetk/;

/**
 * Jsou obě slova (výrazy) v textu nejvýš `maxGap` slov od sebe, v libovolném
 * pořadí? — "prodej bytu", "byt k prodeji", "záměr města prodat byt".
 * Blízkost je důležitá: "prodej pozemku u bytového domu" nemá být prodej
 * bytu — proto se navíc mezi slovy nesmí objevit pozemek (prodává se ten,
 * byt je jen upřesnění polohy).
 */
function near(text, a, b, maxGap = 4) {
  const gap = String.raw`((?:\W+\w+){0,${maxGap}}?)\W+`;
  const re = new RegExp(`(?:${a})${gap}(?:${b})|(?:${b})${gap}(?:${a})`, "g");
  for (const m of text.matchAll(re)) {
    const between = m[1] ?? m[2] ?? "";
    if (!LAND_RE.test(between)) return true;
  }
  return false;
}

/**
 * Rozhodne, jestli oznámení stojí za upozornění.
 * `notice` = `{ title, description?, category? }` (viz sources/uredni-desky.js).
 * Vrací `null` (nezajímavé) nebo `{ kind, mentionsFlat }`,
 * kde `kind` je "flat" | "auction" | "house" | "unknown".
 */
export function classifyNotice({ title, description = "", category = "" }) {
  const text = fold(`${title} ${description}`);
  const cat = fold(category);

  const isRent = RENT_RE.test(text);
  const hasSaleWord = new RegExp(SALE).test(text);
  const mentionsFlat = new RegExp(FLAT).test(text);
  const hasLand = LAND_RE.test(text);

  // B: dražba / aukce. Čistě movité věci (auto, vybavení) jsou mimo.
  if (AUCTION_RE.test(text)) {
    const onlyMovables = MOVABLE_RE.test(text) && !IMMOVABLE_RE.test(text);
    if (!onlyMovables) return { kind: "auction", mentionsFlat };
  }

  // A: prodej bytu. Prodejní slovo musí být u bytu (viz near). Pronájem bytu
  // se bere, jen když se výslovně píše i o prodeji ("pronájem nebo prodej").
  if (near(text, SALE, FLAT) && (!isRent || hasSaleWord)) {
    return { kind: "flat", mentionsFlat: true };
  }
  // Byt v kategorii prodejů bez prodejního slova v titulku ("Byt č. 5, čp. 12").
  if (mentionsFlat && SALE_CATEGORY_RE.test(cat) && !isRent && !hasLand) {
    return { kind: "flat", mentionsFlat: true };
  }

  // C: prodej domu / budovy / objektu; obecná "nemovitost" jen bez pozemku.
  if (near(text, SALE, HOUSE)) return { kind: "house", mentionsFlat };
  if (near(text, SALE, REAL_ESTATE) && !hasLand) return { kind: "house", mentionsFlat };

  // D: nic neříkající krátký název v kategorii prodejů/aukcí.
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  if (SALE_CATEGORY_RE.test(cat) && wordCount <= 4 && !isRent && !hasLand && !SWAP_GIFT_RE.test(text)) {
    return { kind: "unknown", mentionsFlat };
  }

  return null;
}
