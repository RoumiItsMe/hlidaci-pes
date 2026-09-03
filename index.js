// Hlídací pes — hlavní orchestrátor.
//
// Projde všechny zdroje (portály), porovná nalezené inzeráty s tím, co už
// bylo dřív viděno (data/seen.json), a o nových pošle notifikaci na Telegram.
//
// Při úplně prvním běhu pro daný zdroj (žádný předchozí stav) se aktuální
// nabídka jen "zabaseline" jako už viděná — bez notifikací — ať uživatele
// nezaplaví desítkami zpráv o inzerátech, které tam visí už dlouho.

import { config } from "./config.js";
import { loadState, saveState, getSourceSeen, setSourceSeen } from "./lib/state.js";
import { sendTelegramMessage, sleep } from "./lib/telegram.js";
import { fetchSreality } from "./sources/sreality.js";
import { fetchBezrealitky } from "./sources/bezrealitky.js";
import { fetchIdnes } from "./sources/idnes.js";
import { fetchRealitymix } from "./sources/realitymix.js";
import { fetchBazos } from "./sources/bazos.js";

const SOURCES = [
  { name: "sreality", fetch: () => fetchSreality(config) },
  { name: "bezrealitky", fetch: () => fetchBezrealitky(config) },
  { name: "idnes", fetch: () => fetchIdnes() },
  { name: "realitymix", fetch: () => fetchRealitymix() },
  { name: "bazos", fetch: () => fetchBazos(config) },
];

function formatMessage(item) {
  const lines = [
    `🏠 Nová nabídka — ${item.sourceLabel}`,
    item.title,
  ];
  if (item.address) lines.push(`📍 ${item.address}`);
  lines.push(`💰 ${item.price}`);
  lines.push(item.url);
  return lines.join("\n");
}

async function run() {
  const state = await loadState();
  let totalNew = 0;
  let hadError = false;

  for (const src of SOURCES) {
    const seen = getSourceSeen(state, src.name);
    const isFirstRun = seen.size === 0;

    let items;
    try {
      items = await src.fetch();
    } catch (err) {
      hadError = true;
      console.error(`[${src.name}] CHYBA při stahování: ${err.message}`);
      continue;
    }

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

  // Nenulový exit kód při chybě zdroje/odeslání — GitHub Actions log to
  // zvýrazní, ale nechceme shodit celý cron (další zdroje se pořád zpracují,
  // stav se pořád uloží), takže exit code necháváme 0. Chyby jsou vidět
  // v logu běhu (`gh run view` / záložka Actions na GitHubu).
  if (hadError) {
    console.warn("Během běhu došlo k dílčím chybám — zkontroluj log výše.");
  }
}

run().catch((err) => {
  console.error("Neočekávaná chyba:", err);
  process.exitCode = 1;
});
