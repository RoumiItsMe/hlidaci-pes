// node --test trh-bytu/kn-event-flats.test.js
// Událost domu z katastru ("skončilo řízení o vkladu, jednotka 93/4") nemá byt, dokud u žádného sledovaného bytu není
// zapsaná jednotka. Upozornění pak vedlo do obecné fronty Katastr a uživatel nevěděl, který byt kontrolovat.
import test from "node:test";
import assert from "node:assert/strict";
import { candidateGroups, claimingGroup, houseEventsForGroup, filedBeforeRemovalDays, describeFilingGap, HOUSE_EVENT_DAYS } from "./kn-event-flats.js";
import { buildNotifications } from "./notifications.js";

const NOW = Date.parse("2026-10-27T10:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n) => new Date(NOW - n * DAY).toISOString();

// Skupina s jedním členem; `extra` přepíše sloupce inzerátu.
const flat = (id, extra = {}) => ({ members: [{ id, source: id.split(":")[0], status: "removed", removed_at: daysAgo(6), hidden: 0, ...extra }] });
const ended = (extra = {}) => ({ kind: "ended", occurred_at: daysAgo(0), building_id: 7, listing_id: null, detail: { unit: "93/4", lv: 6797, filedAt: "2026-10-01", state: "Odesláno vyrozumění o provedeném vkladu" }, ...extra });
const ids = (groups) => groups.map((g) => g.members[0].id);

test("kandidát: zmizelý byt bez jednotky; jednotku jiného bytu, nabízený, neprodaný a už ověřený byt nikoli", () => {
  const groups = [
    flat("a:gone"),
    flat("a:active", { status: "active", removed_at: null }),
    flat("a:withdrawn", { sale_verdict: "withdrawn", kn_checked_at: daysAgo(1) }),
    flat("a:priced", { verified_sale_price_czk: 3500000 }),
    flat("a:other-unit", { unit_number: "93/7" }),
    flat("a:same-unit", { unit_number: "93/4" }),
    flat("a:auto-other", { kn_auto_unit: "93/9" }),
  ];
  assert.deepEqual(ids(candidateGroups(ended(), groups)).sort(), ["a:gone", "a:same-unit"]);
});

test("kandidáti: rezervovaný byt (inzerát ještě běží) je první, pak zmizelé od nejnovějšího", () => {
  const groups = [
    flat("a:old", { removed_at: daysAgo(40) }),
    flat("a:new", { removed_at: daysAgo(2) }),
    flat("a:reserved", { status: "reserved", removed_at: null }),
  ];
  assert.deepEqual(ids(candidateGroups(ended(), groups)), ["a:reserved", "a:new", "a:old"]);
});

test("událost bez jednotky nevylučuje byty podle jednotky", () => {
  const groups = [flat("a:one", { unit_number: "93/7" }), flat("a:two")];
  assert.deepEqual(ids(candidateGroups(ended({ detail: { unit: null } }), groups)), ["a:one", "a:two"]);
});

test("v detailu bytu: nabídne se událost domu, jejíž kandidát byt je a který nemá jednotku", () => {
  const target = flat("a:target");
  const groups = [target, flat("a:other", { unit_number: "93/7" })];
  assert.equal(houseEventsForGroup([ended()], groups, target, NOW).length, 1);
});

test("v detailu bytu: byt se zapsanou jednotkou událost domu nedostane (má svůj blok plomb)", () => {
  const target = flat("a:target", { unit_number: "93/4" });
  assert.deepEqual(houseEventsForGroup([ended()], [target], target, NOW), []);
});

test("v detailu bytu: jednotku, kterou už zapsal jiný byt, událost nenabízí", () => {
  const target = flat("a:target");
  const owner = flat("a:owner", { unit_number: "93/4" });
  assert.deepEqual(houseEventsForGroup([ended()], [target, owner], target, NOW), []);
});

test("v detailu bytu: starou událost, událost s bytem a jiný druh (filing) nenabízí", () => {
  const target = flat("a:target");
  const old = ended({ occurred_at: daysAgo(HOUSE_EVENT_DAYS + 1) });
  const withListing = ended({ listing_id: "a:other" });
  const filing = ended({ kind: "filing" });
  assert.deepEqual(houseEventsForGroup([old, withListing, filing], [target], target, NOW), []);
  assert.equal(houseEventsForGroup([ended({ kind: "plomba" })], [target], target, NOW).length, 1);
});

test("v detailu bytu: nabízený (neprodaný) byt událost domu nedostane", () => {
  const target = flat("a:target", { status: "active", removed_at: null });
  assert.deepEqual(houseEventsForGroup([ended()], [target], target, NOW), []);
});

test("odstup podání od zmizení inzerátu: dny před i po, česky", () => {
  assert.equal(filedBeforeRemovalDays("2026-10-01", "2026-10-21T07:09:39.555Z"), 20);
  assert.equal(filedBeforeRemovalDays("2026-10-23", "2026-10-21T07:09:39.555Z"), -2);
  assert.equal(filedBeforeRemovalDays(null, "2026-10-21T07:09:39.555Z"), null);
  assert.equal(filedBeforeRemovalDays("2026-10-01", null), null);
  assert.equal(describeFilingGap(20), "20 dní před zmizením inzerátu");
  assert.equal(describeFilingGap(1), "1 den před zmizením inzerátu");
  assert.equal(describeFilingGap(3), "3 dny před zmizením inzerátu");
  assert.equal(describeFilingGap(-2), "2 dny po zmizení inzerátu");
  assert.equal(describeFilingGap(0), "v den zmizení inzerátu");
  assert.equal(describeFilingGap(null), null);
});

test("byt, který si jednotku z události zapsal (i jako odhad appky), si událost přivlastní; bez shody nikdo", () => {
  const manual = flat("a:manual", { unit_number: "93/4" });
  const guessed = flat("a:guessed", { kn_auto_unit: "93/5" });
  const groups = [flat("a:none"), manual, guessed];
  assert.equal(claimingGroup(ended(), groups), manual);
  assert.equal(claimingGroup(ended({ detail: { unit: "93/5" } }), groups), guessed);
  assert.equal(claimingGroup(ended({ detail: { unit: "93/6" } }), groups), null);
  assert.equal(claimingGroup(ended({ detail: { unit: null } }), groups), null);
});

test("upozornění: událost domu, jejíž jednotku si byt už zapsal (potvrzení v detailu), patří tomu bytu a nic se neověřuje", () => {
  const confirmed = flat("a:confirmed", { unit_number: "93/4" });
  const other = flat("a:other");
  const groups = [confirmed, other];
  const [n] = buildNotifications(groups, [], { newSince: daysAgo(100), knEvents: [ended({ building_id: 7 })], groupsInBuilding: () => groups });
  assert.equal(n.group, confirmed);
  assert.deepEqual(n.candidates, []);
});

test("upozornění: událost domu bez bytu dostane kandidáty, událost s bytem a upozornění bez dohledávání ne", () => {
  const target = flat("a:target");
  const other = flat("a:other", { unit_number: "93/7" });
  const groups = [target, other];
  const knEvents = [ended({ building_id: 7 }), ended({ building_id: 8, kind: "plomba" }), { ...ended(), listing_id: "a:target", detail: { unit: "93/4" } }];
  const withLookup = buildNotifications(groups, [], { newSince: daysAgo(100), knEvents, groupsInBuilding: (id) => (id === 7 ? groups : []) });
  const byBuilding = (id, listing) => withLookup.find((n) => n.buildingId === id && (n.group ? listing : !listing));
  assert.deepEqual(ids(byBuilding(7, false).candidates), ["a:target"]);
  assert.deepEqual(byBuilding(8, false).candidates, []);
  assert.equal(byBuilding(7, true).group, target);
  assert.deepEqual(byBuilding(7, true).candidates, []);
  const without = buildNotifications(groups, [], { newSince: daysAgo(100), knEvents });
  assert.ok(without.every((n) => n.candidates.length === 0));
});
