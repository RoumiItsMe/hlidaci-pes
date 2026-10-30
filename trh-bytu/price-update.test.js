// node --test trh-bytu/price-update.test.js
// Sběr projde všechny nabídky a zapíše každou změnu ceny — i to, že se z "Dohodou" stala cena (Dukelská, 10/2026:
// nabídka vznikla bez ceny, Sreality později uvedlo 2 990 000 Kč, ale appka ji nikdy nezapsala).
import test from "node:test";
import assert from "node:assert/strict";
import { planPriceUpdate } from "./price-update.js";

const row = (price_czk, price_from_text = 0) => ({ price_czk, price_from_text });

test("z 'Dohodou' (bez ceny) na konkrétní cenu: cena se zapíše a vznikne událost s prázdnou původní cenou", () => {
  assert.deepEqual(planPriceUpdate(row(null), 2_990_000), {
    fields: { price_czk: 2_990_000 },
    event: { old_price_czk: null, new_price_czk: 2_990_000 },
  });
});

test("změna ceny nahoru i dolů se zapíše s původní a novou cenou", () => {
  assert.deepEqual(planPriceUpdate(row(3_290_000), 2_990_000), { fields: { price_czk: 2_990_000 }, event: { old_price_czk: 3_290_000, new_price_czk: 2_990_000 } });
  assert.deepEqual(planPriceUpdate(row(2_990_000), 3_190_000), { fields: { price_czk: 3_190_000 }, event: { old_price_czk: 2_990_000, new_price_czk: 3_190_000 } });
});

test("stejná cena: nic se nemění", () => {
  assert.equal(planPriceUpdate(row(2_990_000), 2_990_000), null);
});

test("cena → 'Dohodou': nic se nezapisuje, poslední známá cena zůstává", () => {
  assert.equal(planPriceUpdate(row(2_990_000), null), null);
  assert.equal(planPriceUpdate(row(null), null), null);
  assert.equal(planPriceUpdate(row(2_990_000, 1), null), null); // ani cena z textu se bez ceny z portálu nemění
});

test("cena z textu inzerátu: jakmile ji portál uvádí sám, přestane být 'z textu' (i při stejné ceně, bez události)", () => {
  assert.deepEqual(planPriceUpdate(row(3_290_000, 1), 3_290_000), { fields: { price_from_text: 0 }, event: null });
  assert.deepEqual(planPriceUpdate(row(3_290_000, 1), 2_990_000), {
    fields: { price_czk: 2_990_000, price_from_text: 0 },
    event: { old_price_czk: 3_290_000, new_price_czk: 2_990_000 },
  });
});
