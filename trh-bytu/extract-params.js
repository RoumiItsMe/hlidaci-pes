// Dotažení PARAM_FIELDS (viz params.js) z VOLNÉHO TEXTU popisu — na rozdíl
// od detect-own-fields.js (vlastní hodnocení uživatele, appka je nikdy
// nedostane od portálu) jde tady o OBJEKTIVNÍ portálová data, která Sreality/
// Bezrealitky normálně dávají strukturovaně, ale ne vždy (viz reálný případ:
// sreality:479404108 má nativní `floorInfo: null`, ačkoli popis "1.
// nadzemním podlaží" říká) a Bazoš/iDNES/RealityMIX je strukturovaně
// nedávají nikdy. Volající (track.js) tohle používá jen jako ZÁCHRANNOU SÍŤ
// — nativní hodnota od portálu, když existuje, má vždy přednost (viz
// mergeExtractedParams).
//
// Pravidla vycházejí z reálných formulací v popisech (Bazoš/iDNES/Sreality),
// ne z odhadu: "bez výtahu", "Výtah: ne", "domu s výtahem", "K bytu náleží
// sklep o výměře 9 m²", "družstevní byt", "v OV", "3. NP", "ve 2. nadzemním
// podlaží"… Obecné pravidlo: appka tvrdí "Ne" jen tehdy, když to text řekne
// VÝSLOVNĚ ("bez výtahu"); nezmínění věci neznamená, že tam není.
//
// Regulární výrazy mají `u` a `\p{L}` místo `\b`/`\w` — `\b` v JS zná jen
// ASCII, takže u českých slov s diakritikou na okraji nesedí.

// ---------------------------------------------------------------- podlaží

// "N. nadzemní podlaží" (NP): 1. NP = přízemí (byt v úrovni terénu), 2. NP =
// 1. patro, 3. NP = 2. patro atd. — ověřeno na vzorku, kde to inzerát řekl
// OBOJÍ způsobem naráz ("3. nadzemním podlaží (2. patře)", "5. patře, tedy v
// 6. nadzemním podlaží"). Výstup má vždy obě čísla, viz formatFloor. Appka
// NEHÁDÁ celkový počet podlaží domu (text ho udává nekonzistentně — slovem,
// v závorce, nebo vůbec) — "1. patro (2. NP)" bez "z X" je pořád mnohem víc,
// než prázdné pole.
const NADZEMNI_PODLAZI_RE = /(\d+)\.\s*nadzemním?\s*podlaží/iu;

// Zkratka NP: "ve 3.NP", "v 1. NP", "umístění: 4. NP", "2NP".
const NP_RE = /(?<![\p{L}\d])(\d+)\s*\.?\s*NP(?![\p{L}])/iu;

// Slovní řadová čísla: "ve druhém podlaží", "ve třetím nadzemním podlaží".
const ORDINAL_WORDS = { prvním: 1, druhém: 2, třetím: 3, čtvrtém: 4, pátém: 5, šestém: 6, sedmém: 7, osmém: 8 };
const ORDINAL_PODLAZI_RE = /(?<![\p{L}])ve?\s+(prvním|druhém|třetím|čtvrtém|pátém|šestém|sedmém|osmém)\s+(?:nadzemním\s+)?podlaží/iu;
const ORDINAL_PATRO_RE = /(?<![\p{L}])ve?\s+(prvním|druhém|třetím|čtvrtém|pátém|šestém|sedmém|osmém)\s+patře/iu;

// "ve 2. podlaží" bez slova "nadzemní" — v inzerátech se tím myslí totéž co
// NP (1. podlaží = přízemí). Vyžaduje předložku, ať se nechytne "dům má 6
// podlaží".
const PODLAZI_RE = /(?<![\p{L}])ve?\s+(\d+)\.\s*podlaží/iu;

// Přímé označení patra ("Byt se nachází v 3 patře", "ve 2. patře") — na
// rozdíl od "N. nadzemní podlaží" výš tohle číslo UŽ je v číslování, na
// které je appka zvyklá z portálů (bez přepočtu -1). Vyžaduje předložku
// "v"/"ve" bezprostředně před číslem, ať se nechytí věta o CELKOVÉM počtu
// podlaží domu ("dům má 3 patra") — tu appka záměrně nehádá (viz komentář
// u NADZEMNI_PODLAZI_RE).
const PATRO_RE = /(?<![\p{L}])ve?\s+(\d+)\.?\s*patř/iu;

// Štítek "Podlaží: 2. patro" v přepsaném RK exportu.
const PATRO_LABEL_RE = /podlaží:\s*(\d+)\.?\s*patro/iu;

// Přízemí — na rozdíl od čísla patra appka NEVYŽADUJE předložku před slovem:
// dům "má" přízemí vždy, takže tu (na rozdíl od "3 patra" u čísel) není
// riziko splést celkový popis domu s pozicí KONKRÉTNÍHO bytu. Pokrývá i
// skloňované/odvozené tvary ("přízemní byt", "v přízemním patře") a
// předřazený přívlastek ("ve zvýšeném přízemí", "snížené přízemí") — appka
// jen hledá podřetězec "přízem", nerozebírá, jaký přesně tvar/pád to je.
// Zkouší se AŽ PO číslovaných označeních: "zahrádky u přízemních bytů" ve
// větě o domu není poloha tohohle bytu.
const PRIZEMI_RE = /(?<!\p{L})přízem/iu;

/**
 * Podlaží ve tvaru, který je jednoznačný: "1. patro (2. NP)", "Přízemí (1. NP)",
 * případně s počtem podlaží domu ("… z 4").
 *
 * Český úzus má dvě číslování a portály je míchají: "NP" (nadzemní podlaží)
 * počítá přízemí jako 1, "patro" přízemí nepočítá — 2. NP je 1. patro. Sreality
 * i Bezrealitky dávají číslo podlaží (NP) a appka ho dřív psala jako "patro",
 * zatímco z textu inzerátu převáděla na patro — v jedné tabulce tak seděla dvě
 * různá číslování a lišila se o jedno ("2. patro z 4" u Sreality vs. "1. patro"
 * z textu pro tentýž byt). Ověřeno na inzerátech, které mají strukturovaná data
 * i číslované podlaží v textu: číslo ze Sreality se rovná NP ve všech 17
 * případech a u čtyř bytů, o kterých text říká "přízemí", je nativně "1. patro".
 * Proto se vždy ukládají OBĚ čísla a nezáleží na tom, odkud pocházejí.
 */
export function formatFloor(np, total = null) {
  if (np < 0) return `Podzemní podlaží${total ? ` z ${total}` : ""}`; // suterén — číslování NP se na něj nevztahuje
  const level = Math.max(1, np);
  const label = level === 1 ? "Přízemí" : `${level - 1}. patro`;
  return `${label} (${level}. NP)${total ? ` z ${total}` : ""}`;
}

/**
 * Převod dříve uloženého tvaru ("2. patro z 4", "1. patro", "Přízemí z 3",
 * "Přízemí") na formatFloor. Starý tvar se SE slovem "z N" pochází z portálu
 * (číslo = NP), bez něj z textu (číslo = patro) — text nikdy počet podlaží
 * domu neuvádí. Cokoli jiného (už převedené, ručně napsané) vrací beze změny.
 */
export function upgradeLegacyFloor(value) {
  if (typeof value !== "string") return value;
  let m = value.match(/^(\d+)\. patro z (\d+)$/);
  if (m) return formatFloor(parseInt(m[1], 10), parseInt(m[2], 10));
  m = value.match(/^Přízemí z (\d+)$/);
  if (m) return formatFloor(1, parseInt(m[1], 10));
  m = value.match(/^(\d+)\. patro$/);
  if (m) return formatFloor(parseInt(m[1], 10) + 1);
  if (value === "Přízemí") return formatFloor(1);
  return value;
}

function parseFloorFromText(text) {
  if (!text) return null;
  const nadzemni = text.match(NADZEMNI_PODLAZI_RE);
  if (nadzemni) return formatFloor(parseInt(nadzemni[1], 10));
  const patro = text.match(PATRO_RE) || text.match(PATRO_LABEL_RE);
  if (patro) return formatFloor(parseInt(patro[1], 10) + 1); // "v 2. patře" = 3. NP
  const np = text.match(NP_RE);
  if (np) return formatFloor(parseInt(np[1], 10));
  const ordinalPodlazi = text.match(ORDINAL_PODLAZI_RE);
  if (ordinalPodlazi) return formatFloor(ORDINAL_WORDS[ordinalPodlazi[1].toLowerCase()]);
  const ordinalPatro = text.match(ORDINAL_PATRO_RE);
  if (ordinalPatro) return formatFloor(ORDINAL_WORDS[ordinalPatro[1].toLowerCase()] + 1);
  const podlazi = text.match(PODLAZI_RE);
  if (podlazi) return formatFloor(parseInt(podlazi[1], 10));
  if (PRIZEMI_RE.test(text)) return formatFloor(1);
  return null;
}

// ------------------------------------------------------------ plochy (m²)

// Text píše plochu s desetinnou ČÁRKOU ("3,10m2"), appka ji pro zápis do
// čísla nejdřív převede na tečku a zaokrouhlí na 1 des. místo (portálové
// údaje nebývají přesnější), pak pro ZOBRAZENÍ vrátí zpátky na českou
// čárku a zbytečnou nulu ("3,10" → "3,1") ořízne.
function formatArea(raw) {
  const num = parseFloat(raw.replace(",", "."));
  if (!Number.isFinite(num)) return null;
  const rounded = Math.round(num * 10) / 10;
  return String(rounded).replace(".", ",");
}

const AREA = String.raw`(\d+(?:[,.]\d+)?)\s*m\s*[²2]`;

// Ano/Ne + případná plocha, ve stejném tvaru jako nativní portálová data
// ("Ano (5 m²)", viz Sreality).
function yesWithArea(area) {
  const formatted = area ? formatArea(area) : null;
  return formatted ? `Ano (${formatted} m²)` : "Ano";
}

// Slovo, před kterým stojí kontext "stavební práce / společné části domu"
// ("zateplení sklepů", "okna ve sklepích", "sdílené balkóny") — taková zmínka
// neříká nic o TOMHLE bytě.
const COMMON_PARTS_CONTEXT_RE = /(?:zateplení|izolac\p{L}*|oprav\p{L}*|výměn\p{L}*|rekonstrukc\p{L}*|okna|společn\p{L}*|sdílen\p{L}*|vlhk\p{L}*)[^.\n;]{0,25}$/iu;

function inCommonPartsContext(text, index) {
  const before = text.slice(Math.max(0, index - 40), index);
  return COMMON_PARTS_CONTEXT_RE.test(before);
}

// Najde první zmínku slova mimo kontext společných částí domu.
function findOwnMention(text, wordRe) {
  const re = new RegExp(wordRe.source, wordRe.flags.includes("g") ? wordRe.flags : `${wordRe.flags}g`);
  for (const m of text.matchAll(re)) {
    if (!inCommonPartsContext(text, m.index)) return m;
  }
  return null;
}

// ------------------------------------------------------------------ sklep

const CELLAR_WORD = /(?<![\p{L}])sklep\p{L}*/iu;
// Zápor jen těsně u slova — "To není běžná malá sklepní kóje" (reálná věta z
// inzerátu o velkém sklepu) nesmí vyjít jako "bez sklepa".
const CELLAR_NO_RES = [
  /(?<![\p{L}])bez\s+sklep/iu,
  /(?<![\p{L}])sklep\p{L}*\s*[:\-–]\s*(?:ne|není)(?![\p{L}])/iu,
  /(?<![\p{L}])(?:nemá|není|nepatří|nenáleží)\s+(?:(?:zde|žádný|žádná)\s+)?sklep/iu,
];
// "sklep o výměře 9 m²", "Sklep: cca 5 m²", "sklepní kóje 3,10m2", "sklepem (1 m2)".
const CELLAR_AREA_AFTER_RE = new RegExp(String.raw`(?<![\p{L}])sklep\p{L}*(?:\s+k[oó]j\p{L}*)?[^.\n;,]{0,36}?${AREA}`, "iu");
// "9 m² sklep", "4 m² velká zděná sklepní kóje" — ale ne "55 m² včetně sklepa"
// (celková plocha) ani "63 m² + sklepní kóje" (plus mezi nimi).
const CELLAR_AREA_BEFORE_RE = new RegExp(String.raw`${AREA}\s+(?:(?!včetně|bez)\p{L}+\s+){0,2}?(?<![\p{L}])sklep\p{L}*`, "iu");
// Víc sklepů ("2 sklepy", "dva sklepní prostory"): plocha jednoho z nich by
// byla zavádějící, bere se jen úhrnná ("o celkové výměře").
const CELLAR_MULTI_RE = /(?<![\p{L}\d])(?:[2-9]|dva|dvě|dvou|tři)\s*[x×]?\s*(?:\p{L}+\s+)?sklep/iu;

function parseCellarFromText(text) {
  if (!text) return null;
  if (CELLAR_NO_RES.some((re) => re.test(text))) return "Ne";
  if (!findOwnMention(text, CELLAR_WORD)) return null;
  const after = text.match(CELLAR_AREA_AFTER_RE);
  const before = text.match(CELLAR_AREA_BEFORE_RE);
  const found = after || before;
  if (found && CELLAR_MULTI_RE.test(text) && !/celk/iu.test(found[0])) return "Ano";
  return yesWithArea(found?.[1]);
}

// -------------------------------------------------------------- vlastnictví

// Bazoš u části inzerátů (přepsaný RK export, viz reálný text "vlastnictví:
// Družstevní druh objektu: Panelová stav objektu: Dobrý…") přikládá na
// konec popisu strukturovaný blok stejných polí, jaké appka jinak čte jen
// ze Sreality/Bezrealitky JSON.
const OWNERSHIP_LABEL_RE = /vlastnictví:\s*(Osobní|Družstevní|Státní|Obecní)/iu;
const COOP_RE = /(?<![\p{L}])družstevn/iu;
const PERSONAL_RE = /(?<![\p{L}])osobní(?:m|ho)?\s+vlastnictví/iu;
// Zkratky "OV" / "DV" (např. titulek "Prodej bytu 2+1, OV, CP 57 m²") — jen
// velkými písmeny a jako samostatné slovo.
const PERSONAL_ABBR_RE = /(?<![\p{L}\d])OV(?![\p{L}\d])/u;
const COOP_ABBR_RE = /(?<![\p{L}\d])DV(?![\p{L}\d])/u;
// "družstevní vlastnictví s možností převodu do osobního" — byt je družstevní.
const COOP_TRANSFER_RE = /(?:převod\p{L}*|převést|přechod\p{L}*|možnost\p{L}*)[^.\n]{0,60}osobní|do\s+osobního/iu;

// Hodnoty se ukládají vždy v tvaru "Osobní"/"Družstevní" (jak je nabízí
// výběr v tabulce srovnání, viz PARAM_OVERRIDE_FIELDS) — dřív se ukládala
// přesně tak, jak byla v textu napsaná, takže "družstevní" malými písmeny
// ve výběru nesedělo na žádnou volbu a pole vypadalo prázdné.
export function normalizeOwnership(value) {
  if (!value) return null;
  const v = String(value).trim();
  return v ? v[0].toLocaleUpperCase("cs") + v.slice(1).toLocaleLowerCase("cs") : null;
}

function parseOwnershipFromText(text) {
  if (!text) return null;
  const label = text.match(OWNERSHIP_LABEL_RE);
  if (label) return normalizeOwnership(label[1]);
  const coop = COOP_RE.test(text) || COOP_ABBR_RE.test(text);
  const personal = PERSONAL_RE.test(text) || PERSONAL_ABBR_RE.test(text);
  if (coop && !personal) return "Družstevní";
  if (personal && !coop) return "Osobní";
  if (coop && personal) return COOP_TRANSFER_RE.test(text) ? "Družstevní" : null; // odporuje si — radši nic
  return null;
}

// ------------------------------------------------------------------- výtah

const ELEVATOR_NO_RES = [
  /(?<![\p{L}])bez\s+(?:osobního\s+)?výtah/iu,
  /(?<![\p{L}])(?:nemá|není|nejsou|chybí)\s+(?:(?:zde|žádný|dům|v\s+domě)\s+)?výtah/iu,
  /(?<![\p{L}])výtah\p{L}*\s*[:\-–]\s*(?:ne|není)(?![\p{L}])/iu,
  /(?<![\p{L}])výtah\s+(?:zde\s+|v\s+domě\s+)?(?:není|nemá)/iu,
];
const ELEVATOR_WORD = /(?<![\p{L}])výtah\p{L}*/iu;
// "možnost instalace výtahu", "plánovaný výtah" — výtah tam zatím není.
const ELEVATOR_FUTURE_RE = /(?:možnost\p{L}*|plánovan\p{L}*|připravuj\p{L}*|bude|budoucn\p{L}*)[^.\n;]{0,30}$/iu;

function parseElevatorFromText(text) {
  if (!text) return null;
  if (ELEVATOR_NO_RES.some((re) => re.test(text))) return "Ne";
  const re = new RegExp(ELEVATOR_WORD.source, "giu");
  for (const m of text.matchAll(re)) {
    if (!ELEVATOR_FUTURE_RE.test(text.slice(Math.max(0, m.index - 45), m.index))) return "Ano";
  }
  return null;
}

// --------------------------------------------------- balkon, lodžie, terasa

// Jen jednotné číslo ("balkon", "balkónem") — "balkonové dveře", "nové
// balkóny" jsou stavební práce na domě, ne informace o bytu.
const AMENITIES = {
  balcony: { word: /(?<![\p{L}])balk[oó]n(?:em|u)?(?![\p{L}])/iu, no: /(?<![\p{L}])bez\s+balk[oó]n/iu },
  loggia: { word: /(?<![\p{L}])lodži[ieíě]?(?![\p{L}])/iu, no: /(?<![\p{L}])bez\s+lodži/iu },
  terrace: { word: /(?<![\p{L}])teras(?:a|u|ou)(?![\p{L}])/iu, no: /(?<![\p{L}])bez\s+teras/iu },
};

function parseAmenityFromText(text, { word, no }) {
  if (!text) return null;
  if (no.test(text)) return "Ne";
  const mention = findOwnMention(text, word);
  if (!mention) return null;
  // Plocha hned za slovem ("balkón o ploše 6 m²"), v téže větě.
  const rest = text.slice(mention.index, mention.index + 80);
  const area = rest.match(new RegExp(String.raw`^[^.\n;,]{0,32}?${AREA}`, "iu"));
  return yesWithArea(area?.[1]);
}

/**
 * Dotáhne PARAM_FIELDS z titulku+popisu (v tomto pořadí zdrojů — titulek
 * bývá kratší, ale popis říká skoro vždy víc): patro, výtah, sklep,
 * balkon/lodžii/terasu a vlastnictví. Vrací objekt jen s klíči, které se
 * podařilo najít — appka si prázdné pole nevymýšlí.
 */
export function extractParamsFromText(title, description) {
  const text = `${title || ""} ${description || ""}`;
  const result = {};
  const set = (key, value) => {
    if (value != null) result[key] = value;
  };
  set("floorInfo", parseFloorFromText(text));
  set("elevator", parseElevatorFromText(text));
  set("cellar", parseCellarFromText(text));
  set("ownership", parseOwnershipFromText(text));
  for (const [key, spec] of Object.entries(AMENITIES)) set(key, parseAmenityFromText(text, spec));
  return result;
}

/**
 * Sloučí text-extrahovaná pole (viz výš) s NATIVNÍMI portálovými parametry
 * (Sreality/Bezrealitky JSON) — nativní hodnota vyhrává VŽDY, když skutečně
 * něco říká. Portál ale běžně vrací klíč s hodnotou `null` (pole ve
 * formuláři inzerce nevyplněné), ne že by klíč úplně chyběl — obyčejné
 * `{ ...extracted, ...native }` by takovým `null` přepsalo i to, co appka
 * sama vytěžila z textu (reálný případ: sreality:479404108 má nativně
 * `floorInfo: null`, popis přitom patro říká). Proto se `native` prochází
 * ručně a přebíjí jen tam, kde má hodnotu.
 */
export function mergeExtractedParams(extracted, native) {
  const merged = { ...extracted };
  for (const [key, value] of Object.entries(native || {})) {
    if (value == null) continue;
    // Výjimka: "Ne" u vybavení znamená u Sreality/Bezrealitek jen NEZAŠKRTNUTÉ
    // políčko, ne popření — prodejce píše "K bytu náleží sklep" a políčko
    // nechá prázdné (naměřeno: u všech ~10 takových rozporů pravdu měl text,
    // např. "sklep o ploše 2,52 m²" při nativním "Ne"). Výslovně pozitivní
    // zmínka v textu proto "Ne" přebíjí; naopak nativní "Ano" text nepřebije.
    if (value === "Ne" && AMENITY_KEYS.has(key) && /^Ano/.test(extracted?.[key] ?? "")) continue;
    merged[key] = value;
  }
  return merged;
}

const AMENITY_KEYS = new Set(["cellar", "balcony", "loggia", "terrace"]);
