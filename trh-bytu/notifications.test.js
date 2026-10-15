// node --test trh-bytu/notifications.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { buildNotifications, countUnread } from "./notifications.js";

const NEW_SINCE = "2026-01-01T00:00:00.000Z";
const at = (day, hour = 8) => `2026-10-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00.000Z`;
const group = (...ids) => ({ members: ids.map((id) => ({ id, source: id.split(":")[0], hidden: 0 })) });
const ev = (listing_id, event_type, occurred_at, extra = {}) => ({ listing_id, event_type, occurred_at, old_price_czk: null, new_price_czk: null, ...extra });
const types = (notifications) => notifications.map((n) => n.type);

test("zmizelo po rezervaci: poslední inzerát bytu zmizel, byl rezervovaný", () => {
  const g = group("a:1");
  const n = buildNotifications([g], [ev("a:1", "created", at(1)), ev("a:1", "reserved", at(3)), ev("a:1", "removed", at(9))], { newSince: at(31) });
  assert.deepEqual(types(n), ["gone", "reserved"]);
  assert.equal(n[0].occurredAt, at(9));
});

test("zmizelý byt, který nebyl rezervovaný, žádné upozornění 'zmizelo po rezervaci' nevyrobí", () => {
  const n = buildNotifications([group("a:1")], [ev("a:1", "created", at(1)), ev("a:1", "removed", at(9))], { newSince: at(31) });
  assert.deepEqual(types(n), []);
});

test("rezervace zrušená dřív, než inzerát zmizel, není 'zmizelo po rezervaci'", () => {
  const n = buildNotifications(
    [group("a:1")],
    [ev("a:1", "created", at(1)), ev("a:1", "reserved", at(3)), ev("a:1", "unreserved", at(5)), ev("a:1", "removed", at(9))],
    { newSince: at(31) }
  );
  assert.deepEqual(types(n), ["reserved"]);
});

test("byt je pořád na druhém portálu → nezmizel z trhu, upozornění nevzniká", () => {
  const n = buildNotifications(
    [group("a:1", "b:1")],
    [ev("a:1", "created", at(1)), ev("b:1", "created", at(1)), ev("a:1", "reserved", at(3)), ev("a:1", "removed", at(9))],
    { newSince: at(31) }
  );
  assert.deepEqual(types(n), ["reserved"]);
});

test("zmizel z obou portálů: jedno upozornění, ve chvíli, kdy zmizel poslední", () => {
  const n = buildNotifications(
    [group("a:1", "b:1")],
    [ev("a:1", "created", at(1)), ev("b:1", "created", at(1)), ev("a:1", "reserved", at(3)), ev("a:1", "removed", at(8)), ev("b:1", "removed", at(9))],
    { newSince: at(31) }
  );
  assert.deepEqual(types(n).filter((t) => t === "gone"), ["gone"]);
  assert.equal(n.find((x) => x.type === "gone").occurredAt, at(9));
});

test("byt, který se vrátil (znovu vložený inzerát) a zmizel bez nové rezervace, podruhé 'zmizelo po rezervaci' nehlásí", () => {
  const n = buildNotifications(
    [group("a:1", "a:2")],
    [ev("a:1", "created", at(1)), ev("a:1", "reserved", at(3)), ev("a:1", "removed", at(5)), ev("a:2", "relisted", at(7)), ev("a:2", "removed", at(12))],
    { newSince: at(31) }
  );
  assert.deepEqual(types(n).filter((t) => t === "gone"), ["gone"]);
  assert.equal(n.find((x) => x.type === "gone").occurredAt, at(5));
});

test("starší inzerát bez události 'created' se bere za aktivní — kolega ho nepřehlasuje", () => {
  const n = buildNotifications([group("a:1", "old:1")], [ev("a:1", "created", at(1)), ev("a:1", "reserved", at(3)), ev("a:1", "removed", at(9))], { newSince: at(31) });
  assert.equal(types(n).includes("gone"), false);
});

test("změna z katastru patří k bytu, ke kterému je uložená; bez bytu je to událost domu", () => {
  const g = group("a:1");
  const knEvents = [
    { kind: "filing", occurred_at: at(12), building_id: 7, listing_id: "a:1", detail: { unit: "412/12", filedAt: "2026-10-10" } },
    { kind: "plomba", occurred_at: at(13), building_id: 7, listing_id: null, detail: { unit: "412/7", filedAt: "2026-10-12", address: "Lukesova 412" } },
    { kind: "ended", occurred_at: at(14), building_id: 9, listing_id: "smazano:9", detail: { unit: "1/1" } },
  ];
  const n = buildNotifications([g], [], { newSince: at(31), knEvents });
  assert.deepEqual(n.map((x) => [x.type, x.kind, x.group === g]), [
    ["kn", "ended", false],
    ["kn", "plomba", false],
    ["kn", "filing", true],
  ]);
  assert.equal(n[1].detail.address, "Lukesova 412");
  assert.equal(n[1].sources.size, 0);
});

test("upozornění se řadí od nejnovějšího napříč druhy a nepřečtená se počítají podle času přečtení", () => {
  const g = group("a:1");
  const knEvents = [{ kind: "filing", occurred_at: at(12), building_id: 7, listing_id: "a:1", detail: {} }];
  const n = buildNotifications([g], [ev("a:1", "created", at(1)), ev("a:1", "reserved", at(3)), ev("a:1", "removed", at(9))], { newSince: at(31), knEvents });
  assert.deepEqual(types(n), ["kn", "gone", "reserved"]);
  assert.equal(countUnread(n, at(8)), 2);
  assert.equal(countUnread(n, at(20)), 0);
});
