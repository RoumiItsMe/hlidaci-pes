// node --test trh-bytu/sale-record.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { buildSaleRecordUpdates, currentSaleState } from "./sale-record.js";

const NOW = "2026-10-14T10:00:00.000Z";
const none = { verdict: null, filedAt: null, autoUnit: null };
const sold = { verdict: "sold", filedAt: null, autoUnit: null };
const build = (input, current = none) => buildSaleRecordUpdates({ input, current, now: NOW });

test("cena zadaná kdekoli znamená prodáno: zapíše i verdikt (případ Spořitelní, Letohrad)", () => {
  assert.deepEqual(build({ price: "2850000", saleDate: "2026-09-30" }), {
    verified_sale_price_czk: 2850000,
    verified_sale_date: "2026-09-30",
    sale_verdict: "sold",
    kn_checked_at: NOW,
  });
});

test("datum prodeje i podaný vklad samy o sobě taky znamenají prodáno", () => {
  assert.equal(build({ saleDate: "2026-09-30" }).sale_verdict, "sold");
  assert.equal(build({ filedAt: "2026-09-24" }).sale_verdict, "sold");
});

test("už prodaný byt: úprava ceny verdikt ani čas kontroly nepřepisuje", () => {
  assert.deepEqual(build({ price: "3100000" }, sold), { verified_sale_price_czk: 3100000 });
});

test("cena u bytu označeného 'neprodáno' ho přepne na prodáno (cena je důkaz prodeje)", () => {
  const u = build({ price: "3100000" }, { verdict: "withdrawn", filedAt: null, autoUnit: null });
  assert.equal(u.sale_verdict, "sold");
});

test("vymazání ceny a data je jen vymazání — prodej tím nezmizí", () => {
  assert.deepEqual(build({ price: "", saleDate: null }, sold), { verified_sale_price_czk: null, verified_sale_date: null });
  assert.equal(build({ price: "" }).sale_verdict, undefined);
});

test("neplatné hodnoty se berou jako beze změny, nic nevymažou", () => {
  assert.deepEqual(build({ price: "abc", saleDate: "včera", filedAt: "9.10.", lv: "<script>" }), {});
  assert.deepEqual(build({ price: "-5" }), {});
  assert.deepEqual(build({ price: "0" }), {});
});

test("podání vkladu v budoucnu se ořízne na dnešek", () => {
  assert.equal(build({ filedAt: "2999-01-01" }).kn_filed_at, "2026-10-14");
  assert.equal(build({ filedAt: "2026-10-09" }).kn_filed_at, "2026-10-09");
});

test("LV: platné se uloží, prázdné vymaže, nepřípustné znaky ignoruje", () => {
  assert.equal(build({ lv: " 4138 " }).lv_number, "4138");
  assert.equal(build({ lv: "" }).lv_number, null);
  assert.equal("lv_number" in build({ lv: "4138; DROP" }), false);
  assert.equal("lv_number" in build({ lv: undefined }), false);
});

test("jednotka: zápis '4120012' z API se sjednotí na 412/12, volný text zůstane, ruční jednotka zruší odhad", () => {
  assert.equal(build({ unit: "4120012" }).unit_number, "412/12");
  assert.equal(build({ unit: " 412 / 12 " }).unit_number, "412/12");
  assert.equal(build({ unit: "byt 12" }).unit_number, "byt 12");
  assert.equal(build({ unit: "" }).unit_number, null);
  const withGuess = build({ unit: "412/7" }, { verdict: "sold", filedAt: "2026-10-09", autoUnit: "412/5" });
  assert.equal(withGuess.unit_number, "412/7");
  assert.equal(withGuess.kn_auto_unit, null);
  assert.equal("kn_auto_unit" in build({ unit: "412/7" }), false); // není co rušit
});

test("výslovný verdikt vyhrává a zapíše čas kontroly", () => {
  assert.deepEqual(build({ verdict: "withdrawn" }), { sale_verdict: "withdrawn", kn_checked_at: NOW });
  // I s cenou: výslovné 'neprodáno' (z fronty) nepřebije zjevný nesmysl, ale pravidlo je jednoduché — co přišlo výslovně, platí.
  assert.equal(build({ verdict: "withdrawn", price: "1" }).sale_verdict, "withdrawn");
});

test("'Zatím nic' jen zapíše čas kontroly", () => {
  assert.deepEqual(build({ checked: true }), { kn_checked_at: NOW });
  assert.deepEqual(build({ checked: true, lv: "4138" }), { lv_number: "4138", kn_checked_at: NOW });
});

test("vrácení mezi nerozhodnuté smaže verdikt, vklad, cenu i datum prodeje; zrušený odhad appky ho vypne natrvalo", () => {
  assert.deepEqual(build({ reset: true }, sold), {
    sale_verdict: null,
    kn_checked_at: null,
    kn_filed_at: null,
    kn_digest_cp: null,
    verified_sale_price_czk: null,
    verified_sale_date: null,
  });
  const guessed = build({ reset: true }, { verdict: "sold", filedAt: "2026-10-09", autoUnit: "412/5" });
  assert.equal(guessed.kn_auto_unit, null);
  assert.equal(guessed.kn_auto_off, 1);
  // Cena znamená prodáno, takže se byt s cenou mezi nerozhodnuté vrátit nedá — LV a jednotka ale zůstávají.
  assert.equal(guessed.verified_sale_price_czk, null);
  assert.equal("lv_number" in guessed, false);
  assert.equal("unit_number" in guessed, false);
});

test("fronta Katastr: 'Vklad podán' s prázdnými poli nic dalšího nepřepíše", () => {
  const u = build({ verdict: "sold", filedAt: "2026-10-09", lv: undefined, unit: undefined });
  assert.deepEqual(u, { kn_filed_at: "2026-10-09", sale_verdict: "sold", kn_checked_at: NOW });
});

test("currentSaleState čte verdikt, vklad a odhad ze skupiny nabídek", () => {
  const members = [{ id: "a", sale_verdict: null }, { id: "b", sale_verdict: "sold", kn_filed_at: "2026-10-09", kn_auto_unit: "412/5" }];
  assert.deepEqual(currentSaleState(members), { verdict: "sold", filedAt: "2026-10-09", autoUnit: "412/5" });
});
