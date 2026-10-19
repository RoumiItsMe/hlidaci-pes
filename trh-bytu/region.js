// Regiony ("sekce") Trhu bytů. Každý region je ÚPLNĚ oddělená kopie appky: vlastní
// SQLite databáze, fotky, log a zámek sběru (složka `dataDir`), vlastní sledované
// lokality (watch), vlastní port webu a vlastní nastavení Telegramu. Kód je
// společný, data se nikdy nemíchají — region se vybírá proměnnou prostředí
// TRH_REGION při startu procesu (web i sběr), bez ní je to výchozí region, tedy
// původní chování appky beze změny (složka data/, port 4321, watch "byty" z
// config.js, Telegram zapnutý).
//
// Watch dalších regionů je ZÁMĚRNĚ tady, ne v ../config.js: ten sdílí hlídací
// pes (GitHub Actions) a každé další sledování by tam okamžitě začalo posílat
// Telegram upozornění.

import { watches } from "../config.js";

// Náchod a Nové Město nad Metují — "přímo tyto obce", ne okolí. Střed a poloměr
// jen vymezují dotaz u portálů, co umějí hledat podle polohy (Bezrealitky,
// Bazoš); přesně se pak filtruje podle obce z adresy inzerátu (viz
// region-sources.js).
const NACHOD_WATCH = {
  key: "byty-nachod",
  label: "Byty na prodej — Náchod a Nové Město nad Metují",
  emoji: "🏠",
  offerType: "prodej",
  propertyType: "byt",
  priceMaxCzk: null,
  locations: [
    { key: "nachod", label: "Náchod", zip: "54701", citySlug: "nachod", centerLat: 50.4165, centerLng: 16.1631, radiusKm: 4 },
    { key: "nove-mesto-nad-metuji", label: "Nové Město nad Metují", zip: "54901", citySlug: "nove-mesto-nad-metuji", centerLat: 50.3438, centerLng: 16.1511, radiusKm: 4 },
  ],
};

export const REGIONS = {
  default: {
    key: "default",
    label: "Ústí nad Orlicí a okolí",
    short: "Ústí n. O.",
    port: 4321,
    dataDir: "data",
    telegram: true,
    knDailyBudget: null, // výchozí strop kn-scan.js
    // Přednost při čerpání společného limitu API katastru (kn-priority.js): Ústí je první.
    knRole: "primary",
  },
  nachod: {
    key: "nachod",
    label: "Náchod a Nové Město nad Metují",
    short: "Náchod",
    port: 4323,
    dataDir: "data-nachod",
    telegram: false, // jen porovnávání nabídek, prodejů a katastr — žádné zprávy do Telegramu
    // Denní limit API katastru je společný pro oba regiony (jeden klíč) — tenhle
    // region si smí vzít nejvýš tolik, a to JEN z toho, co nemůže potřebovat
    // Ústí (tvrdá přednost, viz kn-priority.js): "secondary".
    knDailyBudget: 150,
    knRole: "secondary",
    watch: NACHOD_WATCH,
    // Obce, ze kterých se bere nabídka (porovnání bez diakritiky).
    municipalities: ["Náchod", "Nové Město nad Metují"],
    // Okruh pro portály, co hledají podle polohy; přesně se pak filtruje podle obce.
    bezrealitkyRadiusKm: 6,
    bazosRadiusKm: 3,
  },
};

export const REGION_KEY = process.env.TRH_REGION || "default";
if (!REGIONS[REGION_KEY]) {
  throw new Error(`Neznámý region "${REGION_KEY}" (TRH_REGION). Dostupné: ${Object.keys(REGIONS).join(", ")}`);
}
export const REGION = REGIONS[REGION_KEY];

/** Watch (sledované lokality) tohoto regionu. */
export const REGION_WATCH = REGION.watch ?? watches.find((w) => w.key === "byty");
if (!REGION_WATCH) throw new Error('watch "byty" nenalezen v config.js');

/**
 * Volby pro kontrolu domů přes API katastru (kn-scan.js): denní strop volání,
 * pořadí při čerpání společného limitu (`priority`) a — u regionu bez Telegramu —
 * odesílání nahrazené prázdnou funkcí (nález vkladu se zapíše, ale nic se nepošle).
 */
export const KN_OPTIONS = {
  priority: { role: REGION.knRole },
  ...(REGION.knDailyBudget ? { dailyBudget: REGION.knDailyBudget } : {}),
  ...(REGION.telegram ? {} : { send: async () => {} }),
};

/** Ostatní regiony — web výchozího regionu je pustí jako vlastní procesy a odkazuje na ně. */
export const OTHER_REGIONS = Object.values(REGIONS).filter((r) => r.key !== REGION.key);

// Region bez Telegramu: údaje se zahodí hned při načtení (dřív než se načte
// .env.local — `process.loadEnvFile` hodnotu, co už v prostředí je, nepřepíše).
// Je to pojistka navíc k vypnutým voláním: kdyby nějaká cesta na odeslání
// přesto sáhla, selže na chybějícím tokenu místo odeslání zprávy.
if (!REGION.telegram) {
  process.env.TELEGRAM_BOT_TOKEN = "";
  process.env.TELEGRAM_CHAT_ID = "";
}
