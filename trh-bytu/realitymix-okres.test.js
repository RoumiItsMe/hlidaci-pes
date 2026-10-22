// node --test trh-bytu/realitymix-okres.test.js
// Hlídací pes (index.js) bere RealityMIX přes sources/realitymix.js — ten výpis města doplňuje
// "podobnými" nabídkami z jiných okresů; test hlídá, že se nehlásí (Telegram o nových nabídkách).
import test from "node:test";
import assert from "node:assert/strict";
import { isInsideOkres, fetchRealitymix } from "../sources/realitymix.js";
import { watches } from "../config.js";

const WATCH = watches.find((w) => w.key === "byty");
const LABELS = WATCH.locations.map((l) => l.label);

test("adresy z okresu Ústí nad Orlicí a z okresního města samotného zůstanou (i bez diakritiky, s částí obce)", () => {
  for (const a of [
    "Jilemnického, Ústí nad Orlicí",
    "Dukelská, Hylváty, Ústí nad Orlicí",
    "Knapovec, Ústí nad Orlicí",
    "U Dvora, Letohrad, okr. Ústí nad Orlicí",
    "Truby, Česká Třebová, okr. Ústí nad Orlicí",
    "SNP, Žamberk, okr. Ústí nad Orlicí",
    // jiné obce téhož okresu se vědomě nevyřazují (hlídá se celý okres, Králíky mají i úřední desku)
    "Nádražní, Králíky, okr. Ústí nad Orlicí",
    "Mlýnice, Červená Voda, okr. Ústí nad Orlicí",
    "mlynice, cervena voda, okr. usti nad orlici",
    "Kunčice, Letohrad", // bez "okr.", ale sledovaná lokalita
  ]) {
    assert.equal(isInsideOkres(a, LABELS), true, a);
  }
});

test("nabídky z Pardubic a jiných okresů (reálné případy z Telegramu) se vyřadí", () => {
  for (const a of [
    "Gagarinova, Pardubice II, Pardubice",
    "Rokycanova, Pardubice V, Pardubice",
    "Josefa Bublíka, Pardubice VII, Pardubice",
    "náměstí Dukelských hrdinů, Pardubice V, Pardubice",
    "U Sportovní školy, Pardubice VII, Pardubice",
    "Jiráskova, Předměstí, Moravská Třebová, okr. Svitavy",
    "Tylova, Skuteč, okr. Chrudim",
    "Hlavní, Lanškroun, okr. Ústí nad Labem", // jiný okres téhož jména začátku — "Ústí nad Labem" není "Ústí nad Orlicí"
  ]) {
    assert.equal(isInsideOkres(a, LABELS), false, a);
  }
});

test("bez adresy se nic nevyřazuje (nelze posoudit)", () => {
  for (const a of ["", "   ", null, undefined]) assert.equal(isInsideOkres(a, LABELS), true, String(a));
});

// --- celý výpis přes podstrčený fetch ---

function card(id, title, address, price) {
  return `<li class="advert-item"><a href="/detail/x/prodej-bytu-${id}.html"><img alt="${title}"></a><span>${title} ${address} ${price}</span></li>`;
}
const PAGE = `<html><body><ul>
  ${card("8730001", "Prodej bytu, 2+1, 54 m²", "U Dvora, Letohrad, okr. Ústí nad Orlicí", "3 450 000 Kč")}
  ${card("8728227", "Prodej bytu, 1+kk, 26 m²", "Gagarinova, Pardubice II, Pardubice", "3 800 000 Kč")}
  ${card("8730083", "Prodej bytu, 4+1, 82 m²", "Jiráskova, Předměstí, Moravská Třebová, okr. Svitavy", "3 650 000 Kč")}
  ${card("8713317", "Prodej bytu, 3+1, 69 m²", "Nádražní, Králíky, okr. Ústí nad Orlicí", "3 390 000 Kč")}
</ul></body></html>`;

test("fetchRealitymix: výpis města vrátí jen nabídky z okresu — Pardubice a Moravská Třebová ne", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, statusText: "OK", text: async () => PAGE });
  try {
    const items = await fetchRealitymix(WATCH);
    assert.deepEqual(items.map((i) => i.id).sort(), ["8713317", "8730001"]);
    assert.ok(items.every((i) => /Ústí nad Orlicí/.test(i.address)));
  } finally {
    globalThis.fetch = realFetch;
  }
});
