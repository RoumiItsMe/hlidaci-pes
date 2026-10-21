// MCP server pro chat: umožní v Claude Desktop (nebo jiném MCP klientovi) ptát se na
// data Trhu bytů — prodané byty, statistiky cen, nabídky, změny cen, detail bytu.
// Všechno jen pro čtení (databáze se otevírá `readOnly`), bez internetu a bez klíčů.
//
// Spouští ho klient sám jako podproces (stdio). Sekce se vybírá jako všude proměnnou
// TRH_REGION (bez ní Ústí n. O. a okolí, "nachod" = Náchod a Nové Město n. M.), takže
// pro obě sekce se zapíšou dva servery do nastavení klienta (viz README, "Chat přes MCP").
//
//   node trh-bytu/mcp-server.js
//
// stdout patří výhradně protokolu — cokoli jiného (log, chyby) jde na stderr.
// TRH_DB_PATH (jen pro zkoušení) = jiná databáze než ta v data/ sekce.

import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DATA_DIR } from "./db.js";
import { REGION } from "./region.js";
import { createTools } from "./mcp-tools.js";
import { createMcpServer } from "./mcp-protocol.js";

const dbPath = process.env.TRH_DB_PATH || path.join(DATA_DIR, "trh-bytu.sqlite");
const log = (line) => process.stderr.write(`[trh-bytu mcp] ${line}\n`);

function openReadOnly() {
  if (!existsSync(dbPath)) throw new Error(`databáze sekce „${REGION.label}“ nebyla nalezena (${dbPath}) — appka zatím neběžela nebo se sběr dat ještě nespustil`);
  return new DatabaseSync(dbPath, { readOnly: true });
}

const instructions = [
  `Data sekce „${REGION.label}“ z lokální appky Trh bytů (sledování nabídek bytů na prodej a jejich prodejů).`,
  "Všechny nástroje jen čtou. Odpovídej česky a čísla bez výjimky přebírej z výsledků nástrojů — nic si nedomýšlej.",
  "Rozlišuj: Prodáno (cena prodeje potvrzená) × Čeká na ověření (téměř jistý prodej, cena ještě není potvrzená). Cena prodeje je buď OVĚŘENÁ z katastru, nebo ODHAD (poslední inzerovaná cena −10 %); u průměrů vždy řekni, kolik bytů je za číslem a kolik z toho jsou odhady, a upozorni na malý vzorek.",
  "Inzerované ceny nabídek nejsou ceny, za které se byty prodají.",
  "Uživatel má i druhou sekci (jiný MCP server téže appky) — porovnání mezi sekcemi dělej voláním obou.",
].join("\n");

const server = createMcpServer({
  tools: createTools({ baseUrl: `http://localhost:${REGION.port}` }),
  openDb: openReadOnly,
  serverInfo: { name: `trh-bytu-${REGION.key}`, version: "1.0.0" },
  instructions,
  log,
});

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const out = server.handleLine(line);
  if (out) process.stdout.write(`${out}\n`);
});
rl.on("close", () => process.exit(0));
process.on("uncaughtException", (err) => {
  log(`neočekávaná chyba: ${err.stack || err.message}`);
  process.exit(1);
});
log(`připraven (${REGION.label}, ${dbPath})`);
