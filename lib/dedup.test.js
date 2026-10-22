// node --test lib/dedup.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { computeFingerprint, changeKey, priceChangeDuplicate, CHANGE_WINDOW_MS } from "./dedup.js";

const NOW = Date.parse("2026-10-22T09:40:00Z");
const hoursAgo = (h) => new Date(NOW - h * 3600_000).toISOString();

// Reálný případ: garsonka v České Třebové, sleva 2 490 000 → 2 350 000 na iDNES i Bazoši.
const idnes = { source: "idnes", sourceLabel: "Reality.iDNES.cz", id: "6a61", title: "prodej bytu 1+kk 32 m²", priceCzk: 2_350_000 };
const bazos = { source: "bazos", sourceLabel: "Bazoš.cz", id: "224175029", title: "Prodej garsonky se zahradou v České Třebové", priceCzk: 2_350_000 };
const change = { oldPriceCzk: 2_490_000, newPriceCzk: 2_350_000 };

test("otisk nemovitosti: cena + zaokrouhlená plocha z titulku; bez ceny nebo plochy žádný", () => {
  assert.equal(computeFingerprint(idnes), "2350000_32");
  assert.equal(computeFingerprint({ title: "Prodej bytu 2+1 54,4 m2", priceCzk: 3_000_000 }), "3000000_54");
  assert.equal(computeFingerprint(bazos), null); // titulek bez plochy
  assert.equal(computeFingerprint({ title: "Byt 32 m²", priceCzk: null }), null);
});

test("Bazoš bez plochy v titulku: stejný skok ceny, který už ohlásil jiný portál, se přeskočí", () => {
  const seenFingerprints = new Map([["2350000_32", "Reality.iDNES.cz"]]);
  const recentChanges = new Map([[changeKey(2_490_000, 2_350_000), { source: "idnes", sourceLabel: "Reality.iDNES.cz", at: hoursAgo(0) }]]);
  const dup = priceChangeDuplicate({ item: bazos, ...change, seenFingerprints, recentChanges, now: NOW });
  assert.equal(dup?.reason, "change");
  assert.equal(dup?.via, "Reality.iDNES.cz");
});

test("portál s plochou v titulku se pozná podle otisku nemovitosti", () => {
  const seenFingerprints = new Map([["2350000_32", "Sreality.cz"]]);
  const dup = priceChangeDuplicate({ item: idnes, ...change, seenFingerprints, recentChanges: new Map(), now: NOW });
  assert.equal(dup?.reason, "flat");
  assert.equal(dup?.via, "Sreality.cz");
});

test("stejný skok ceny na TÉMŽE portálu není duplicita (dva různé byty se nesmí potlačit)", () => {
  const recentChanges = new Map([[changeKey(2_490_000, 2_350_000), { source: "bazos", at: hoursAgo(1) }]]);
  const other = { ...bazos, id: "999", title: "Prodej bytu v Ústí" };
  assert.equal(priceChangeDuplicate({ item: other, ...change, seenFingerprints: new Map(), recentChanges, now: NOW }), null);
});

test("skok ceny starší než okno se nepočítá; uvnitř okna ano", () => {
  const key = changeKey(2_490_000, 2_350_000);
  const mk = (h) => new Map([[key, { source: "idnes", at: hoursAgo(h) }]]);
  assert.equal(priceChangeDuplicate({ item: bazos, ...change, seenFingerprints: new Map(), recentChanges: mk(CHANGE_WINDOW_MS / 3600_000 + 1), now: NOW }), null);
  assert.equal(priceChangeDuplicate({ item: bazos, ...change, seenFingerprints: new Map(), recentChanges: mk(CHANGE_WINDOW_MS / 3600_000 - 1), now: NOW })?.reason, "change");
});

test("jiný skok ceny, nebo stejná cena bez shodného skoku, není duplicita", () => {
  const recentChanges = new Map([[changeKey(2_490_000, 2_350_000), { source: "idnes", at: hoursAgo(0) }]]);
  // jiná stará cena → jiný byt (dva byty za 2 490 000 Kč jsou běžné, proto samotná cena nestačí)
  assert.equal(priceChangeDuplicate({ item: bazos, oldPriceCzk: 2_590_000, newPriceCzk: 2_350_000, seenFingerprints: new Map(), recentChanges, now: NOW }), null);
  // jiná plocha téže ceny → jiný byt
  const seenFingerprints = new Map([["2350000_44", "Sreality.cz"]]);
  assert.equal(priceChangeDuplicate({ item: idnes, ...change, seenFingerprints, recentChanges: new Map(), now: NOW }), null);
});
