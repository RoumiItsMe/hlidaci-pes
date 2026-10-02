// Dotažení PARAM_FIELDS (viz params.js) z VOLNÉHO TEXTU popisu — na rozdíl
// od detect-own-fields.js (vlastní hodnocení uživatele, appka je nikdy
// nedostane od portálu) jde tady o OBJEKTIVNÍ portálová data, která Sreality/
// Bezrealitky normálně dávají strukturovaně, ale ne vždy (viz reálný případ:
// sreality:479404108 má nativní `floorInfo: null`, ačkoli popis "1.
// nadzemním podlaží" říká) a Bazoš/iDNES/RealityMIX je strukturovaně
// nedávají nikdy. Volající (track.js) tohle používá jen jako ZÁCHRANNOU SÍŤ
// — nativní hodnota od portálu, když existuje, má vždy přednost (viz
// mergeExtractedParams).

// "N. nadzemní podlaží" → patro v číslování, na které je appka/uživatel
// zvyklí z portálů ("1. patro", "2. patro"…): 1. NP = přízemí (byt v úrovni
// terénu), 2. NP = 1. patro, 3. NP = 2. patro atd. — ověřeno na vzorku, kde
// to inzerát řekl OBOJÍ způsobem naráz ("3. nadzemním podlaží (2. patře)",
// "5. patře, tedy v 6. nadzemním podlaží"). Appka NEHÁDÁ celkový počet
// podlaží domu (text ho udává nekonzistentně — slovem, v závorce, nebo
// vůbec) — "1. patro" bez "z X" je pořád mnohem víc, než prázdné pole.
const NADZEMNI_PODLAZI_RE = /(\d+)\.\s*nadzemním?\s*podlaží/i;

// Přímé označení patra ("Byt se nachází v 3 patře", "ve 2. patře") — na
// rozdíl od "N. nadzemní podlaží" výš tohle číslo UŽ je v číslování, na
// které je appka zvyklá z portálů (bez přepočtu -1). Vyžaduje předložku
// "v"/"ve" bezprostředně před číslem, ať se nechytí věta o CELKOVÉM počtu
// podlaží domu ("dům má 3 patra") — tu appka záměrně nehádá (viz komentář
// u NADZEMNI_PODLAZI_RE).
const PATRO_RE = /\bve?\s+(\d+)\.?\s*patř/i;

// Přízemí — na rozdíl od čísla patra appka NEVYŽADUJE předložku před slovem:
// dům "má" přízemí vždy, takže tu (na rozdíl od "3 patra" u čísel) není
// riziko splést celkový popis domu s pozicí KONKRÉTNÍHO bytu. Pokrývá i
// skloňované/odvozené tvary ("přízemní byt", "v přízemním patře") a
// předřazený přívlastek ("ve zvýšeném přízemí", "snížené přízemí") — appka
// jen hledá podřetězec "přízem", nerozebírá, jaký přesně tvar/pád to je.
// `\p{L}` (ne `\b`/`\w`) kvůli diakritice — obyčejné `\b` v JS zná jen
// ASCII [A-Za-z0-9_], takže za "í" na konci slova vůbec nesepne a předchozí
// přísnější varianta (`\bv\s+přízemí\b`) kvůli tomu tiše propadala i na
// přímém "v přízemí domu".
const PRIZEMI_RE = /(?<!\p{L})přízem/iu;

function parseFloorFromText(text) {
  if (PRIZEMI_RE.test(text || "")) return "Přízemí";
  const nadzemni = text?.match(NADZEMNI_PODLAZI_RE);
  if (nadzemni) {
    const np = parseInt(nadzemni[1], 10);
    return np === 1 ? "Přízemí" : `${np - 1}. patro`;
  }
  const patro = text?.match(PATRO_RE);
  if (patro) {
    const n = parseInt(patro[1], 10);
    return n === 0 ? "Přízemí" : `${n}. patro`;
  }
  return null;
}

// "Sklepní kóje 3,10m2" / "sklepní kója o velikosti 5 m²" → "Ano (X m²)",
// stejný formát jako nativní portálová data (viz sreality "Ano (5 m²)").
// Bez plochy, jen počet ("2 sklepy") → "Ano" bez plochy — appka si číslo
// nevymýšlí. Nikdy "Ne": nezmínění sklepa neznamená, že sklep není.
const CELLAR_AREA_RE = /sklep(?:ní|em)?\s*k[oó]j[ei]?\s*(?:o\s*(?:velikosti|ploše|rozměrech)\s*)?(\d+(?:[,.]\d+)?)\s*m[²2]/i;
const CELLAR_COUNT_RE = /(\d+)\s*sklep(?:y|ů)?\b/i;

// Text píše plochu s desetinnou ČÁRKOU ("3,10m2"), appka ji pro zápis do
// čísla nejdřív převede na tečku a zaokrouhlí na 1 des. místo (portálové
// údaje nebývají přesnější), pak pro ZOBRAZENÍ vrátí zpátky na českou
// čárku a zbytečnou nulu ("3,10" → "3,1") ořízne.
function formatCellarArea(raw) {
  const num = parseFloat(raw.replace(",", "."));
  if (!Number.isFinite(num)) return null;
  const rounded = Math.round(num * 10) / 10;
  return String(rounded).replace(".", ",");
}

function parseCellarFromText(text) {
  if (!text) return null;
  const areaMatch = text.match(CELLAR_AREA_RE);
  if (areaMatch) {
    const area = formatCellarArea(areaMatch[1]);
    if (area != null) return `Ano (${area} m²)`;
  }
  return CELLAR_COUNT_RE.test(text) ? "Ano" : null;
}

// Bazoš u části inzerátů (přepsaný RK export, viz reálný text "vlastnictví:
// Družstevní druh objektu: Panelová stav objektu: Dobrý…") přikládá na
// konec popisu strukturovaný blok stejných polí, jaké appka jinak čte jen
// ze Sreality/Bezrealitky JSON. Vlastnictví z něj appka zatím nečte vůbec.
const OWNERSHIP_RE = /vlastnictví:\s*(Osobní|Družstevní|Státní|Obecní)/i;

function parseOwnershipFromText(text) {
  const m = text?.match(OWNERSHIP_RE);
  return m ? m[1] : null;
}

/**
 * Dotáhne floorInfo/cellar/ownership z titulku+popisu (v tomto pořadí
 * zdrojů — titulek bývá kratší, ale popis říká skoro vždy víc). Vrací
 * objekt jen s klíči, které se podařilo najít — appka si prázdné pole
 * nevymýšlí.
 */
export function extractParamsFromText(title, description) {
  const text = `${title || ""} ${description || ""}`;
  const result = {};
  const floorInfo = parseFloorFromText(text);
  if (floorInfo != null) result.floorInfo = floorInfo;
  const cellar = parseCellarFromText(text);
  if (cellar != null) result.cellar = cellar;
  const ownership = parseOwnershipFromText(text);
  if (ownership != null) result.ownership = ownership;
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
    if (value != null) merged[key] = value;
  }
  return merged;
}
