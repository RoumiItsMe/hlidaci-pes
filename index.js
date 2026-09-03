// Hlídací pes — hlavní orchestrátor.
//
// Projde všechna sledování (watches, viz config.js) × všechny zdroje
// (portály), porovná nalezené inzeráty s tím, co už bylo dřív viděno
// (data/seen.json), a o nových pošle notifikaci na Telegram.
//
// Při úplně prvním běhu pro danou dvojici (sledování, zdroj) — žádný
// předchozí stav — se aktuální nabídka jen "zabaseline" jako už viděná —
// bez notifikací — ať uživatele nezaplaví desítkami zpráv o inzerátech,
// které tam visí už dlouho. Stejný princip platí i při přidání nového
// sledování/lokality: state klíč je nový → první běh je tichý baseline.
//
// Zdravotní stav (state.__health) sleduje, jestli daná dvojice (sledování,
// zdroj) právě selhává — když ano, pošle se Telegram alert (a znovu až po
// 12 hodinách, ať to při dlouhodobém výpadku nespamuje každých 15 minut).
// Jakmile se zdroj zase rozchodí, pošle se zpráva o zotavení.

import { watches, maxSeenPerSource } from "./config.js";
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
  { name: "sreality", label: "Sreality.cz", fetch: fetchSreality },
  { name: "bezrealitky", label: "Bezrealitky.cz", fetch: fetchBezrealitky },
  { name: "idnes", label: "Reality.iDNES.cz", fetch: fetchIdnes },
  { name: "realitymix", label: "RealityMIX.cz", fetch: fetchRealitymix },
  { name: "bazos", label: "Bazoš.cz", fetch: fetchBazos },
];

function formatMessage(watch, item) {
  const lines = [`${watch.emoji} Nová nabídka — ${watch.label} • ${item.sourceLabel}`, item.title];
  if (item.address) lines.push(`📍 ${item.address}`);
  lines.push(`💰 ${item.price}`);
  lines.push(item.url);
  return lines.join("\n");
}

function getHealth(state, key) {
  if (!state.__health) state.__health = {};
  if (!state.__health[key]) state.__health[key] = { failing: false, lastAlertAt: null };
  return state.__health[key];
}

/** Pošle Telegram alert o selhání — hned při první chybě, pak nejvýš 1x za 12 h. */
async function alertFailure(health, label, err) {
  const now = Date.now();
  const alreadyAlertedRecently =
    health.failing && health.lastAlertAt && now - Date.parse(health.lastAlertAt) < REALERT_COOLDOWN_MS;
  health.failing = true;
  if (alreadyAlertedRecently) return;

  health.lastAlertAt = new Date(now).toISOString();
  try {
    await sendTelegramMessage(
      `⚠️ Hlídací pes: ${label} přestal fungovat.\nChyba: ${err.message}\n\nLog: ${ACTIONS_LOG_URL}`
    );
  } catch (alertErr) {
    console.error(`Nepodařilo se odeslat alert o selhání (${label}): ${alertErr.message}`);
  }
}

/** Pošle Telegram zprávu o zotavení, pokud předtím selhávalo. */
async function alertRecoveryIfNeeded(health, label) {
  if (!health.failing) return;
  health.failing = false;
  health.lastAlertAt = null;
  try {
    await sendTelegramMessage(`✅ Hlídací pes: ${label} zase funguje.`);
  } catch (err) {
    console.error(`Nepodařilo se odeslat zprávu o zotavení (${label}): ${err.message}`);
  }
}

async function run() {
  const state = await loadState();
  let totalNew = 0;
  let hadError = false;

  for (const watch of watches) {
    for (const src of SOURCES) {
      const stateKey = `${watch.key}:${src.name}`;
      const label = `${watch.label} • ${src.label}`;
      const health = getHealth(state, stateKey);
      const seen = getSourceSeen(state, stateKey);
      const isFirstRun = seen.size === 0;

      let items;
      try {
        items = await src.fetch(watch);
      } catch (err) {
        hadError = true;
        console.error(`[${stateKey}] CHYBA při stahování: ${err.message}`);
        await alertFailure(health, label, err);
        continue;
      }

      await alertRecoveryIfNeeded(health, label);

      const newItems = items.filter((item) => !seen.has(item.id));
      console.log(
        `[${stateKey}] nalezeno ${items.length} inzerátů, z toho ${newItems.length} nových${
          isFirstRun ? " (první běh — jen baseline, bez notifikací)" : ""
        }`
      );

      for (const item of items) seen.add(item.id);
      setSourceSeen(state, stateKey, seen, maxSeenPerSource);

      if (isFirstRun || newItems.length === 0) continue;

      for (const item of newItems) {
        try {
          await sendTelegramMessage(formatMessage(watch, item));
          totalNew += 1;
          await sleep(400);
        } catch (err) {
          hadError = true;
          console.error(`[${stateKey}] CHYBA při odesílání Telegram zprávy: ${err.message}`);
        }
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
