// Zdravotní stav zdrojů (state.__health) — sdílený mezi portály nemovitostí
// (index.js) a úředními deskami (lib/boards-runner.js), ať se všude chovají
// stejně: alert až po DRUHÉM selhání po sobě, znovu nejdřív po 12 hodinách,
// zpráva o zotavení jen když se předtím alertovalo.

import { sendTelegramMessage } from "./telegram.js";

export const ACTIONS_LOG_URL = "https://github.com/RoumiItsMe/hlidaci-pes/actions";
const REALERT_COOLDOWN_MS = 12 * 60 * 60 * 1000; // 12 hodin

export function getHealth(state, key) {
  if (!state.__health) state.__health = {};
  if (!state.__health[key]) {
    state.__health[key] = { failing: false, lastAlertAt: null, consecutiveFailures: 0 };
  }
  // Zpětná kompatibilita se starším state souborem bez tohohle pole.
  if (state.__health[key].consecutiveFailures == null) state.__health[key].consecutiveFailures = 0;
  return state.__health[key];
}

/**
 * Zaznamená selhání a vrátí, jestli se kvůli němu poslal Telegram alert
 * (= jestli se tenhle běh má počítat jako "vážné" selhání pro exit kód).
 *
 * Nealertuje hned při první chybě — `fetchText` už sama zkouší network-level
 * chyby 2x znovu uvnitř jednoho běhu (viz lib/http.js), takže cokoli, co
 * projde až sem, je buď 4xx (trvalé), nebo network chyba, co přežila i tři
 * pokusy. I tak se ale ukázalo, že jde občas o krátkodobý zádrhel (blok/
 * timeout ze strany portálu), co zmizí sám do dalšího běhu o 15 minut
 * později — proto se čeká na DRUHÉ selhání PO SOBĚ (napříč běhy), než se to
 * nahlásí jako "přestal fungovat". Cena je 15minutové zpoždění v detekci
 * SKUTEČNÉHO výpadku, výhra je žádný ⚠️/✅ pár za samo-vyřešitelný blip.
 */
export async function alertFailure(health, label, err) {
  health.consecutiveFailures += 1;
  health.failing = true;

  if (health.consecutiveFailures < 2) return false; // první selhání — dej šanci, ať se samo spraví

  const now = Date.now();
  const alreadyAlertedRecently =
    health.lastAlertAt && now - Date.parse(health.lastAlertAt) < REALERT_COOLDOWN_MS;
  if (alreadyAlertedRecently) return true;

  health.lastAlertAt = new Date(now).toISOString();
  try {
    await sendTelegramMessage(
      `⚠️ Hlídací pes: ${label} přestal fungovat.\nChyba: ${err.message}\n\nLog: ${ACTIONS_LOG_URL}`
    );
  } catch (alertErr) {
    console.error(`Nepodařilo se odeslat alert o selhání (${label}): ${alertErr.message}`);
  }
  return true;
}

/**
 * Pošle Telegram zprávu o zotavení — ale jen pokud se předtím opravdu
 * poslal alert o selhání (`lastAlertAt`). Ojedinělý, tiše přečkaný blip
 * (jedno selhání, žádný alert) se tak vrátí do klidu beze zprávy — nemá
 * smysl hlásit "zase funguje" u něčeho, o čem uživatel vůbec nevěděl.
 */
export async function alertRecoveryIfNeeded(health, label) {
  const wasAlerted = health.lastAlertAt != null;
  health.failing = false;
  health.consecutiveFailures = 0;
  if (!wasAlerted) return;

  health.lastAlertAt = null;
  try {
    await sendTelegramMessage(`✅ Hlídací pes: ${label} zase funguje.`);
  } catch (err) {
    console.error(`Nepodařilo se odeslat zprávu o zotavení (${label}): ${err.message}`);
  }
}
