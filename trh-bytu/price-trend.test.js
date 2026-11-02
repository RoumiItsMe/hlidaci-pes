// node --test trh-bytu/price-trend.test.js
// Vývoj cen v čase (price-trend.js): nabídka ke konci období se skládá z historie událostí bytu.
import test from "node:test";
import assert from "node:assert/strict";
import { autoPeriod, entryPriceAt, filterTrendEntries, INITIAL_SCAN_MS, percentChange, periodLabels, periodStart, priceTrend, reservedAt, saleAt, toMs, trendCsv, trendFilterOptions } from "./price-trend.js";

const DAY = 24 * 60 * 60 * 1000;
// Místní čas (období jsou v místním čase): 1. 10. 2026 je čtvrtek.
const day = (d, h = 12) => new Date(2026, 9, d, h).getTime();
const iso = (ms) => new Date(ms).toISOString();

let n = 0;
/** Byt (entry z computeEntries) jen s poli, která vývoj cen čte; `listings` = inzeráty, `events` = jejich události. */
function flat({ listings = null, events = [], price = 3_000_000, area = 50, discoveredAt = day(1), removedAt = null, ...over } = {}) {
  n++;
  const members = listings ?? [{ id: `sreality:${n}`, source: "sreality", price_czk: price, first_seen_at: iso(discoveredAt), removed_at: removedAt == null ? null : iso(removedAt) }];
  const evs = events.length ? events : [{ listing_id: members[0].id, event_type: "created", new_price_czk: price, occurred_at: iso(discoveredAt) }];
  return {
    g: { members },
    rep: { id: members[0].id, area_m2: area, disposition: "2+1" },
    events: evs,
    price, // dnešní (poslední) cena — z ní je odhad prodejní ceny
    discoveredAt: iso(discoveredAt),
    removedAt: removedAt == null ? null : iso(removedAt),
    status: removedAt == null ? "active" : "removed",
    city: "Ústí nad Orlicí",
    address: `Ústí nad Orlicí, ul. ${n}`,
    almostSold: false,
    statsInclude: null,
    saleVerdict: null,
    verifiedSalePrice: null,
    verifiedSaleDate: null,
    knFiledAt: null,
    track: null,
    unverifiable: false,
    ownCondition: null,
    ...over,
  };
}

test("období začínají v místním čase: pondělí, 1. den měsíce, 1. den čtvrtletí", () => {
  assert.equal(periodStart(day(1), "week"), new Date(2026, 8, 28).getTime()); // čt 1. 10. → po 28. 9.
  assert.equal(periodStart(new Date(2026, 9, 26, 0, 0).getTime(), "week"), new Date(2026, 9, 26).getTime()); // pondělí o půlnoci
  assert.equal(periodStart(day(25), "week"), new Date(2026, 9, 19).getTime()); // neděle 25. 10. (den změny času) → po 19. 10.
  assert.equal(periodStart(day(31), "month"), new Date(2026, 9, 1).getTime());
  assert.equal(periodStart(new Date(2026, 11, 31).getTime(), "quarter"), new Date(2026, 9, 1).getTime());
});

test("popisky období do tabulky a pod osu", () => {
  const weekStart = new Date(2026, 9, 26).getTime();
  assert.deepEqual(periodLabels(weekStart, new Date(2026, 10, 2).getTime(), "week"), { label: "26. 10.–1. 11. 2026", short: "26. 10." });
  assert.deepEqual(periodLabels(new Date(2026, 9, 1).getTime(), new Date(2026, 10, 1).getTime(), "month"), { label: "říjen 2026", short: "říj 26" });
  assert.deepEqual(periodLabels(new Date(2026, 9, 1).getTime(), new Date(2027, 0, 1).getTime(), "quarter"), { label: "4. čtvrtletí 2026", short: "Q4 2026" });
});

test("týden přes změnu času má 7 dní a každé období navazuje na předchozí", () => {
  const trend = priceTrend([flat({ discoveredAt: day(20) })], { period: "week", now: day(30), trackingStart: day(20) });
  assert.deepEqual(
    trend.rows.map((r) => [new Date(r.start).getDate(), new Date(r.end).getDate()]),
    [
      [19, 26],
      [26, 2],
    ]
  );
  assert.equal(trend.rows[0].end, trend.rows[1].start);
});

test("výchozí délka období podle délky sledování", () => {
  assert.equal(autoPeriod(day(1), day(1) + 119 * DAY), "week");
  assert.equal(autoPeriod(day(1), day(1) + 120 * DAY), "month");
  assert.equal(autoPeriod(day(1), day(1) + 730 * DAY), "quarter");
});

test("datum bez času (z katastru) je místní půlnoc", () => {
  assert.equal(toMs("2026-10-10"), new Date(2026, 9, 10).getTime());
  assert.equal(toMs(null), null);
});

test("cena v minulosti: poslední cena z událostí do toho okamžiku, před první cenou žádná", () => {
  const e = flat({
    price: 3_100_000,
    events: [
      { listing_id: "x:1", event_type: "created", new_price_czk: 3_300_000, occurred_at: iso(day(1)) },
      { listing_id: "x:1", event_type: "price_change", old_price_czk: 3_300_000, new_price_czk: 3_100_000, occurred_at: iso(day(10)) },
    ],
    listings: [{ id: "x:1", source: "sreality", price_czk: 3_100_000, first_seen_at: iso(day(1)), removed_at: null }],
  });
  assert.equal(entryPriceAt(e, day(1) - 1), null);
  assert.equal(entryPriceAt(e, day(9)), 3_300_000);
  assert.equal(entryPriceAt(e, day(10)), 3_100_000);
});

test("cena v minulosti: inzerát, který cenu dostal až později, ji předtím neměl (dnešní cena se zpětně nepřipisuje)", () => {
  const e = flat({
    listings: [{ id: "bazos:1", source: "bazos", price_czk: 3_200_000, first_seen_at: iso(day(1)), removed_at: null }],
    events: [
      { listing_id: "bazos:1", event_type: "created", new_price_czk: null, occurred_at: iso(day(1)) },
      { listing_id: "bazos:1", event_type: "price_change", old_price_czk: null, new_price_czk: 3_200_000, occurred_at: iso(day(5)) },
    ],
  });
  assert.equal(entryPriceAt(e, day(3)), null);
  assert.equal(entryPriceAt(e, day(5)), 3_200_000);
});

test("cena v minulosti: přednost má inzerát, který tehdy byl v nabídce; bez událostí s cenou platí současná cena", () => {
  const listings = [
    { id: "sreality:old", source: "sreality", price_czk: 3_500_000, first_seen_at: iso(day(1)), removed_at: iso(day(5)) },
    { id: "bazos:new", source: "bazos", price_czk: 3_200_000, first_seen_at: iso(day(6)), removed_at: null },
  ];
  const e = flat({
    listings,
    events: [
      { listing_id: "sreality:old", event_type: "created", new_price_czk: 3_500_000, occurred_at: iso(day(1)) },
      { listing_id: "bazos:new", event_type: "created", new_price_czk: null, occurred_at: iso(day(6)) },
    ],
  });
  assert.equal(entryPriceAt(e, day(3)), 3_500_000);
  // Po 6. 10. je v nabídce jen Bazoš (bez události s cenou → jeho současná cena), i když Sreality má přednost.
  assert.equal(entryPriceAt(e, day(7)), 3_200_000);
});

test("rezervace: od události rezervace do jejího zrušení, zmizení nebo návratu inzerátu", () => {
  const e = flat({
    listings: [{ id: "a:1", source: "sreality", price_czk: 3_000_000, first_seen_at: iso(day(1)), removed_at: null }],
    events: [
      { listing_id: "a:1", event_type: "created", new_price_czk: 3_000_000, occurred_at: iso(day(1)) },
      { listing_id: "a:1", event_type: "reserved", occurred_at: iso(day(5)) },
      { listing_id: "a:1", event_type: "unreserved", occurred_at: iso(day(9)) },
    ],
  });
  assert.equal(reservedAt(e, day(4)), false);
  assert.equal(reservedAt(e, day(5)), true);
  assert.equal(reservedAt(e, day(8)), true);
  assert.equal(reservedAt(e, day(9)), false);
});

test("nabídka ke konci období: jen volné byty v nabídce; průměr a medián za m², probíhající období k dnešku", () => {
  const entries = [
    flat({ price: 3_000_000, area: 50, discoveredAt: day(1) }), // 60 000 Kč/m²
    flat({ price: 4_000_000, area: 50, discoveredAt: day(1) }), // 80 000
    flat({ price: 7_000_000, area: 50, discoveredAt: day(1) }), // 140 000
    flat({ price: 2_000_000, area: 50, discoveredAt: day(1), removedAt: day(3) }), // zmizel ještě v 1. týdnu
    flat({ price: 2_500_000, area: null, discoveredAt: day(1) }), // bez plochy: počítá se do počtu, ne do ceny za m²
    flat({
      price: 9_000_000,
      discoveredAt: day(1),
      listings: [{ id: "r:1", source: "sreality", price_czk: 9_000_000, first_seen_at: iso(day(1)), removed_at: null }],
      events: [
        { listing_id: "r:1", event_type: "created", new_price_czk: 9_000_000, occurred_at: iso(day(1)) },
        { listing_id: "r:1", event_type: "reserved", occurred_at: iso(day(2)) },
      ],
    }), // rezervovaný → v nabídce není
  ];
  const now = day(7);
  const trend = priceTrend(entries, { period: "week", now, trackingStart: day(1) });
  assert.equal(trend.rows.length, 2); // týden 28. 9.–4. 10. a probíhající 5.–11. 10.
  const [firstWeek, current] = trend.rows;
  assert.equal(firstWeek.at, firstWeek.end - 1);
  assert.equal(firstWeek.partial, false);
  assert.deepEqual(firstWeek.stock, { count: 4, priced: 3, avgPerM2: 93_333, medianPerM2: 80_000, medianPrice: 3_500_000 });
  assert.equal(current.partial, true);
  assert.equal(current.at, now);
  assert.equal(current.stock.count, 4);
});

test("cena se v čase mění: starší období mají tehdejší cenu", () => {
  const listings = [{ id: "p:1", source: "sreality", price_czk: 2_500_000, first_seen_at: iso(day(1)), removed_at: null }];
  const e = flat({
    listings,
    events: [
      { listing_id: "p:1", event_type: "created", new_price_czk: 3_000_000, occurred_at: iso(day(1)) },
      { listing_id: "p:1", event_type: "price_change", old_price_czk: 3_000_000, new_price_czk: 2_500_000, occurred_at: iso(day(8)) },
    ],
  });
  const trend = priceTrend([e], { period: "week", now: day(9), trackingStart: day(1) });
  assert.deepEqual(trend.rows.map((r) => r.stock.avgPerM2), [60_000, 50_000]);
});

test("přibylo: první sběr se nepočítá (na trhu už byl); zmizelo podle dne zmizení", () => {
  const start = day(1, 9);
  const entries = [
    flat({ discoveredAt: start }),
    flat({ discoveredAt: start + INITIAL_SCAN_MS - 1 }), // ještě první sběr
    flat({ discoveredAt: start + INITIAL_SCAN_MS }), // už nový
    flat({ discoveredAt: day(6), removedAt: day(9) }),
  ];
  const trend = priceTrend(entries, { period: "week", now: day(10), trackingStart: start });
  assert.deepEqual(
    trend.rows.map((r) => [r.initial, r.added, r.removed]),
    [
      [2, 1, 0],
      [0, 1, 1],
    ]
  );
});

test("prodeje podle data prodeje: katastr > zmizení > rezervace; ověřená cena, jinak odhad; vyřazené se nepočítají", () => {
  const verified = flat({ almostSold: true, status: "sold", removedAt: day(9), verifiedSaleDate: "2026-10-02", verifiedSalePrice: 4_000_000 });
  const gone = flat({ almostSold: true, removedAt: day(8), price: 3_000_000 });
  const reservedOnly = flat({
    almostSold: true,
    status: "reserved",
    price: 2_000_000,
    listings: [{ id: "s:1", source: "sreality", price_czk: 2_000_000, first_seen_at: iso(day(1)), removed_at: null }],
    events: [
      { listing_id: "s:1", event_type: "created", new_price_czk: 2_000_000, occurred_at: iso(day(1)) },
      { listing_id: "s:1", event_type: "reserved", occurred_at: iso(day(6)) },
    ],
  });
  const excluded = flat({ almostSold: true, statsInclude: "exclude", removedAt: day(8) });
  const notSold = flat({ removedAt: day(8) }); // zmizel bez rezervace = jen možný prodej
  assert.equal(saleAt(verified), new Date(2026, 9, 2).getTime());
  assert.equal(saleAt(reservedOnly), day(6));

  const trend = priceTrend([verified, gone, reservedOnly, excluded, notSold], { period: "week", now: day(10), trackingStart: day(1) });
  const [w1, w2] = trend.rows.map((r) => r.sales);
  assert.equal(w1.count, 1);
  assert.equal(w1.avgPerM2, 80_000);
  assert.deepEqual([w1.verified, w1.estimated], [1, 0]);
  assert.equal(w2.count, 2);
  assert.deepEqual([w2.verified, w2.estimated], [0, 2]);
  // Odhad = poslední cena −10 %: 3 000 000 × 0,9 / 50 = 54 000; 2 000 000 × 0,9 / 50 = 36 000.
  assert.deepEqual(w2.items.map((i) => i.pricePerM2), [36_000, 54_000]);
  assert.equal(w2.avgPerM2, 45_000);
});

test("bez dat nebo se začátkem sledování v budoucnu nevzniká žádné období", () => {
  assert.deepEqual(priceTrend([], { now: day(5) }).rows, []);
  assert.deepEqual(priceTrend([flat()], { now: day(5), trackingStart: day(6) }).rows, []);
});

test("filtr: město, dispozice, stav (bez novostaveb, nezadaný, konkrétní)", () => {
  const a = flat({ city: "Ústí nad Orlicí", ownCondition: "novostavba" });
  const b = flat({ city: "Letohrad", ownCondition: "renovated", rep: { id: "b", area_m2: 40, disposition: "1+kk" } });
  const c = flat({ city: "Letohrad", ownCondition: null });
  const ids = (list) => list.map((e) => e.rep.id);
  assert.deepEqual(ids(filterTrendEntries([a, b, c], { city: "Letohrad" })), ids([b, c]));
  assert.deepEqual(ids(filterTrendEntries([a, b, c], { disposition: "1+kk" })), ids([b]));
  assert.deepEqual(ids(filterTrendEntries([a, b, c], { condition: "bez-novostaveb" })), ids([b, c]));
  assert.deepEqual(ids(filterTrendEntries([a, b, c], { condition: "nezadano" })), ids([c]));
  assert.deepEqual(ids(filterTrendEntries([a, b, c], { condition: "renovated" })), ids([b]));
  assert.deepEqual(ids(filterTrendEntries([a, b, c])), ids([a, b, c]));
});

test("volby filtru od nejčastějších", () => {
  const options = trendFilterOptions([flat({ city: "Letohrad" }), flat({ city: "Choceň" }), flat({ city: "Letohrad" })]);
  assert.deepEqual(options.cities, [
    { value: "Letohrad", count: 2 },
    { value: "Choceň", count: 1 },
  ]);
  assert.deepEqual(options.dispositions, [{ value: "2+1", count: 3 }]);
});

test("změna v procentech", () => {
  assert.equal(percentChange(50_000, 55_000), 10);
  assert.equal(percentChange(null, 55_000), null);
  assert.equal(percentChange(50_000, null), null);
});

test("CSV pro Excel: BOM, středníky, ISO data, čísla bez mezer", () => {
  const trend = priceTrend([flat({ price: 3_000_000, area: 50 })], { period: "week", now: day(2), trackingStart: day(1) });
  const csv = trendCsv(trend);
  assert.ok(csv.startsWith("﻿Od;Do;Období;"));
  const [, row] = csv.trim().split("\r\n");
  assert.equal(row, "2026-09-28;2026-10-04;28. 9.–4. 10. 2026;ano;1;1;60000;60000;3000000;0;1;0;0;;0;0");
});
