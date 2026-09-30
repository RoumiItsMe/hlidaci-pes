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

// Dvě větve schválně NEsymetrické: mezi dvěma ČÍSLICEMI ("2+1") musí být
// doslovné "+", jinak by "28" (plocha, cena, cokoliv) omylem vypadalo jako
// dispozice "2+8" — číslice vedle sebe jsou v realitním textu běžné, "+"
// mezi nimi ne. Před "kk" je "+" naopak VOLITELNÉ ("1kk" i "1+kk") — realitky
// píšou "1+kk", soukromí inzerenti na Bazoši častěji "1kk" bez plusu (reálný
// případ: "Byt 1kk 28m2"); "kk" samo o sobě je dost specifický řetězec, že
// nehrozí omylem chycený jiný text.
const DISPOSITION_RE = /(\d)\s*\+\s*(\d)|(\d)\s*\+?\s*(kk)\b/i;
const AREA_M2_RE = /(\d+(?:[.,]\d+)?)\s*m[²2]/i;

// "Garsonka"/"garsoniéra" (a jejich skloněné tvary — garsonku, garsonky,
// garsoniéru...) je slovní název dispozice, ne číselný zápis — realitky ho
// běžně používají MÍSTO "1+kk", ne vedle něj (reálný případ: "Prodej
// garsonky se zahradou v České Třebové" na Bazoši je TENTÝŽ byt jako
// "1+kk" na Sreality/iDNES — stejná cena, stejná plocha, stejný popis).
// Bez rozpoznání by appka takový byt nesloučila s jeho verzí na jiném
// portálu (sloučení vyžaduje shodnou dispozici, viz group.js) a preferovaný
// zdroj (Sreality) by se nikdy nepoužil. Obě slova sdílí stejný základ
// "garson", stačí jeden regex na obě varianty i jejich pády.
const GARSONKA_RE = /garson/i;

/** Vrátí dispozici jako "2+1"/"4+kk", nebo null když text nic takového neobsahuje. */
export function parseDisposition(text) {
  if (!text) return null;
  const m = text.match(DISPOSITION_RE);
  if (m) {
    const num = m[1] ?? m[3];
    const suffix = m[2] ?? m[4];
    return `${num}+${suffix.toLowerCase()}`;
  }
  return GARSONKA_RE.test(text) ? "1+kk" : null;
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
//
// Rozpoznávané tvary: "Cena: 3.950.000 Kč", "za cenu 2 990 000kč",
// "prodejní cena 4 200 000,- Kč", "cena k jednání 3 400 000 Kč", "cena
// 3500000 Kč" a "cena 3,5 mil. Kč" — vždy slovo "cena" (v libovolném
// pádu) a do 25 znaků za ním částka s Kč / ,- / CZK / mil. Částka bez
// "cena" před sebou (kauce, poplatky, splátky) se záměrně neberou.
const PRICE_IN_TEXT_RE = /cen(?:a|u|ě|y|ou)[^\d\n]{0,25}?(\d{1,3}(?:[ . ]\d{3}){1,2}|\d{6,8})\s*(?:,-|kč|kc|czk)/gi;
const PRICE_MILLIONS_RE = /cen(?:a|u|ě|y|ou)[^\d\n]{0,25}?(\d{1,2}(?:[,.]\d{1,2})?)\s*mil/gi;
const MIN_PLAUSIBLE_PRICE_CZK = 300_000;

/** Vytáhne zmínku ceny z volného textu (viz komentář výš), nebo null. */
export function parsePriceFromDescription(text) {
  if (!text) return null;
  for (const m of text.matchAll(PRICE_IN_TEXT_RE)) {
    const val = parseInt(m[1].replace(/[^\d]/g, ""), 10);
    if (Number.isFinite(val) && val >= MIN_PLAUSIBLE_PRICE_CZK) return val;
  }
  for (const m of text.matchAll(PRICE_MILLIONS_RE)) {
    const val = Math.round(parseFloat(m[1].replace(",", ".")) * 1_000_000);
    if (Number.isFinite(val) && val >= MIN_PLAUSIBLE_PRICE_CZK) return val;
  }
  return null;
}

// Bazoš připisuje k titulku inzerátu bez číselné ceny její slovní podobu:
// "Prodej bytu 3+1, Letohrad: Dohodou", "...: Nabídněte", "...: V textu",
// "...: Zdarma". Je to jediný portál, který u ceny bez čísla řekne víc než
// "na vyžádání" — appka to ukazuje v přehledu, ať je jasné, že cenu
// portál neuvádí (a jak ji inzerent popisuje), a z adresy se to odstraňuje
// (dovětek by jinak skončil v "adrese").
const PRICE_NOTE_RE = /:\s*(Dohodou|V textu|Nabídněte|Zdarma|Na vyžádání|Info v RK)\s*$/i;

/** Slovní podoba ceny z titulku (Bazoš), např. "Dohodou", nebo null. */
export function parsePriceNote(title) {
  const m = title?.match(PRICE_NOTE_RE);
  return m ? m[1] : null;
}

/** Text bez slovního dovětku o ceně (viz parsePriceNote). */
export function stripPriceNote(text) {
  return text ? text.replace(PRICE_NOTE_RE, "").trim() : text;
}

// Volný text popisu má město skloňované ("Prodám byt v České Třebové."),
// zatímco `watch.locations[].label` je vždy 1. pád (nominativ) — musí být,
// aby seděl na `config.js`, který je sdílený s hlídacím psem a needituje se
// kvůli tomuhle. U měst, kde skloňování jen PŘIDÁ koncovku ke stejnému
// základu ("Žamberk" → "Žamberku", "Letohrad" → "Letohradě"), substring
// shoda náhodou projde i bez pomoci (nominativ zůstává jako předpona). Kde
// se mění i základ slova — hlavně přídavné jméno v "Česká Třebová" → "České
// Třebové" (oba tvary bez společné předpony) — substring shoda selže úplně
// a bez explicitního tvaru by adresa zůstala navždy prázdná (reálný případ:
// "Prodám 1kk byt v České Třebové."). "Ústí nad Orlicí" se neskloňuje vůbec.
const DECLINED_FORMS = {
  "Ústí nad Orlicí": [],
  Letohrad: ["Letohradě", "Letohradu", "Letohradem"],
  Žamberk: ["Žamberku", "Žamberkem"],
  "Česká Třebová": ["České Třebové", "Českou Třebovou"],
};

/**
 * Poslední záchranná síť pro adresu — když ji nedal ani portál, ani
 * titulek (viz parseAddressFromTitle), zkusí v textu najít aspoň JMÉNO
 * sledovaného města (ze stejné konfigurace jako watch "byty" v
 * config.js), včetně běžných skloňovaných tvarů (viz DECLINED_FORMS výš).
 * Ne přesná adresa, ale "aspoň víme, kde to je" — přesně to, co uživatel
 * chtěl u nabídek, které jinak žádnou adresu vůbec nemají.
 */
export function findKnownPlace(text, watch) {
  if (!text) return null;
  for (const loc of watch.locations) {
    const forms = [loc.label, ...(DECLINED_FORMS[loc.label] || [])];
    if (forms.some((form) => text.includes(form))) return loc.label;
  }
  return null;
}

/**
 * PSČ → sledované město, podle `watch.locations[].zip` (stejná čísla, co
 * appka posílá Bazoši jako `hlokalita` při hledání, viz sources/bazos.js) —
 * spolehlivější než hádání z volného textu (viz findKnownPlace výš), protože
 * jde o Bazošovo VLASTNÍ geokódování inzerátu, ne o shodu slov. Bazoš u
 * "Lokalita:" v detailu ukazuje název jen nejbližšího VĚTŠÍHO okresního
 * města (proto by u bytu v Žamberku klidně ukázal "Ústí nad Orlicí"), ale
 * PSČ vedle něj je přesné. `zip` s mezerou ("564 01") i bez ("56401") oboje
 * projde. Nemá k čemu — např. byt mimo 4 sledovaná města — vrátí `null`.
 */
export function zipToKnownPlace(zip, watch) {
  if (!zip) return null;
  const normalized = zip.replace(/\s+/g, "");
  return watch.locations.find((loc) => loc.zip === normalized)?.label ?? null;
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
  return m ? stripPriceNote(m[1].trim()) : null;
}

// Kraj/okres v adrese je pro filtr "město" šum, ne hodnota ("Pardubický
// kraj" není město) — při hledání posledního rozumného segmentu adresy
// se přeskočí.
const NON_CITY_SEGMENT_RE = /(kraj|okres|^okr\.)/i;

/**
 * Vytáhne "město" z adresy pro filtrování v UI — ne přesná municipalita,
 * jen rozumná skupina pro řazení nabídek do kbelíků. Nejdřív zkusí, jestli
 * adresa obsahuje jméno některého ze SLEDOVANÝCH měst (ze stejné
 * konfigurace jako watch "byty" v config.js) — i uvnitř delšího řetězce
 * jako "Ústí nad Orlicí - Hylváty" nebo "Česká Třebová, okr. Ústí nad
 * Orlicí" chceme jednu společnou skupinu, ne desítky mikro-lokalit podle
 * čtvrti. Když adresa žádné sledované město nezmiňuje (typicky
 * RealityMIX-only nabídky z okolních měst mimo hlavní 4, např.
 * Pardubice), spadne na poslední rozumně vyhlížející segment adresy.
 * Fail-soft — vrátí `null`, když adresu vůbec nemáme.
 */
export function extractCity(address, watch) {
  if (!address) return null;
  // "okr(es) X" je jen okresní kvalifikátor, ne město — celý sledovaný
  // region spadá pod okres Ústí nad Orlicí, takže i nabídka v Žamberku
  // nebo Letohradu má tenhle text v adrese. Bez odstranění by substring
  // hledání níž vždycky "vyhrálo" na "Ústí nad Orlicí" (první v seznamu,
  // viz watch.locations) místo skutečného města — ověřeno naostro na
  // "Křib, Česká Třebová, okr. Ústí nad Orlicí", co bez tohohle vracelo
  // špatně "Ústí nad Orlicí" místo "Česká Třebová".
  const withoutDistrict = address.replace(/,?\s*okr(?:es)?\.?\s+[^,]+/gi, "");
  for (const loc of watch.locations) {
    if (withoutDistrict.includes(loc.label)) return loc.label;
  }
  const parts = withoutDistrict.split(",").map((s) => s.trim()).filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i];
    // Min. délka je pojistka proti uťatým Bazoš titulkům (viz
    // parseAddressFromTitle) — "ul. Potoční, Ú" by jinak vyrobilo
    // jednopísmenné "město" (reálný případ, ne teorie).
    if (part && part.length >= 3 && !NON_CITY_SEGMENT_RE.test(part)) return part;
  }
  return null;
}
