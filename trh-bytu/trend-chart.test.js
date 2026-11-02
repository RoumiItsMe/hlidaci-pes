// node --test trh-bytu/trend-chart.test.js
// Spojnicový graf vývoje cen (trend-chart.js): osa, přerušení čáry, legenda, popisky, bublina.
import test from "node:test";
import assert from "node:assert/strict";
import { lineChartHtml, niceScale } from "./trend-chart.js";

const fmt = (v) => `${v} Kč`;
const chart = (over = {}) =>
  lineChartHtml({
    labels: ["1. 10.", "8. 10.", "15. 10."],
    series: [{ label: "Průměr", color: "var(--series-1)", kind: "line", values: [50, 60, 55] }],
    tips: [{ title: "a", rows: [] }, { title: "b", rows: [] }, { title: "c", rows: [] }],
    formatTick: String,
    formatValue: fmt,
    ariaLabel: "Graf",
    ...over,
  });

test("osa: pěkné kroky, rozsah obsahuje všechna data; u počtů od nuly", () => {
  assert.deepEqual(niceScale(48_300, 61_900), { min: 45_000, max: 65_000, ticks: [45_000, 50_000, 55_000, 60_000, 65_000] });
  assert.deepEqual(niceScale(80, 118, { zero: true }).ticks, [0, 50, 100, 150]);
  const flat = niceScale(100, 100);
  assert.ok(flat.min < 100 && flat.max > 100);
});

test("čára se v obdobích bez hodnoty přeruší (nový úsek), tečky jen u známých hodnot", () => {
  const html = chart({ series: [{ label: "P", color: "var(--series-1)", kind: "line", values: [50, null, 55] }] });
  const d = /<path class="chart-line" d="([^"]+)"/.exec(html)[1];
  assert.equal((d.match(/M/g) ?? []).length, 2);
  assert.equal((d.match(/L/g) ?? []).length, 0);
  assert.equal((html.match(/class="chart-dot"/g) ?? []).length, 2);
});

test("řada jen z teček nemá čáru", () => {
  const html = chart({ series: [{ label: "Prodeje", color: "var(--series-3)", kind: "dots", values: [null, 40, null] }] });
  assert.doesNotMatch(html, /chart-line/);
  assert.equal((html.match(/class="chart-dot"/g) ?? []).length, 1);
});

test("legenda jen u víc řad; jedinou řadu pojmenuje nadpis grafu", () => {
  assert.doesNotMatch(chart(), /chart-legend/);
  const two = chart({
    series: [
      { label: "Průměr", color: "var(--series-1)", kind: "line", values: [50, 60, 55] },
      { label: "Medián", color: "var(--series-2)", kind: "line", values: [40, 45, 42] },
    ],
  });
  assert.match(two, /chart-legend/);
  assert.match(two, /Průměr<\/span>.*Medián<\/span>/s);
});

test("koncové popisky: hodnota posledního období; dva skoro stejné se nepřekrývají (zůstane jen první)", () => {
  const far = chart({
    series: [
      { label: "A", color: "var(--series-1)", kind: "line", values: [50, 60, 100] },
      { label: "B", color: "var(--series-2)", kind: "line", values: [40, 45, 10] },
    ],
  });
  assert.deepEqual([...far.matchAll(/class="chart-end"[^>]*>([^<]+)</g)].map((m) => m[1]), ["100 Kč", "10 Kč"]);
  const close = chart({
    series: [
      { label: "A", color: "var(--series-1)", kind: "line", values: [50, 60, 55] },
      { label: "B", color: "var(--series-2)", kind: "line", values: [40, 45, 54.9] },
    ],
  });
  assert.deepEqual([...close.matchAll(/class="chart-end"[^>]*>([^<]+)</g)].map((m) => m[1]), ["55 Kč"]);
});

test("každé období má plochu pro myš i klávesnici a bublina nese obsah jako escapovaný JSON", () => {
  const html = chart({ tips: [{ title: '<b>"x"</b>', rows: [] }, { title: "b", rows: [] }, { title: "c", rows: [] }] });
  assert.equal((html.match(/class="chart-hit"[^>]*tabindex="0"/g) ?? []).length, 3);
  const attr = /data-tips="([^"]*)"/.exec(html)[1];
  assert.doesNotMatch(attr, /[<>"]/);
  const decoded = attr.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'").replace(/&amp;/g, "&");
  assert.equal(JSON.parse(decoded)[0].title, '<b>"x"</b>');
});

test("bez hodnot žádný graf", () => {
  assert.equal(chart({ series: [{ label: "P", color: "var(--series-1)", kind: "line", values: [null, null, null] }] }), "");
  assert.equal(chart({ labels: [] }), "");
});
