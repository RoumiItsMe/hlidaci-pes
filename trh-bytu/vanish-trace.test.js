// node --test trh-bytu/vanish-trace.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { vanishedUnreserved, findBulkDelistings, categorize, traceVanished, BULK_MIN_FLATS, WATCH_HORIZON_DAYS } from "./vanish-trace.js";

const NOW = Date.parse("2026-10-21T10:00:00Z");
const day = (n) => new Date(NOW - n * 86400000).toISOString();
let n = 0;

/** Zjednodušený "entry" z computeEntries — jen to, co modul čte. */
function entry(over = {}) {
  n++;
  const { source = "sreality", ...rest } = over;
  return {
    hidden: false,
    status: "removed",
    saleVerdict: null,
    track: null,
    almostSold: false,
    rep: { id: `${source}:${n}`, disposition: "2+1", area_m2: 50 + n },
    city: "Žamberk",
    address: "Žamberk",
    removedAt: day(10),
    addressInfo: { state: "missing", exact: null },
    unreservedWatch: null,
    newBuildPending: false,
    unverifiable: false,
    g: { members: [{ source }] },
    ...rest,
  };
}

test("výběr: jen zmizelé, neskryté, bez rezervace a bez rozhodnutí z katastru", () => {
  const ok = entry();
  const flats = [
    ok,
    entry({ hidden: true }),
    entry({ status: "active" }),
    entry({ status: "reserved" }),
    entry({ saleVerdict: "withdrawn" }),
    entry({ saleVerdict: "sold" }),
    entry({ track: { stage: "filing" } }), // po rezervaci — má vlastní frontu
  ];
  assert.deepEqual(vanishedUnreserved(flats), [ok]);
});

test("stažený balík: aspoň 3 byty z jednoho portálu a města zmizely týž den a dva jsou stejného typu", () => {
  const a = entry({ rep: { id: "sreality:a", disposition: "2+kk", area_m2: 69 } });
  const b = entry({ rep: { id: "sreality:b", disposition: "2+kk", area_m2: 69.2 } });
  const c = entry({ rep: { id: "sreality:c", disposition: "1+kk", area_m2: 51 } }); // jiný typ, ale týž den
  assert.deepEqual([...findBulkDelistings([a, b, c])].map((e) => e.rep.id).sort(), ["sreality:a", "sreality:b", "sreality:c"]);
  assert.equal(BULK_MIN_FLATS, 3);
});

test("stažený balík to není: málo bytů, jiný den, jiné město, jiný portál, žádná dvojice, víc portálů", () => {
  const twin = (over) => entry({ rep: { id: `sreality:${Math.random()}`, disposition: "2+kk", area_m2: 69 }, ...over });
  // jen dva byty
  assert.equal(findBulkDelistings([twin(), twin()]).size, 0);
  // tři, ale jeden zmizel jiný den
  assert.equal(findBulkDelistings([twin(), twin(), twin({ removedAt: day(11) })]).size, 0);
  // tři, ale jiné město u jednoho
  assert.equal(findBulkDelistings([twin(), twin(), twin({ city: "Letohrad" })]).size, 0);
  // tři, ale jiný portál u jednoho
  assert.equal(findBulkDelistings([twin(), twin(), twin({ g: { members: [{ source: "bazos" }] } })]).size, 0);
  // tři bez dvojice stejného typu
  const diff = (d, a) => entry({ rep: { id: `sreality:${Math.random()}`, disposition: d, area_m2: a } });
  assert.equal(findBulkDelistings([diff("1+kk", 30), diff("2+kk", 50), diff("3+kk", 80)]).size, 0);
  // byt na víc portálech (skutečné zmizení z trhu) se do balíku nepočítá
  const multi = () => twin({ g: { members: [{ source: "sreality" }, { source: "idnes" }] } });
  assert.equal(findBulkDelistings([multi(), multi(), multi()]).size, 0);
  // bez města nebo data zmizení nejde seskupit
  assert.equal(findBulkDelistings([twin({ city: null }), twin({ city: null }), twin({ city: null })]).size, 0);
});

test("zmizení těsně před půlnocí a po ní se do jednoho dne nepočítá (pražský den)", () => {
  const at = (iso) => entry({ rep: { id: `sreality:${Math.random()}`, disposition: "2+kk", area_m2: 69 }, removedAt: iso });
  // 21:30 UTC je ještě týž pražský den jako 10:00 UTC; 22:30 UTC už je další
  assert.equal(findBulkDelistings([at("2026-10-07T08:00:00Z"), at("2026-10-07T09:00:00Z"), at("2026-10-07T21:30:00Z")]).size, 3);
  assert.equal(findBulkDelistings([at("2026-10-07T08:00:00Z"), at("2026-10-07T09:00:00Z"), at("2026-10-07T22:30:00Z")]).size, 0);
});

test("kategorie: hlídá se / hlídání skončilo / nejde ověřit / nedohledatelná / adresa bez domu / chybí adresa", () => {
  const known = { state: "known", exact: "Lukesova 1, Ústí nad Orlicí" };
  assert.equal(categorize(entry({ addressInfo: known, unreservedWatch: { unverifiable: false } }), { now: NOW }), "watched");
  assert.equal(categorize(entry({ addressInfo: known, unreservedWatch: { unverifiable: false }, removedAt: day(WATCH_HORIZON_DAYS + 1) }), { now: NOW }), "closed");
  assert.equal(categorize(entry({ addressInfo: known, unreservedWatch: { unverifiable: false }, removedAt: day(WATCH_HORIZON_DAYS) }), { now: NOW }), "watched"); // hranice včetně
  assert.equal(categorize(entry({ addressInfo: known, unreservedWatch: { unverifiable: true } }), { now: NOW }), "unverifiable"); // dům bez jednotek
  assert.equal(categorize(entry({ addressInfo: known, newBuildPending: true }), { now: NOW }), "unverifiable"); // novostavba před dokončením
  assert.equal(categorize(entry({ addressInfo: known, unreservedWatch: null }), { now: NOW }), "noWatch");
  assert.equal(categorize(entry({ addressInfo: { state: "notNeeded" } }), { now: NOW }), "unverifiable"); // družstevní
  assert.equal(categorize(entry({ addressInfo: { state: "unknown" } }), { now: NOW }), "unknown");
  assert.equal(categorize(entry({ addressInfo: { state: "missing" } }), { now: NOW }), "missing");
});

test("adresa má přednost před balíkem: byt z balíku s přesnou adresou se hlídá; bez adresy je 'bulk'", () => {
  const twin = (over) => entry({ rep: { id: `sreality:${Math.random()}`, disposition: "2+kk", area_m2: 69 }, ...over });
  const withAddress = twin({ addressInfo: { state: "known", exact: "Nádražní 1, Žamberk" }, unreservedWatch: { unverifiable: false } });
  const flats = [withAddress, twin(), twin()];
  const bulk = findBulkDelistings(flats);
  assert.equal(categorize(withAddress, { bulk, now: NOW }), "watched");
  assert.equal(categorize(flats[1], { bulk, now: NOW }), "bulk");
  // družstevní byt z balíku je dál "nejde ověřit"
  const coop = twin({ addressInfo: { state: "notNeeded" } });
  assert.equal(categorize(coop, { bulk: new Set([coop]), now: NOW }), "unverifiable");
});

test("souhrn: počty podle kategorií, co se hlídá, co nejde z principu a seznam k záchraně (nejčerstvější první)", () => {
  const known = { state: "known", exact: "Lukesova 1, Ústí nad Orlicí" };
  const twin = (over) => entry({ rep: { id: `sreality:${Math.random()}`, disposition: "3+kk", area_m2: 81 }, city: "Letohrad", ...over });
  const flats = [
    entry({ addressInfo: known, unreservedWatch: { unverifiable: false } }), // watched
    entry({ addressInfo: known, unreservedWatch: { unverifiable: false } }), // watched
    entry({ addressInfo: { state: "notNeeded" } }), // unverifiable
    twin({ removedAt: day(14) }), // bulk
    twin({ removedAt: day(14) }), // bulk
    twin({ removedAt: day(14) }), // bulk
    entry({ addressInfo: { state: "unknown" } }), // unknown
    entry({ addressInfo: { state: "missing" }, removedAt: day(15), rep: { id: "bazos:stary", disposition: "2+1", area_m2: 61.7 }, address: "Žamberk", city: "Žamberk" }),
    entry({ addressInfo: { state: "missing" }, removedAt: day(3), rep: { id: "bazos:novy", disposition: "3+1", area_m2: null }, address: "Letohrad", city: "Letohrad" }),
    entry({ addressInfo: known, unreservedWatch: null, removedAt: day(40), rep: { id: "sreality:bez-domu", disposition: "1+1", area_m2: 30 } }), // noWatch
    entry({ hidden: true }), // skrytý se nepočítá
    entry({ saleVerdict: "withdrawn" }), // rozhodnutý se nepočítá
  ];
  const t = traceVanished(flats, { now: NOW });
  assert.equal(t.total, 10);
  assert.deepEqual(t.counts, { watched: 2, closed: 0, unverifiable: 1, bulk: 3, unknown: 1, noWatch: 1, missing: 2 });
  assert.equal(t.traceable, 2);
  assert.equal(t.untraceable, 5); // družstevní + 3× balík + nedohledatelná
  assert.deepEqual(t.actionable.map((a) => [a.id, a.category, a.daysGone]), [["bazos:novy", "missing", 3], ["bazos:stary", "missing", 15], ["sreality:bez-domu", "noWatch", 40]]);
  assert.equal(t.actionable[0].label, "3+1"); // bez plochy
  assert.equal(t.actionable[1].label, "2+1, 61.7 m²");
  assert.equal(t.actionable[1].address, "Žamberk");
  assert.match(t.actionable[2].why, /dům v katastru appka nenašla/);
});

test("prázdný vstup: nula všude, nic k záchraně", () => {
  const t = traceVanished([], { now: NOW });
  assert.equal(t.total, 0);
  assert.deepEqual(t.actionable, []);
  assert.equal(t.traceable + t.untraceable, 0);
});
