// node --test trh-bytu/group-flags.test.js
// TOP (starred) a skrytí (hidden) se čtou z celého bytu (isStarred/isHidden), takže se musí i zapisovat na celý byt.
import test from "node:test";
import assert from "node:assert/strict";
import { planFlagToggle, isStarred, isHidden } from "./group.js";

const m = (id, flags = {}) => ({ id, source: id.split(":")[0], starred: 0, hidden: 0, ...flags });
/** Zapíše plán na nabídky (to, co dělá server) a vrátí nové řádky. */
const apply = (members, plan, column) => members.map((x) => (plan.ids.includes(x.id) ? { ...x, [column]: plan.value } : x));

test("TOP zapnutý na jedné nabídce: přepnutí ho odebere ze všech (dřív zůstal na té, kam se nesáhlo)", () => {
  // reálný případ: hvězdička zůstala na Bazoši, hlavní nabídka (Sreality) ji nemá
  const members = [m("sreality:a"), m("idnes:b"), m("bazos:c", { starred: 1 })];
  assert.equal(isStarred(members), true);
  const plan = planFlagToggle(members, "starred");
  assert.equal(plan.value, 0);
  assert.deepEqual(plan.ids, ["sreality:a", "idnes:b", "bazos:c"]);
  assert.equal(isStarred(apply(members, plan, "starred")), false);
});

test("TOP vypnutý: přepnutí ho zapne na všech nabídkách bytu", () => {
  const members = [m("sreality:a"), m("idnes:b")];
  const plan = planFlagToggle(members, "starred");
  assert.equal(plan.value, 1);
  const after = apply(members, plan, "starred");
  assert.ok(after.every((x) => x.starred === 1));
  // a dalším přepnutím zase pryč
  assert.equal(isStarred(apply(after, planFlagToggle(after, "starred"), "starred")), false);
});

test("skrytí funguje stejně a nezávisle na TOP", () => {
  const members = [m("sreality:a", { starred: 1 }), m("bazos:c", { hidden: 1 })];
  const plan = planFlagToggle(members, "hidden");
  assert.equal(plan.value, 0);
  const after = apply(members, plan, "hidden");
  assert.equal(isHidden(after), false);
  assert.equal(isStarred(after), true); // TOP se nedotklo
});

test("byt o jedné nabídce se přepíná jako dřív", () => {
  assert.deepEqual(planFlagToggle([m("sreality:a")], "starred"), { ids: ["sreality:a"], value: 1 });
  assert.deepEqual(planFlagToggle([m("sreality:a", { starred: 1 })], "starred"), { ids: ["sreality:a"], value: 0 });
});
