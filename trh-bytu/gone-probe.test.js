// node --test trh-bytu/gone-probe.test.js
// Přímý důkaz ze stránky inzerátu, že portál nabídku smazal (Dukelská 320, 10/2026: všechny čtyři portály ji už
// neměly, ale appka ji 6 hodin vedla jako "v nabídce", protože čekala na potvrzení dalším během).
import test from "node:test";
import assert from "node:assert/strict";
import { classifyGonePage, probeGone } from "./gone-probe.js";

test("Sreality: smazaný inzerát je HTTP 404, živý 200", () => {
  assert.equal(classifyGonePage({ source: "sreality", status: 404 }), true);
  assert.equal(classifyGonePage({ source: "sreality", status: 200, body: "Prodej bytu 2+1 … tato stránka neexistuje" }), false);
});

test("Bazoš: smazaný inzerát přesměruje na výpis kategorie, živý je 200", () => {
  assert.equal(classifyGonePage({ source: "bazos", status: 301, location: "https://reality.bazos.cz/inzeraty/prodej-bytu/" }), true);
  assert.equal(classifyGonePage({ source: "bazos", status: 302, location: "/inzeraty/prodej-bytu/" }), true);
  assert.equal(classifyGonePage({ source: "bazos", status: 200 }), false);
  // přesměrování na jiný inzerát (kanonická adresa téhož) smazání neznamená
  assert.equal(classifyGonePage({ source: "bazos", status: 301, location: "https://reality.bazos.cz/inzerat/223833934/novy-nazev.php" }), false);
});

test("iDNES a RealityMIX: 200 s hláškou o zaniklé nabídce; stejný text jinde nic neznamená", () => {
  assert.equal(classifyGonePage({ source: "idnes", status: 200, body: "… Nabídka již není aktivní Ode dne 28.10.2026 evidujeme nabídku jako neaktivní …" }), true);
  assert.equal(classifyGonePage({ source: "idnes", status: 200, body: "Prodej bytu 3+1 67 m²" }), false);
  assert.equal(classifyGonePage({ source: "realitymix", status: 200, body: "Požadovaný inzerát již není v naší databázi. Našli jsme ale 18 podobných nemovitostí." }), true);
  assert.equal(classifyGonePage({ source: "realitymix", status: 200, body: "Prodej bytu 2+1" }), false);
  assert.equal(classifyGonePage({ source: "sreality", status: 200, body: "Nabídka již není aktivní" }), false); // hláška jiného portálu
});

test("ostatní portály: jen HTTP 404 / 410; chyby, blokace a přetížení důkaz nejsou", () => {
  assert.equal(classifyGonePage({ source: "bezrealitky", status: 410 }), true);
  assert.equal(classifyGonePage({ source: "bezrealitky", status: 404 }), true);
  for (const status of [200, 403, 429, 500, 502, 503]) assert.equal(classifyGonePage({ source: "bezrealitky", status }), false);
  for (const status of [403, 429, 500, 503]) assert.equal(classifyGonePage({ source: "idnes", status, body: "Nabídka již není aktivní" }), false);
  assert.equal(classifyGonePage({ source: "bazos", status: 503, location: "/inzeraty/" }), false);
});

const reply = (status, { location = null, body = "" } = {}) => async () => ({ status, headers: { get: (name) => (name.toLowerCase() === "location" ? location : null) }, text: async () => body });

test("probeGone: zeptá se portálu a rozhodne podle odpovědi; chyba sítě ani chybějící adresa důkaz nejsou", async () => {
  assert.equal(await probeGone("sreality", "https://x/1", { fetchImpl: reply(404) }), true);
  assert.equal(await probeGone("sreality", "https://x/1", { fetchImpl: reply(200) }), false);
  assert.equal(await probeGone("bazos", "https://x/1", { fetchImpl: reply(301, { location: "https://reality.bazos.cz/inzeraty/prodej-bytu/" }) }), true);
  assert.equal(await probeGone("idnes", "https://x/1", { fetchImpl: reply(200, { body: "Nabídka již není aktivní" }) }), true);
  assert.equal(await probeGone("realitymix", "https://x/1", { fetchImpl: reply(200, { body: "Požadovaný inzerát již není v naší databázi" }) }), true);
  assert.equal(await probeGone("sreality", "https://x/1", { fetchImpl: async () => { throw new Error("síť"); } }), false);
  assert.equal(await probeGone("sreality", null, { fetchImpl: reply(404) }), false);
  assert.equal(await probeGone("sreality", "", { fetchImpl: reply(404) }), false);
});

test("probeGone: nesleduje přesměrování (redirect manual) a neposílá zbytečně body u portálů bez textového signálu", async () => {
  let seen;
  const fetchImpl = async (url, options) => {
    seen = options;
    return { status: 200, headers: { get: () => null }, text: async () => { throw new Error("tělo se číst nemá"); } };
  };
  assert.equal(await probeGone("sreality", "https://x/1", { fetchImpl }), false);
  assert.equal(seen.redirect, "manual");
});
