// node --test trh-bytu/realitymix-params.test.js
// RealityMIX uvádí vlastnictví a další údaje strukturovaně v bloku "Podrobné informace" na detailu. Appka je nečetla,
// takže družstevní byt (Habrmanova, Česká Třebová) vedla bez vlastnictví a po rezervaci k němu připomínala kontrolu
// v katastru, kde se družstevní byt ověřit nedá.
import test from "node:test";
import assert from "node:assert/strict";
import * as cheerio from "cheerio";
import { extractRealitymixParams, paramsFromPairs } from "./detail/realitymix.js";

// Skutečný blok z detailu inzerátu (22. 10. 2026), zkrácený o nepodstatné odstavce.
const HABRMANOVA = `<div class="detail-information">
  <h3>Podrobné informace</h3>
  <div class="detail-information__data-wrapper">
    <ul class="detail-information__data">
      <li class="detail-information__data-item"> <span>Dispozice bytu:</span> <span>3+1</span> </li>
      <li class="detail-information__data-item"> <span>Číslo podlaží v domě:</span> <span>6</span> </li>
      <li class="detail-information__data-item"> <span>Počet podlaží objektu:</span> <span>8</span> </li>
      <li class="detail-information__data-item"> <span>Užitná plocha:</span> <span>78 m²</span> </li>
    </ul>
    <ul class="detail-information__data">
      <li class="detail-information__data-item"> <span>Druh objektu:</span> <span>panelová</span> </li>
      <li class="detail-information__data-item"> <span>Stav objektu:</span> <span>dobrý</span> </li>
      <li class="detail-information__data-item"> <span>Vlastnictví:</span> <span>družstevní</span> </li>
      <li class="detail-information__data-item"> <span>Balkon:</span> <span>ano</span> </li>
      <li class="detail-information__data-item"> <span>Energetická náročnost budovy:</span> <span>G - Mimořádně nehospodárná</span> </li>
    </ul>
  </div>
</div>`;

test("Habrmanova: vlastnictví družstevní, panelový dům, stav dobrý, balkon, PENB G", () => {
  const params = extractRealitymixParams(cheerio.load(HABRMANOVA));
  assert.deepEqual(params, { ownership: "Družstevní", condition: "Dobrý", buildingType: "Panelová", energyRating: "G", balcony: "Ano" });
});

test("podlaží se záměrně nečte (číslo podlaží v domě nerozlišuje patro a nadzemní podlaží)", () => {
  const params = extractRealitymixParams(cheerio.load(HABRMANOVA));
  assert.equal(params.floorInfo, undefined);
});

test("osobní vlastnictví a ano/ne/plocha u vybavení; neznámé hodnoty se přeskočí", () => {
  assert.deepEqual(
    paramsFromPairs({
      "vlastnictví": "osobní",
      "výtah": "ne",
      "balkon": "5 m²",
      "lodžie": "ano",
      "terasa": "možná",
      "sklep": "Ano",
      "parkování": "",
      "garáž": "ne",
    }),
    { ownership: "Osobní", elevator: "Ne", balcony: "Ano (5 m²)", loggia: "Ano", cellar: "Ano", garage: "Ne" }
  );
  assert.equal(paramsFromPairs(new Map([["vlastnictví", "státní/obecní"]])).ownership, "Státní/obecní"); // hodnota mimo nabídku formuláře se zachová
});

test("stránka bez bloku parametrů (nebo s prázdnými hodnotami) vrátí prázdný objekt", () => {
  assert.deepEqual(extractRealitymixParams(cheerio.load("<html><body><p>nic</p></body></html>")), {});
  assert.deepEqual(extractRealitymixParams(cheerio.load('<ul><li class="detail-information__data-item"><span>Vlastnictví:</span><span> </span></li></ul>')), {});
  assert.deepEqual(paramsFromPairs({}), {});
});

test("při duplicitním popisku platí první výskyt; energetická třída jen písmeno A–G", () => {
  const html = `<ul><li class="detail-information__data-item"><span>Vlastnictví:</span><span>osobní</span></li><li class="detail-information__data-item"><span>Vlastnictví:</span><span>družstevní</span></li></ul>`;
  assert.equal(extractRealitymixParams(cheerio.load(html)).ownership, "Osobní");
  assert.equal(paramsFromPairs({ "energetická náročnost budovy": "B - Velmi úsporná" }).energyRating, "B");
  assert.equal(paramsFromPairs({ "energetická náročnost budovy": "neuvedeno" }).energyRating, undefined);
});
