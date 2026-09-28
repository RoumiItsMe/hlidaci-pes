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
//                nepozná, jestli je v ní byt, proto se hlásí všechny. Dražba
//                jen pozemku (`landOnly`) se dál zužuje podle výměry, viz
//                lib/notice-enrich.js.
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

// Dražba, jejíž název nic neříká ("16E8-26 PDF 1.9 MB"), ale text přílohy ano:
// v záhlaví stojí "dražební/aukční vyhláška", "oznámení o (konání) dražby"
// nebo "dražební rok". Záhlaví exekutorské vyhlášky je dlouhé (adresy, strany
// řízení), proto se čte úsek AUCTION_HEAD_CHARS znaků. Holé slovo "dražba"
// nestačí — zmiňují ho i zápisy ze zastupitelstva.
const AUCTION_HEAD_RE = /\b(?:drazebni|aukcni)\s+vyhlas\w+|\bdrazebni\s+rok\b|\boznameni\s+o\s+(?:konani\s+)?drazb/;
const AUCTION_HEAD_CHARS = 2500;

// Kategorie desky, která je vyhrazená prodejům/aukcím/majetku obce.
const SALE_CATEGORY_RE = /prodej|aukc|drazb|majetk/;

/**
 * Jsou obě slova (výrazy) v textu nejvýš `maxGap` slov od sebe, v libovolném
 * pořadí? — "prodej bytu", "byt k prodeji", "záměr města prodat byt".
 * Blízkost je důležitá: "prodej pozemku u bytového domu" nemá být prodej
 * bytu — proto se navíc mezi slovy nesmí objevit pozemek (prodává se ten,
 * byt je jen upřesnění polohy).
 */
function near(text, a, b, maxGap = 4, blockLand = true) {
  const gap = String.raw`((?:\W+\w+){0,${maxGap}}?)\W+`;
  const re = new RegExp(`(?:${a})${gap}(?:${b})|(?:${b})${gap}(?:${a})`, "g");
  for (const m of text.matchAll(re)) {
    const between = m[1] ?? m[2] ?? "";
    if (!blockLand || !LAND_RE.test(between)) return true;
  }
  return false;
}

/**
 * Rozhodne, jestli oznámení stojí za upozornění.
 * `notice` = `{ title, description?, category?, tags? }` (viz
 * sources/uredni-desky.js). `tags` jsou štítky agregátoru edesky.cz, který
 * dokumenty třídí podle OBSAHU příloh — tag "Dražby" zachytí dražbu, jejíž
 * název nic neříká ("16E8-26 PDF 1.9 MB").
 * Vrací `null` (nezajímavé) nebo `{ kind, mentionsFlat, landOnly? }`,
 * kde `kind` je "flat" | "auction" | "house" | "unknown" a `landOnly` (jen u
 * dražeb) říká, že se z textu zdá jít čistě o pozemek.
 */
export function classifyNotice({ title, description = "", category = "", tags = [], attachmentText = "" }) {
  const text = fold(`${title} ${description}`);
  const cat = fold(category);
  // Záhlaví přílohy (viz AUCTION_HEAD_RE) — jen pro poznání dražby, ne pro byty
  // a domy: v zápisu ze zastupitelstva se běžně mluví o prodeji čehokoli.
  const head = fold(attachmentText.slice(0, AUCTION_HEAD_CHARS));

  const isRent = RENT_RE.test(text);
  const hasSaleWord = new RegExp(SALE).test(text);
  const mentionsFlat = new RegExp(FLAT).test(text);
  const hasLand = LAND_RE.test(text);

  // B: dražba / aukce. Čistě movité věci (auto, vybavení) jsou mimo, stejně
  // jako dražba NÁJMU ("Dražba nájmu bytu", "pronájem … formou dražby" — kdo víc
  // nabídne, ten bydlí, nic se neprodává). Nájem se bere jako předmět dražby,
  // jen když stojí těsně u slova dražba a titulek neříká nic o prodeji.
  const isAuction = AUCTION_RE.test(text) || tags.includes("Dražby") || AUCTION_HEAD_RE.test(head);
  const isRentalAuction = !hasSaleWord && near(text, AUCTION_RE.source, RENT_RE.source, 2, false);
  if (isAuction && !isRentalAuction) {
    const onlyMovables = MOVABLE_RE.test(text) && !IMMOVABLE_RE.test(text);
    if (!onlyMovables) {
      const landOnly = hasLand && !mentionsFlat && !new RegExp(HOUSE).test(text);
      return { kind: "auction", mentionsFlat, landOnly };
    }
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
