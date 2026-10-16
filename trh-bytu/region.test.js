// node --test trh-bytu/region.test.js
// Region se vybírá proměnnou prostředí při startu procesu, proto se tu spouští
// samostatné procesy — modul si region čte při načtení.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";

const DIR = import.meta.dirname;
function inRegion(region, code) {
  const env = { ...process.env, TELEGRAM_BOT_TOKEN: "token-z-prostredi", TELEGRAM_CHAT_ID: "chat-z-prostredi" };
  delete env.TRH_REGION;
  if (region) env.TRH_REGION = region;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { cwd: DIR, env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split("\n").pop());
}
const probe = `
  const region = await import("./region.js");
  const db = await import("./db.js");
  console.log(JSON.stringify({
    key: region.REGION_KEY, watch: region.REGION_WATCH.key, locations: region.REGION_WATCH.locations.map((l) => l.label),
    dataDir: db.DATA_DIR, telegram: region.REGION.telegram, token: process.env.TELEGRAM_BOT_TOKEN, chat: process.env.TELEGRAM_CHAT_ID,
    port: region.REGION.port, kn: Object.keys(region.KN_OPTIONS),
  }));
`;

test("výchozí region je původní chování: složka data, watch 'byty', Telegram zapnutý, port 4321", () => {
  const r = inRegion(null, probe);
  assert.equal(r.key, "default");
  assert.equal(r.watch, "byty");
  assert.equal(path.basename(r.dataDir), "data");
  assert.equal(r.telegram, true);
  assert.equal(r.token, "token-z-prostredi"); // výchozí region údaje z prostředí nemění
  assert.equal(r.port, 4321);
  assert.deepEqual(r.kn, []); // výchozí strop a Telegram beze změny
  assert.deepEqual(r.locations, ["Ústí nad Orlicí", "Letohrad", "Žamberk", "Česká Třebová"]);
});

test("region Náchod má vlastní složku dat, vlastní lokality a port; Telegram je vypnutý a údaje zahozené", () => {
  const r = inRegion("nachod", probe);
  assert.equal(r.key, "nachod");
  assert.equal(r.watch, "byty-nachod");
  assert.equal(path.basename(r.dataDir), "data-nachod");
  assert.notEqual(r.dataDir, inRegion(null, probe).dataDir); // databáze se nikdy nesdílí
  assert.deepEqual(r.locations, ["Náchod", "Nové Město nad Metují"]);
  assert.equal(r.telegram, false);
  assert.equal(r.token, ""); // pojistka: i kdyby nějaká cesta sáhla na Telegram, nemá čím poslat
  assert.equal(r.chat, "");
  assert.equal(r.port, 4323);
  assert.deepEqual(r.kn.sort(), ["dailyBudget", "send"]);
});

test("neznámý region se odmítne hned při startu", () => {
  const env = { ...process.env, TRH_REGION: "neexistuje" };
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", 'await import("./region.js")'], { cwd: DIR, env, encoding: "utf8" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Neznámý region "neexistuje"/);
});
