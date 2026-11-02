// Zdravotní stav zdrojů (state.__health) — sdílený mezi portály nemovitostí
// (index.js) a úředními deskami (lib/boards-runner.js), ať se všude chovají
// stejně: alert až když výpadek trvá DOST DLOUHO (viz ALERT_POLICY), znovu
// nejdřív po cooldownu, zpráva o zotavení jen když se předtím alertovalo.

import { sendTelegramMessage } from "./telegram.js";

export const ACTIONS_LOG_URL = "https://github.com/RoumiItsMe/hlidaci-pes/actions";

const HOUR_MS = 60 * 60 * 1000;

/**
 * Jak dlouho musí výpadek trvat, než se ohlásí, a jak často se pak připomíná.
 *
 * Dřív stačilo DRUHÉ selhání po sobě (při běhu každých 15 min ~ půlhodinový výpadek). Z historie stavu za 13 dní
 * (20. 10.–2. 11. 2026): obecní desky měly 43 výpadků s mediánem 12 minut a hlavně kvůli nim chodilo 15 ⚠️/✅ párů
 * + 15 e-mailů o červeném běhu — skoro vždy za výpadek, který se do hodiny spravil sám. Krátký výpadek přitom nic
 * nezahodí: oznámení visí na úřední desce nejméně 15 dní a inzerát dny až týdny, takže je najde první úspěšný běh.
 *  - portál: 2 h (za 13 dní nejdelší výpadek 1,8 h → 0 upozornění místo 4; skutečný výpadek se ohlásí do 2 hodin);
 *  - deska: 6 h (2 upozornění místo 15 — Lanškroun 37 h a Vysoké Mýto 9 h; připomenutí jednou denně).
 */
export const ALERT_POLICY = {
  portal: { minOutageMs: 2 * HOUR_MS, realertMs: 12 * HOUR_MS },
  board: { minOutageMs: 6 * HOUR_MS, realertMs: 24 * HOUR_MS },
};

export function getHealth(state, key) {
  if (!state.__health) state.__health = {};
  if (!state.__health[key]) {
    state.__health[key] = { failing: false, lastAlertAt: null, consecutiveFailures: 0, failingSince: null };
  }
  // Zpětná kompatibilita se starším state souborem bez těchto polí.
  if (state.__health[key].consecutiveFailures == null) state.__health[key].consecutiveFailures = 0;
  if (state.__health[key].failingSince === undefined) state.__health[key].failingSince = null;
  return state.__health[key];
}

/** "45 min", "3 h", "1 den 13 h" — délka výpadku do zprávy. */
export function formatOutage(ms) {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h`;
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  const dayWord = days === 1 ? "den" : days <= 4 ? "dny" : "dní";
  return `${days} ${dayWord}${rest ? ` ${rest} h` : ""}`;
}

/**
 * Zaznamená selhání a vrátí, jestli se kvůli němu POSLAL Telegram alert
 * (= jestli se tenhle běh má počítat jako "vážné" selhání pro exit kód —
 * nenulový exit kód znamená červený běh + GitHubův e-mail vlastníkovi).
 * `false` (výpadek je zatím krátký, nebo se už připomínalo) tedy neznamená
 * "je to v pořádku", jen "nic nového k nahlášení" — `state.__health` pořád
 * eviduje `failing` a od kdy (`failingSince`).
 *
 * Alertuje se, až když zdroj selhal aspoň dvakrát po sobě A výpadek trvá
 * aspoň `policy.minOutageMs` (viz ALERT_POLICY). `fetchText` už sama zkouší
 * network-level chyby 2× znovu uvnitř jednoho běhu (viz lib/http.js).
 *
 * @param opts.policy  ALERT_POLICY.portal (výchozí) nebo ALERT_POLICY.board
 * @param opts.now     čas (ms) — pro testy
 * @param opts.send    odeslání zprávy — pro testy
 */
export async function alertFailure(health, label, err, { policy = ALERT_POLICY.portal, now = Date.now(), send = sendTelegramMessage } = {}) {
  // Začátek výpadku: první selhání po úspěchu. Starší stav bez `failingSince` (výpadek rozběhnutý před touhle
  // úpravou) začíná počítat teď — radši o pár hodin později, než ohlásit hned.
  if (!health.failing || !health.failingSince) health.failingSince = new Date(now).toISOString();
  health.consecutiveFailures += 1;
  health.failing = true;

  if (health.consecutiveFailures < 2) return false; // první selhání — dej šanci, ať se samo spraví
  const outageMs = now - Date.parse(health.failingSince);
  if (outageMs < policy.minOutageMs) return false; // krátký výpadek — do příštích běhů se nejspíš spraví sám

  // Telegram mlčí (uživatel to už ví) a vrací se `false` — žádná NOVÁ informace, běh smí být zelený. Jinak by
  // dlouhý výpadek znamenal červený běh a e-mail každých 15 minut (zjištěno naostro 2026-09-29).
  const alreadyAlertedRecently = health.lastAlertAt && now - Date.parse(health.lastAlertAt) < policy.realertMs;
  if (alreadyAlertedRecently) return false;

  health.lastAlertAt = new Date(now).toISOString();
  try {
    await send(`⚠️ Hlídací pes: ${label} nefunguje už ${formatOutage(outageMs)}.\nChyba: ${err.message}\n\nLog: ${ACTIONS_LOG_URL}`);
  } catch (alertErr) {
    console.error(`Nepodařilo se odeslat alert o selhání (${label}): ${alertErr.message}`);
  }
  return true;
}

/**
 * Pošle Telegram zprávu o zotavení — ale jen pokud se předtím opravdu
 * poslal alert o selhání (`lastAlertAt`). Krátký, tiše přečkaný výpadek
 * (žádný alert) se vrátí do klidu beze zprávy — nemá smysl hlásit "zase
 * funguje" u něčeho, o čem uživatel vůbec nevěděl.
 */
export async function alertRecoveryIfNeeded(health, label, { now = Date.now(), send = sendTelegramMessage } = {}) {
  const wasAlerted = health.lastAlertAt != null;
  const since = health.failingSince;
  health.failing = false;
  health.consecutiveFailures = 0;
  health.failingSince = null;
  if (!wasAlerted) return;

  health.lastAlertAt = null;
  const duration = since ? ` (výpadek trval ${formatOutage(now - Date.parse(since))})` : "";
  try {
    await send(`✅ Hlídací pes: ${label} zase funguje${duration}.`);
  } catch (err) {
    console.error(`Nepodařilo se odeslat zprávu o zotavení (${label}): ${err.message}`);
  }
}
