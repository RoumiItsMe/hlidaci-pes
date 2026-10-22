// node --test lib/state.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { getChangeMap, setChangeMap, mergeStates } from "./state.js";

const NOW = Date.parse("2026-10-22T09:40:00Z");
const hoursAgo = (h) => new Date(NOW - h * 3600_000).toISOString();

test("změny ceny: načtení zahodí záznamy starší než okno a neúplné záznamy; uložení drží strop", () => {
  const state = {
    "byty:__changes": [
      { key: "1>2", source: "idnes", sourceLabel: "Reality.iDNES.cz", at: hoursAgo(1) },
      { key: "3>4", source: "bazos", at: hoursAgo(100) }, // po okně
      { key: "5>6", at: hoursAgo(1) }, // bez zdroje
      "nesmysl",
    ],
  };
  const map = getChangeMap(state, "byty:__changes", 72 * 3600_000, NOW);
  assert.deepEqual([...map.keys()], ["1>2"]);
  assert.equal(map.get("1>2").sourceLabel, "Reality.iDNES.cz");
  assert.deepEqual(getChangeMap({}, "x", 1000, NOW).size, 0);

  const many = new Map(Array.from({ length: 5 }, (_, i) => [`k${i}`, { source: "s", at: hoursAgo(1) }]));
  setChangeMap(state, "byty:__changes", many, 3);
  assert.deepEqual(state["byty:__changes"].map((e) => e.key), ["k2", "k3", "k4"]);
});

// Stav, ze kterého běh vyšel (base); běh přidal inzerát 2, změnil cenu inzerátu 1 a zapsal otisk (ours);
// mezitím na main přibyl jiný stav (theirs).
const base = {
  "byty:idnes": [{ id: "1", price: 100 }],
  "byty:__fingerprints": [{ fingerprint: "100_30", source: "Sreality.cz" }],
  __health: { "byty:idnes": { failing: false }, "byty:bazos": { failing: false } },
  "board:x": ["10", "9"],
  __boardChecks: { "board:x": "2026-10-22T07:00:00Z" },
};
const ours = {
  "byty:idnes": [{ id: "1", price: 90 }, { id: "2", price: 200 }],
  "byty:__fingerprints": [{ fingerprint: "100_30", source: "Sreality.cz" }, { fingerprint: "90_30", source: "Reality.iDNES.cz" }],
  __health: { "byty:idnes": { failing: false }, "byty:bazos": { failing: true } },
  "board:x": ["10", "9"],
  __boardChecks: { "board:x": "2026-10-22T07:30:00Z" },
  "byty:__changes": [{ key: "100>90", source: "idnes", at: hoursAgo(0) }],
};

test("main se od základu nezměnil → výsledek je stav z běhu", () => {
  assert.deepEqual(mergeStates(base, ours, structuredClone(base)), ours);
});

test("běh nic nezměnil → výsledek je stav z main", () => {
  const theirs = { ...structuredClone(base), "board:x": ["11", "10", "9"] };
  assert.deepEqual(mergeStates(base, structuredClone(base), theirs), theirs);
});

test("změnily se oba: seznamy se sloučí, běh vyhrává u téhož inzerátu, nic se neztratí", () => {
  const theirs = {
    ...structuredClone(base),
    "byty:idnes": [{ id: "1", price: 100 }, { id: "3", price: 300 }], // main zaznamenal nový inzerát 3
    "byty:__fingerprints": [{ fingerprint: "100_30", source: "Sreality.cz" }, { fingerprint: "300_50", source: "Bazoš.cz" }],
    "board:x": ["11", "10", "9"],
    __health: { "byty:idnes": { failing: false }, "byty:bazos": { failing: false }, "byty:realitymix": { failing: false } },
  };
  const merged = mergeStates(base, ours, theirs);

  // inzeráty: pořadí z main, nové z běhu za ním; cena 1 je z běhu (90)
  assert.deepEqual(merged["byty:idnes"], [{ id: "1", price: 90 }, { id: "3", price: 300 }, { id: "2", price: 200 }]);
  assert.deepEqual(merged["byty:__fingerprints"].map((e) => e.fingerprint), ["100_30", "300_50", "90_30"]);
  // ID desek: sjednocení, nic z main nezmizí
  assert.deepEqual(merged["board:x"], ["11", "10", "9"]);
  // zdraví po klíčích: změna z běhu zůstane, nový klíč z main také
  assert.deepEqual(merged.__health, { "byty:idnes": { failing: false }, "byty:bazos": { failing: true }, "byty:realitymix": { failing: false } });
  // klíč, který přibyl jen v běhu, se zachová; hodnota změněná jen během vyhrává
  assert.deepEqual(merged["byty:__changes"], ours["byty:__changes"]);
  assert.equal(merged.__boardChecks["board:x"], "2026-10-22T07:30:00Z");
});

test("seznam se po sloučení ořízne na maxKeep nejnovějších; neznámý tvar prvků nepadá", () => {
  const b = { l: [] };
  const o = { l: [{ id: "a" }, { id: "b" }] };
  const t = { l: [{ id: "c" }, { id: "d" }] };
  assert.deepEqual(mergeStates(b, o, t, 3).l.map((e) => e.id), ["d", "a", "b"]);
  // prvky bez klíče: sloučit nejde, platí stav z běhu
  const x = mergeStates({ l: [1] }, { l: [1, 2] }, { l: [1, 3] });
  assert.deepEqual(x.l, [1, 2]);
});
