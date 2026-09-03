// Hlídací pes — hlavní orchestrátor.
//
// Projde všechny zdroje (portály), porovná nalezené inzeráty s tím, co už
// bylo dřív viděno (data/seen.json), a o nových pošle notifikaci na Telegram.
//
// Při úplně prvním běhu pro daný zdroj (žádný předchozí stav) se aktuální
// nabídka jen "zabaseline" jako už viděná — bez notifikací — ať uživatele
// nezaplaví desítkami zpráv o inzerátech, které tam visí už dlouho.
//
// Zdravotní stav zdrojů (state.__health) sleduje, jestli daný portál právě
// selhává — když ano, pošle se Telegram alert (a znovu až po 12 hodinách,
// ať to při dlouhodobém výpadku nespamuje každých 15 minut). Jakmile se
// zdroj zase rozchodí, pošle se zpráva o zotavení.

import { config } from "./config.js";
import { loadState, saveState, getSourceSeen, setSourceSeen } from "./lib/state.js";
import { sendTelegramMessage, sleep } from "./lib/telegram.js";
import { fetchSreality } from "./sources/sreality.js";
import { fetchBezrealitky } from "./sources/bezrealitky.js";
import { fetchIdnes } from "./sources/idnes.js";
import { fetchRealitymix } from "./sources/realitymix.js";
import { fetchBazos } from "./sources/bazos.js";

const ACTIONS_LOG_URL = "https://github.com/RoumiItsMe/hlidaci-pes/actions";
const REALERT_COOLDOWN_MS = 12 * 60 * 60 * 1000; // 12 hodin

const SOURCES = [
  { name: "sreality", label: "Sreality.cz", fetch: () => fetchSreality(config) },
  { name: "bezrealitky", label: "Bezrealitky.cz", fetch: () => fetchBezrealitky(config) },
  { name: "idnes", label: "Reality.iDNES.cz", fetch: () => fetchIdnes(config) },
  { name: "realitymix", label: "RealityMIX.cz", fetch: () => fetchRealitymix(config) },
  { name: "bazos", label: "Bazoš.cz", fetch: () => fetchBazos(config) },
];

function formatMessage(item) {
  const lines = [`🏠 Nová nabídka — ${item.sourceLabel}`, item.title];
  if (item.address) lines.push(`📍 ${item.address}`);
  lines.push(`💰 ${item.price}`);
  lines.push(item.url);
  return lines.join("\n");
}

function getHealth(state, source) {
  if (!state.__health) state.__health = {};
  if (!state.__health[source]) state.__health[source] = { failing: false, lastAlertAt: null };
  return state.__health[source];
}

/** Pošle Telegram alert o selhání zdroje — hned při první chybě, pak nejvýš 1x za 12 h. */
async function alertFailure(health, label, err) {
  const now = Date.now();
  const alreadyAlertedRecently =
    health.failing && health.lastAlertAt && now - Date.parse(health.lastAlertAt) < REALERT_COOLDOWN_MS;
  health.failing = true;
  if (alreadyAlertedRecently) return;

  health.lastAlertAt = new Date(now).toISOString();
  try {
    await sendTelegramMessage(
      `⚠️ Hlídací pes: zdroj ${label} přestal fungovat.\nChyba: ${err.message}\n\nLog: ${ACTIONS_LOG_URL}`
    );
  } catch (alertErr) {
    console.error(`Nepodařilo se odeslat alert o selhání zdroje ${label}: ${alertErr.message}`);
  }
}

/** Pošle Telegram zprávu o zotavení, pokud zdroj předtím selhával. */
async function alertRecoveryIfNeeded(health, label) {
  if (!health.failing) return;
  health.failing = false;
  health.lastAlertAt = null;
  try {
    await sendTelegramMessage(`✅ Hlídací pes: zdroj ${label} zase funguje.`);
  } catch (err) {
    console.error(`Nepodařilo se odeslat zprávu o zotavení zdroje ${label}: ${err.message}`);
  }
}

async function run() {
  const state = await loadState();
  let totalNew = 0;
  let hadError = false;

  for (const src of SOURCES) {
    const health = getHealth(state, src.name);
    const seen = getSourceSeen(state, src.name);
    const isFirstRun = seen.size === 0;

    let items;
    try {
      items = await src.fetch();
    } catch (err) {
      hadError = true;
      console.error(`[${src.name}] CHYBA při stahování: ${err.message}`);
      await alertFailure(health, src.label, err);
      continue;
    }

    await alertRecoveryIfNeeded(health, src.label);

    const newItems = items.filter((item) => !seen.has(item.id));
    console.log(
      `[${src.name}] nalezeno ${items.length} inzerátů v okruhu, z toho ${newItems.length} nových${
        isFirstRun ? " (první běh — jen baseline, bez notifikací)" : ""
      }`
    );

    for (const item of items) seen.add(item.id);
    setSourceSeen(state, src.name, seen, config.maxSeenPerSource);

    if (isFirstRun || newItems.length === 0) continue;

    for (const item of newItems) {
      try {
        await sendTelegramMessage(formatMessage(item));
        totalNew += 1;
        await sleep(400);
      } catch (err) {
        hadError = true;
        console.error(`[${src.name}] CHYBA při odesílání Telegram zprávy: ${err.message}`);
      }
    }
  }

  await saveState(state);
  console.log(`Hotovo. Odesláno ${totalNew} notifikací.`);

  if (hadError) {
    console.warn("Během běhu došlo k dílčím chybám — zkontroluj log výše.");
    // Nenulový exit kód → GitHub Actions označí běh jako neúspěšný (červený),
    // což (mimo Telegram alert výše) spustí i výchozí e-mailové upozornění
    // GitHubu vlastníkovi repa. Krok, co commituje stav, běží i tak (viz
    // `if: always()` ve workflow.yml) — stav a health-tracking se uloží vždy.
    process.exitCode = 1;
  }
}

run().catch(async (err) => {
  console.error("Neočekávaná chyba:", err);
  process.exitCode = 1;
  try {
    await sendTelegramMessage(
      `🔴 Hlídací pes: neočekávaná chyba celého běhu.\n${err.message}\n\nLog: ${ACTIONS_LOG_URL}`
    );
  } catch {
    // Telegram taky nemusí být dostupný (např. celkový výpadek sítě) — chyba
    // je aspoň v GitHub Actions logu a běh skončí červeně.
  }
});
