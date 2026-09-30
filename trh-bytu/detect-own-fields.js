// Odhad vlastního hodnocení (own_condition/own_construction/own_revitalized,
// viz OWN_FIELDS v params.js) z VOLNÉHO TEXTU inzerátu — klíčová slova, co se
// v popisech reálně objevují ("po rekonstrukci", "k rekonstrukci", "cihlový
// dům", "panelový dům", "revitalizace"...). Na rozdíl od parse.js
// (dispozice/plocha/cena/adresa jsou takřka vždy jednoznačné) je stav bytu
// věc interpretace — proto je celý modul navržený jako "raději nic, než
// špatně": nejednoznačný nebo protichůdný text vrací `null`, appka pak pole
// nechá prázdné a uživatel ho dopíše/vybere ručně (viz server.js). Odhad
// nikdy nepřepisuje hodnotu, kterou má appka/uživatel už uloženou — o to se
// stará volající (track.js/backfill), tenhle modul jen čte text.
//
// Vzorek, na kterém jsou vzory ověřené: 112 inzerátů se stahovaným popisem
// napříč všemi 5 portály (stav k 2026-09-30) — u každého vzoru dole je
// poznámka, jaký reálný text ho vyvolal a jaký reálný text ho musel vyloučit.

// "Plánovaná"/budoucí práce (revitalizace, rekonstrukce) NENÍ hotová práce —
// reálný případ: "Plánované zhodnocení: Do budoucna je naplánována
// kompletní rekonstrukce a revitalizace balkónů." by bez týhle pojistky
// appka mylně vyhodnotila jako už hotovou rekonstrukci/revitalizaci.
const PLANNED_WORK_RE = /plánován|plánuje|připravuje|bude\s+(?:provedena|realizována)|čeká\s+ji|v\s+plánu/i;

// "Částečná rekonstrukce" je záměrně VYLOUČENÁ ze všech tří stavových
// kategorií (needs_reno/maintained/renovated) — v reálných datech pokrývá
// jak "jen nová střecha" (bazos:224452029), tak "nové rozvody, koupelna,
// kuchyň" (bazos:223313109) — rozsah se případ od případu liší natolik, že
// žádná z kategorií by nebyla spolehlivě správná. Necháno na uživateli.
// Slovo "částečn(ě/á/ou...)" se v textu váže na různá slova ("částečná
// rekonstrukce", "částečně zrekonstruovaný", "částečně započata
// rekonstrukce") — proto mezera až na 2 slova mezi "částečn…" a
// "rekonstrukc…"/"zrekonstruovan…", ne přesná fráze. NESMÍ se ale rozšířit
// na holé "částečn*" bez vazby na rekonstrukci — text běžně obsahuje i
// "částečné podsklepení" nebo "byt je částečně zařízený" (vybavení), což s
// rekonstrukcí bytu nesouvisí vůbec. `\S+` (ne `\w+`) mezi slovy záměrně —
// `\w` v JS regexu bez `u` příznaku bere jen ASCII, takže by nechytlo ani
// samotné "částečně" (é/ě/á jsou mimo `\w`), natožpak slovo mezi ním a
// rekonstrukcí.
const PARTIAL_RENO_RE = /částečn\S*\s+(?:\S+\s+){0,2}(?:rekonstrukc\S*|zrekonstruovan\S*)|dílčí\s+rekonstrukc/i;

// "Po rekonstrukci" — realitky/soukromí inzerenti popisují HOTOVOU
// rekonstrukci bytu takhle. "Kompletní"/"celkové" volitelné, ale POKUD tam
// je "částečné"/"dílčí", pravidlo výš má přednost (viz needsRenoOrRenovated).
const RENOVATED_RE =
  /po\s+(?:kompletní\s+|celkové\s+)?rekonstrukci|kompletně\s+zrekonstruov|zrekonstruovan|rekonstrukce\s+(?:dokončena|hotová)|prošel\s+(?:pečlivou\s+)?(?:kompletní\s+|celkovou\s+)?rekonstrukcí|prošel\s+rekonstrukcí/i;

// "K rekonstrukci"/"původní stav" — bez rozlišení "byt" vs. "dům", protože
// ve vzorku se vždy týkalo bytu samotného (RK popisují stav bytu, ne domu,
// jako důvod nižší ceny).
const NEEDS_RENO_RE =
  /k\s+rekonstrukci|před\s+rekonstrukcí|potřeba\s+rekonstrukc|vyžaduje\s+rekonstrukc|nutná\s+rekonstrukce|původní\s+stav|v\s+původním\s+stavu/i;

// "Udržovaný" samo o sobě je nespolehlivé — ve vzorku 2 ze 4 výskytů mluvily
// o ZAHRADĚ nebo CELÉM DOMĚ ("udržovaná městem i nájemníky" u zahrady,
// "působí udržovaným a klidným dojmem" o domě), ne o bytu. Proto se
// vyžaduje bezprostřední sousedství se slovem "byt" ("udržovaný byt", "Stav:
// Udržovaný byt") — užší, ale bez falešných shod na vzorku.
const MAINTAINED_RE = /udržovan[ýá]\s+byt/i;

const NOVOSTAVBA_RE = /novostavb/i;

// "Zděný/á" bez výjimky pro sklep by chytlo i "zděný sklep"/"zděná sklepní
// kóje" — to je o materiálu SKLEPA, ne domu (reálný případ ve 2 inzerátech).
const BRICK_RE = /cihlov[ýáé]|cihlov[éě]\s|zděn[áý](?!\s*sklep)/i;
const PANEL_RE = /panelov|panelák/i;

const REVITALIZED_RE = /revitaliz/i;

/**
 * Odhadne own_condition ("needs_reno"/"maintained"/"renovated"/"novostavba")
 * z volného textu, nebo `null` když text nic jednoznačného neříká (žádný
 * signál, "částečná rekonstrukce", nebo protichůdné signály zároveň).
 */
export function detectOwnCondition(text) {
  if (!text) return null;
  const candidates = new Set();
  if (PARTIAL_RENO_RE.test(text)) return null; // vědomě nejednoznačné, viz komentář výš
  if (NEEDS_RENO_RE.test(text)) candidates.add("needs_reno");
  if (RENOVATED_RE.test(text) && !hasPlannedWorkNear(text, RENOVATED_RE)) candidates.add("renovated");
  if (NOVOSTAVBA_RE.test(text)) candidates.add("novostavba");
  if (MAINTAINED_RE.test(text)) candidates.add("maintained");
  return candidates.size === 1 ? [...candidates][0] : null;
}

/** Odhadne own_construction ("panel"/"brick"), nebo `null`. */
export function detectOwnConstruction(text) {
  if (!text) return null;
  const isBrick = BRICK_RE.test(text);
  const isPanel = PANEL_RE.test(text);
  if (isBrick === isPanel) return null; // ani jedno, nebo protichůdně obojí
  return isBrick ? "brick" : "panel";
}

/** Odhadne own_revitalized ("yes"), nebo `null` (appka nikdy negativně netvrdí "ne" — nezmínění revitalizace neznamená, že dům revitalizovaný NENÍ). */
export function detectOwnRevitalized(text) {
  if (!text) return null;
  if (!REVITALIZED_RE.test(text)) return null;
  return hasPlannedWorkNear(text, REVITALIZED_RE) ? null : "yes";
}

// Kontroluje "plánovací" slovo (viz PLANNED_WORK_RE) v okolí ±60 znaků od
// shody — ne v celém textu, ať vzdálená zmínka o plánování něčeho jiného
// (např. "plánujeme prohlídky") nezablokuje skutečně hotovou rekonstrukci
// zmíněnou jinde v popisu.
function hasPlannedWorkNear(text, re) {
  const m = text.match(re);
  if (!m) return false;
  const window = text.slice(Math.max(0, m.index - 60), m.index + m[0].length + 60);
  return PLANNED_WORK_RE.test(window);
}
