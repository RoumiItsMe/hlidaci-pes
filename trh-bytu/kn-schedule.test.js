// node --test trh-bytu/kn-schedule.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { assessSaleTrack, buildSaleTrack, filingLagDays, median, RESERVATION_CHECK_DAYS, FILING_CHECK_DAYS } from "./kn-schedule.js";

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse("2026-08-01T08:00:00.000Z"); // začátek rezervace
const at = (dayOffset) => T0 + dayOffset * DAY;
const iso = (ms) => new Date(ms).toISOString();

function filing(dayNow, extra = {}) {
  return assessSaleTrack({ reservedAt: iso(T0), now: at(dayNow), ...extra });
}

test("první dva týdny po rezervaci se nic nepřipomíná", () => {
  const t = filing(10);
  assert.equal(t.stage, "filing");
  assert.equal(t.due, false);
  assert.equal(t.nextAt, at(14));
  assert.equal(t.ageDays, 10);
});

test("14. den je kontrola pro hotovostního kupce", () => {
  const t = filing(15);
  assert.equal(t.due, true);
  assert.equal(t.kind, "cash");
  assert.match(t.reason, /hotovostního kupce/);
});

test('"Zatím nic" odsune byt až k dalšímu kontrolnímu bodu, ne o pevný počet dní', () => {
  const checked = iso(at(15));
  assert.equal(filing(20, { lastCheckedAt: checked }).due, false);
  assert.equal(filing(27, { lastCheckedAt: checked }).due, false);
  const second = filing(29, { lastCheckedAt: checked });
  assert.equal(second.due, true);
  assert.equal(second.kind, "cash"); // 28. den
  // po kontrole 28. dne se čeká na 45. den
  const t = filing(40, { lastCheckedAt: iso(at(29)) });
  assert.equal(t.due, false);
  assert.equal(t.nextAt, at(45));
});

test("okno hypotéky: od 45. dne týdně", () => {
  assert.equal(filing(46).kind, "mortgage");
  const checked = iso(at(46));
  assert.equal(filing(51, { lastCheckedAt: checked }).due, false);
  assert.equal(filing(52, { lastCheckedAt: checked }).due, true);
});

test("vynechané běhy nestlačí rozvrh — po týdnech ticha je splatný jen jeden bod", () => {
  const t = filing(75); // appka neběžela, nic nezkontrolováno
  assert.equal(t.due, true);
  assert.equal(t.dueAt, at(73)); // nejnovější bod, ne hromada starých
});

test("zmizení rezervovaného inzerátu plánuje kontrolu za 3 a 10 dní", () => {
  const removed = iso(at(30));
  const checked = iso(at(31));
  assert.equal(filing(32, { removedAt: removed, lastCheckedAt: checked }).due, false);
  const t = filing(34, { removedAt: removed, lastCheckedAt: checked });
  assert.equal(t.due, true);
  assert.equal(t.kind, "vanish");
  assert.equal(filing(41, { removedAt: removed, lastCheckedAt: iso(at(34)) }).due, true); // 10 dní po zmizení
});

test("po posledním bodu bez nálezu je byt nezjištěno a nic nepřipomíná", () => {
  const last = RESERVATION_CHECK_DAYS[RESERVATION_CHECK_DAYS.length - 1];
  const t = filing(last + 5, { lastCheckedAt: iso(at(last + 1)) });
  assert.equal(t.due, false);
  assert.equal(t.expired, true);
  assert.equal(t.nextAt, null);
  // ale kdo ho po posledním bodu nezkontroloval, má ho pořád k vyřízení
  assert.equal(filing(last + 5, { lastCheckedAt: iso(at(last - 5)) }).due, true);
});

test("vklad podán: prodej je potvrzený a cena se hledá až 25. den po podání", () => {
  const filedAt = iso(at(60)).slice(0, 10);
  const justFiled = filing(61, { filedAt, verdict: "sold", lastCheckedAt: iso(at(61)) });
  assert.equal(justFiled.stage, "price");
  assert.equal(justFiled.due, false);
  assert.equal(justFiled.nextAt, Date.parse(filedAt) + FILING_CHECK_DAYS[0] * DAY);
  const due = filing(60 + 26, { filedAt, verdict: "sold", lastCheckedAt: iso(at(61)) });
  assert.equal(due.due, true);
  assert.equal(due.kind, "price");
  assert.match(due.reason, /zjisti kupní cenu/);
});

test("známá cena = hotovo, neprodáno = konec", () => {
  assert.equal(filing(100, { verdict: "sold", filedAt: "2026-09-20", priceKnown: true }).stage, "done");
  assert.equal(filing(100, { verdict: "sold", priceKnown: true }).due, false);
  const w = filing(100, { verdict: "withdrawn" });
  assert.equal(w.stage, "withdrawn");
  assert.equal(w.due, false);
});

test('"Prodáno" bez plomby a bez ceny (např. z Telegramu) přejde do fáze ceny od označení', () => {
  const marked = iso(at(40));
  const t = filing(70, { verdict: "sold", priceBaseAt: marked, lastCheckedAt: marked });
  assert.equal(t.stage, "price");
  assert.equal(t.due, true); // 30 dní po označení
});

function listing(id, extra = {}) {
  return { id, source: "sreality", status: "reserved", removed_at: null, first_seen_at: iso(at(-20)), ...extra };
}

test("buildSaleTrack: byt bez rezervace nebo v nabídce není ve frontě", () => {
  assert.equal(buildSaleTrack([listing("a", { status: "active" })], [], at(30)), null);
  const events = [{ listing_id: "a", event_type: "reserved", occurred_at: iso(T0) }];
  assert.equal(buildSaleTrack([listing("a", { status: "active" })], [{ ...events[0] }, { listing_id: "a", event_type: "unreserved", occurred_at: iso(at(5)) }], at(30)), null);
});

test("buildSaleTrack: rezervovaný byt počítá rozvrh od data rezervace", () => {
  const events = [{ listing_id: "a", event_type: "reserved", occurred_at: iso(T0) }];
  const t = buildSaleTrack([listing("a")], events, at(15));
  assert.equal(t.stage, "filing");
  assert.equal(t.due, true);
  assert.equal(t.reservedAt, iso(T0));
});

test("buildSaleTrack: zmizelý byt po rezervaci a bod pro zmizení", () => {
  const events = [{ listing_id: "a", event_type: "reserved", occurred_at: iso(T0) }];
  const gone = listing("a", { status: "removed", removed_at: iso(at(30)), kn_checked_at: iso(at(30)) });
  const t = buildSaleTrack([gone], events, at(34));
  assert.equal(t.due, true);
  assert.equal(t.kind, "vanish");
});

test("buildSaleTrack: uložené 'vklad podán' z databáze nastaví fázi ceny", () => {
  const events = [{ listing_id: "a", event_type: "reserved", occurred_at: iso(T0) }];
  const m = listing("a", { status: "removed", removed_at: iso(at(30)), sale_verdict: "sold", kn_filed_at: "2026-09-20", kn_checked_at: iso(at(50)) });
  const t = buildSaleTrack([m], events, at(100));
  assert.equal(t.stage, "price");
  assert.equal(t.due, true);
});

test("filingLagDays a median", () => {
  assert.equal(filingLagDays(iso(T0), iso(at(62))), 62);
  assert.equal(filingLagDays(iso(T0), null), null);
  assert.equal(filingLagDays(iso(at(5)), iso(T0)), null);
  assert.equal(median([62, 14, 80]), 62);
  assert.equal(median([14, 80]), 47);
  assert.equal(median([]), null);
});
