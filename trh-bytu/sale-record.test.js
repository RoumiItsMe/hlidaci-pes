// node --test trh-bytu/sale-record.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { buildSaleRecordUpdates, currentSaleState, unitConfirmInput, assumedSalePrice, statsSalePrice, isAlmostSold, saleEvidence, ASSUMED_PRICE_DISCOUNT } from "./sale-record.js";

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
    kn_plomba_end: null,
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

test("currentSaleState čte verdikt, vklad, odhad a konec plomby ze skupiny nabídek", () => {
  const members = [{ id: "a", sale_verdict: null }, { id: "b", sale_verdict: "sold", kn_filed_at: "2026-10-09", kn_auto_unit: "412/5", kn_plomba_end: "2026-10-30" }];
  assert.deepEqual(currentSaleState(members), { verdict: "sold", filedAt: "2026-10-09", autoUnit: "412/5", plombaEnd: "2026-10-30" });
});

test("družstevní byt: poslední inzerovaná cena se do statistik počítá snížená o 10 %", () => {
  assert.equal(ASSUMED_PRICE_DISCOUNT, 0.1);
  assert.equal(assumedSalePrice(3000000), 2700000);
  assert.equal(assumedSalePrice(2850000), 2565000);
  assert.equal(assumedSalePrice(2999999), 2699999); // zaokrouhleno na koruny
  assert.equal(assumedSalePrice(null), null);
});

test("cena pro statistiky: ověřená vždy vyhrává; neověřená poslední cena je −10 % (nejde ověřit / čeká na ověření)", () => {
  assert.deepEqual(statsSalePrice({ verified: 2850000, price: 3100000, assumed: true }), { price: 2850000, basis: "verified" }); // Spořitelní: ruční cena zůstává
  assert.deepEqual(statsSalePrice({ verified: 3300000, price: 3800000, assumed: false }), { price: 3300000, basis: "verified" });
  assert.deepEqual(statsSalePrice({ verified: null, price: 3000000, assumed: true }), { price: 2700000, basis: "assumed" });
  assert.deepEqual(statsSalePrice({ verified: null, price: 3800000, assumed: false }), { price: 3420000, basis: "pending" }); // např. Lukesova
  assert.deepEqual(statsSalePrice({ verified: null, price: null, assumed: true }), { price: null, basis: "none" });
  assert.deepEqual(statsSalePrice({ verified: null, price: null, assumed: false }), { price: null, basis: "none" });
});

test("aspoň částečně prodaný: prodaný, rezervovaný, nebo po rezervaci zmizelý; zmizelý bez rezervace a neprodaný ne", () => {
  assert.equal(isAlmostSold({ status: "sold", verdict: null, wasReserved: false }), true); // portál říká prodáno
  assert.equal(isAlmostSold({ status: "removed", verdict: null, wasReserved: true }), true); // rezervace → zmizelo
  assert.equal(isAlmostSold({ status: "sold", verdict: "sold", wasReserved: false }), true); // verdikt "prodáno" dává stav sold (group.js)
  assert.equal(isAlmostSold({ status: "removed", verdict: null, wasReserved: false }), false); // jen možný prodej
  assert.equal(isAlmostSold({ status: "removed", verdict: "withdrawn", wasReserved: true }), false); // ověřeno: neprodáno
  assert.equal(isAlmostSold({ status: "sold", verdict: "withdrawn", wasReserved: true }), false);
  assert.equal(isAlmostSold({ status: "reserved", verdict: null, wasReserved: true }), true); // rezervace = aspoň částečný prodej
  assert.equal(isAlmostSold({ status: "reserved", verdict: "withdrawn", wasReserved: true }), false);
  assert.equal(saleEvidence("sold"), "sold");
  assert.equal(saleEvidence("reserved"), "reserved");
  assert.equal(saleEvidence("removed"), "gone");
  assert.equal(isAlmostSold({ status: "active", verdict: null, wasReserved: false }), false);
});

test("konec plomby: platné datum (i budoucí) se uloží, prázdné ho smaže, neplatné ignoruje; prodej sám neimplikuje", () => {
  assert.deepEqual(build({ plombaEnd: "2026-11-20" }), { kn_plomba_end: "2026-11-20", kn_checked_at: null }); // i v budoucnu, bez verdiktu; nový konec ruší dřívější odložení
  assert.deepEqual(build({ plombaEnd: "" }, { ...sold, plombaEnd: "2026-11-20" }), { kn_plomba_end: null, kn_checked_at: null });
  assert.deepEqual(build({ plombaEnd: "" }, sold), { kn_plomba_end: null }); // nebylo co mazat
  assert.deepEqual(build({ plombaEnd: "brzy" }), {});
  assert.deepEqual(build({ plombaEnd: undefined }), {});
  // Vrácení mezi nerozhodnuté konec plomby smaže spolu s vkladem.
  assert.equal(build({ reset: true }, sold).kn_plomba_end, null);
});

test("změna konce plomby zruší dřívější odložení; stejná hodnota při dalším uložení ne", () => {
  const withCheck = { verdict: "sold", filedAt: "2026-10-09", autoUnit: null, plombaEnd: null };
  assert.equal(build({ plombaEnd: "2026-10-13" }, withCheck).kn_checked_at, null); // nový konec → připomínky znovu
  const same = { ...withCheck, plombaEnd: "2026-10-13" };
  assert.equal("kn_checked_at" in build({ plombaEnd: "2026-10-13" }, same), false); // totéž pole z formuláře → "Zatím nic" platí dál
  assert.equal(build({ plombaEnd: "" }, same).kn_checked_at, null); // smazání je taky změna
  assert.equal("kn_checked_at" in build({ price: "3000000" }, same), false); // jiná pole to neovlivní
});

test("'To je ten byt': zapíše jednotku, vklad podán a LV; nečitelná jednotka nezapíše nic", () => {
  const input = unitConfirmInput({ unit_number: "93/4", kn_filed_at: "2026-10-01", lv_number: "6797" }, none, "2026-10-27");
  assert.deepEqual(input, { verdict: "sold", unit: "93/4", filedAt: "2026-10-01", lv: "6797", plombaEnd: undefined });
  assert.equal(unitConfirmInput({ unit_number: "garáž" }, none, "2026-10-27"), null);
  assert.equal(unitConfirmInput({}, none, "2026-10-27"), null);
});

test("'To je ten byt': den podání bez dne (nebo neplatný) je dnešek, už zapsaný den se nepřepíše, prázdné LV nic nemaže", () => {
  assert.equal(unitConfirmInput({ unit_number: "93/4" }, none, "2026-10-27").filedAt, "2026-10-27");
  assert.equal(unitConfirmInput({ unit_number: "93/4", kn_filed_at: "včera" }, none, "2026-10-27").filedAt, "2026-10-27");
  assert.equal(unitConfirmInput({ unit_number: "93/4", kn_filed_at: "2026-10-01" }, { ...none, filedAt: "2026-09-20" }, "2026-10-27").filedAt, undefined);
  assert.equal(unitConfirmInput({ unit_number: "93/4", lv_number: "  " }, none, "2026-10-27").lv, undefined);
});

test("'To je ten byt' u skončeného řízení: konec plomby se zapíše a cenu pak jde zjistit hned (zruší dřívější 'Zatím nic')", () => {
  const checked = { verdict: null, filedAt: null, autoUnit: null, plombaEnd: null };
  const input = unitConfirmInput({ unit_number: "93/4", kn_filed_at: "2026-10-01", kn_plomba_end: "2026-10-27" }, checked, "2026-10-27");
  assert.equal(input.plombaEnd, "2026-10-27");
  const updates = buildSaleRecordUpdates({ input, current: checked, now: "2026-10-27T10:00:00.000Z" });
  assert.equal(updates.kn_plomba_end, "2026-10-27");
  assert.equal(updates.unit_number, "93/4");
  assert.equal(updates.sale_verdict, "sold");
});

test("'To je ten byt': konec plomby se nepřepíše, neplatný ani budoucí den se ignoruje, bez něj se nic nezapíše", () => {
  const fields = { unit_number: "93/4", kn_plomba_end: "2026-10-27" };
  assert.equal(unitConfirmInput(fields, { ...none, plombaEnd: "2026-10-20" }, "2026-10-27").plombaEnd, undefined);
  assert.equal(unitConfirmInput({ ...fields, kn_plomba_end: "2026-11-30" }, none, "2026-10-27").plombaEnd, undefined);
  assert.equal(unitConfirmInput({ ...fields, kn_plomba_end: "brzy" }, none, "2026-10-27").plombaEnd, undefined);
  assert.equal(unitConfirmInput({ unit_number: "93/4" }, none, "2026-10-27").plombaEnd, undefined);
});
