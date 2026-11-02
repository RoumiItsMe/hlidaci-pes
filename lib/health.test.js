// node --test lib/health.test.js
// Upozornění na výpadek zdroje (lib/health.js): ohlásí se až výpadek, který trvá dost dlouho — krátké výpadky
// obecních desek (medián 12 minut) dřív posílaly ⚠️/✅ páry a e-maily o červeném běhu skoro denně.
import test from "node:test";
import assert from "node:assert/strict";
import { ALERT_POLICY, alertFailure, alertRecoveryIfNeeded, formatOutage, getHealth } from "./health.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.parse("2026-11-02T08:00:00.000Z");
const err = new Error("HTTP 404 Not Found");

function setup() {
  const sent = [];
  const send = async (text) => sent.push(text);
  const health = getHealth({}, "board:lanskroun");
  // Běh každých 15 minut: selhání v časech T0, T0+15 min, …
  const failAt = (ms, policy) => alertFailure(health, "Úřední deska • Lanškroun", err, { policy, now: ms, send });
  const recoverAt = (ms) => alertRecoveryIfNeeded(health, "Úřední deska • Lanškroun", { now: ms, send });
  return { health, sent, failAt, recoverAt };
}

test("deska: krátký výpadek (do 6 h) se neohlásí ani nezčervená běh, a po zotavení nepřijde žádná zpráva", async () => {
  const { health, sent, failAt, recoverAt } = setup();
  for (let t = T0; t < T0 + 6 * HOUR; t += 15 * MIN) assert.equal(await failAt(t, ALERT_POLICY.board), false);
  await recoverAt(T0 + 6 * HOUR);
  assert.deepEqual(sent, []);
  assert.equal(health.failing, false);
  assert.equal(health.failingSince, null);
  assert.equal(health.consecutiveFailures, 0);
});

test("deska: výpadek přes 6 h se ohlásí jednou, s délkou; další připomenutí až po 24 h; po zotavení ✅ s délkou", async () => {
  const { sent, failAt, recoverAt } = setup();
  const alerts = [];
  for (let t = T0; t <= T0 + 31 * HOUR; t += 15 * MIN) if (await failAt(t, ALERT_POLICY.board)) alerts.push((t - T0) / HOUR);
  assert.deepEqual(alerts, [6, 30]); // po 6 h a znovu po 24 h
  assert.match(sent[0], /^⚠️ Hlídací pes: Úřední deska • Lanškroun nefunguje už 6 h\.\nChyba: HTTP 404 Not Found/);
  assert.match(sent[1], /nefunguje už 1 den 6 h/);
  await recoverAt(T0 + 37 * HOUR);
  assert.equal(sent.at(-1), "✅ Hlídací pes: Úřední deska • Lanškroun zase funguje (výpadek trval 1 den 13 h).");
});

test("portál (výchozí): ohlásí se po 2 h výpadku, připomenutí po 12 h", async () => {
  const { sent, failAt } = setup();
  const alerts = [];
  for (let t = T0; t <= T0 + 15 * HOUR; t += 15 * MIN) if (await failAt(t)) alerts.push((t - T0) / HOUR);
  assert.deepEqual(alerts, [2, 14]);
  assert.match(sent[0], /nefunguje už 2 h/);
});

test("první selhání se nikdy neohlásí, ani kdyby výpadek podle stavu trval dlouho (zdroj musí selhat 2× po sobě)", async () => {
  const { health, sent } = setup();
  health.failing = false;
  assert.equal(await alertFailure(health, "X", err, { policy: { minOutageMs: 0, realertMs: HOUR }, now: T0, send: async (t) => sent.push(t) }), false);
  assert.equal(await alertFailure(health, "X", err, { policy: { minOutageMs: 0, realertMs: HOUR }, now: T0 + 15 * MIN, send: async (t) => sent.push(t) }), true);
  assert.equal(sent.length, 1);
});

test("výpadek, který se mezitím spravil, začíná znovu od nuly", async () => {
  const { sent, failAt, recoverAt } = setup();
  for (let t = T0; t < T0 + 5 * HOUR; t += 15 * MIN) await failAt(t, ALERT_POLICY.board);
  await recoverAt(T0 + 5 * HOUR);
  // nový výpadek: do dalších 5 h žádné upozornění, i když dohromady by to bylo přes 6 h
  for (let t = T0 + 5 * HOUR + 15 * MIN; t < T0 + 10 * HOUR; t += 15 * MIN) assert.equal(await failAt(t, ALERT_POLICY.board), false);
  assert.deepEqual(sent, []);
});

test("starší stav bez začátku výpadku (běžel už před touhle úpravou) se počítá od teď, ne od nuly epochy", async () => {
  const state = { __health: { "board:lukova": { failing: true, lastAlertAt: null, consecutiveFailures: 5 } } };
  const health = getHealth(state, "board:lukova");
  assert.equal(health.failingSince, null);
  const sent = [];
  assert.equal(await alertFailure(health, "Luková", err, { policy: ALERT_POLICY.board, now: T0, send: async (t) => sent.push(t) }), false);
  assert.equal(health.failingSince, new Date(T0).toISOString());
  assert.deepEqual(sent, []);
});

test("nepovedené odeslání upozornění se pořád počítá jako vážná chyba (červený běh), ať se výpadek neztratí", async () => {
  const health = getHealth({}, "byty:idnes");
  const send = async () => {
    throw new Error("Telegram nedostupný");
  };
  const realError = console.error;
  console.error = () => {};
  try {
    await alertFailure(health, "iDNES", err, { now: T0, send });
    assert.equal(await alertFailure(health, "iDNES", err, { now: T0 + 2 * HOUR, send }), true);
  } finally {
    console.error = realError;
  }
});

test("délka výpadku česky", () => {
  assert.equal(formatOutage(12 * MIN), "12 min");
  assert.equal(formatOutage(6 * HOUR), "6 h");
  assert.equal(formatOutage(24 * HOUR), "1 den");
  assert.equal(formatOutage(37 * HOUR), "1 den 13 h");
  assert.equal(formatOutage(3 * 24 * HOUR), "3 dny");
  assert.equal(formatOutage(5 * 24 * HOUR + 2 * HOUR), "5 dní 2 h");
});
