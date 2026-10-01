// Zpracuje čekající kliknutí na Telegram tlačítka ("Prodáno"/"Odložit o 3
// týdny", viz reservation-reminders.js) BEZ stahování portálů — na rozdíl
// od track.js (jednou denně, plný sběr dat) se tenhle skript hodí spouštět
// ČASTO (naplánovaná úloha po pár minutách), ať appka na kliknutí reaguje
// prakticky hned, ne až při příštím dennímu sběru. Nikdy neposílá nové
// připomínky ani nekontroluje lhůty (`sendDueFollowups`) — to zůstává
// výhradně v track.js, ať se nová připomínka nepošle dvakrát jen proto, že
// běží dva různé naplánované skripty.
//
// Spuštění: `node trh-bytu/process-telegram.js` (env se načte sám).

import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "./db.js";
import { processTelegramActions } from "./reservation-reminders.js";

try {
  process.loadEnvFile(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".env.local"));
} catch {
  // .env.local nemusí existovat — chybějící token/chat ID se ohlásí níž při
  // prvním pokusu o Telegram volání (appka běží bez dohledu, fail-soft).
}

function log(line) {
  console.log(`[${new Date().toISOString()}] ${line}`);
}

const db = openDb();
await processTelegramActions(db, log);
db.close();
