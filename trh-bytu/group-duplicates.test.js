// Slučování téhož bytu z víc portálů podle textu inzerátu (ne podle výměry).
// Reálný případ: byt na Dukelské v Hylvátech (3 450 000 Kč) je na iDNES se 52 m², na RealityMIX
// s 58 m² (výměra se sklepem) — a RealityMIX nemá popis ve sloupci `description`, ale v
// `geo_json.text` (viz listing-text.js). Appka z toho dělala dvě nabídky.

import test from "node:test";
import assert from "node:assert/strict";
import { groupListings, primaryListing } from "./group.js";

const TEXT =
  "Krásný byt 2+1 po velmi povedené rekonstrukci! Vítejte v Ústí nad Orlicí! Nachází se na oblíbeném sídlišti Dukla ve 2. nadzemním podlaží zděného domu. " +
  "Plocha bytu je 52 m² včetně sklepa a lodžie. Byt je ihned k nastěhování, v okolí škola, školka i obchody.";

function listing(overrides) {
  return {
    id: "x:1",
    source: "x",
    title: "Prodej bytu 2+1",
    disposition: "2+1",
    area_m2: 52,
    price_czk: 3_450_000,
    address: "Dukelská, Ústí nad Orlicí - Hylváty",
    description: null,
    geo_json: null,
    replaced_by: null,
    ...overrides,
  };
}

const idnes = (o) => listing({ id: "idnes:a", source: "idnes", description: TEXT, ...o });
// RealityMIX: popis jen v geo_json.text, výměra jiná, interpunkce trochu jiná.
const realitymix = (o) =>
  listing({ id: "realitymix:b", source: "realitymix", area_m2: 58, geo_json: JSON.stringify({ text: TEXT.replaceAll("!", ".") }), ...o });

test("RealityMIX s jinou výměrou se spojí s iDNES podle textu v geo_json (popis má jen tam)", () => {
  const groups = groupListings([idnes(), realitymix()]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].merged, true);
  assert.deepEqual(groups[0].members.map((m) => m.id).sort(), ["idnes:a", "realitymix:b"]);
});

test("jako hlavní se bere iDNES (výměra 52), ne RealityMIX se špatnou výměrou", () => {
  const [group] = groupListings([realitymix(), idnes()]);
  assert.equal(primaryListing(group.members).area_m2, 52);
});

test("text se porovnává bez interpunkce: portály liší jen tečku × vykřičník", () => {
  // Bez ceny u RealityMIX, ať se nespojí už podle dispozice+ceny+plochy a rozhoduje jen text.
  const groups = groupListings([idnes(), realitymix({ price_czk: null, area_m2: 52 })]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].members.length, 2);
});

test("jiný byt se stejnou dispozicí a cenou, ale jiným textem, se nespojí (rozhoduje text, ne výměra)", () => {
  // Výměra v textu (52 m²) výměře iDNES odpovídá, takže výměra spojení nebrání — zbývá text.
  const other = realitymix({
    geo_json: JSON.stringify({
      text: "Slunný byt 2+1 s balkonem v klidné ulici, částečně po rekonstrukci. Dům je po revitalizaci, nové fasádě i oknech. Plocha 52 m². Volný ihned, dobrá dostupnost do centra.",
    }),
  });
  const groups = groupListings([idnes(), other]);
  assert.equal(groups.length, 2);
  assert.ok(groups.every((g) => !g.merged));
});

test("dva inzeráty téhož portálu se nikdy nespojí, ani s totožným textem", () => {
  const groups = groupListings([realitymix({ id: "realitymix:1" }), realitymix({ id: "realitymix:2" })]);
  assert.equal(groups.length, 2);
});
