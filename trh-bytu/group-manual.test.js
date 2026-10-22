// node --test trh-bytu/group-manual.test.js
// Ruční sloučení / rozdělení bytů: sloupec `manual_group` (group.js) a plány zásahů (manual-groups.js).
import test from "node:test";
import assert from "node:assert/strict";
import { groupListings } from "./group.js";
import { planDetach, planLock, planRelease, newGroupToken } from "./manual-groups.js";

const TEXT =
  "Krásný byt 2+1 po velmi povedené rekonstrukci! Vítejte v Ústí nad Orlicí! Nachází se na oblíbeném sídlišti Dukla ve 2. nadzemním podlaží zděného domu. " +
  "Plocha bytu je 52 m² včetně sklepa a lodžie. Byt je ihned k nastěhování, v okolí škola, školka i obchody.";

function listing(overrides) {
  return {
    id: "x:1",
    source: "x",
    disposition: "2+1",
    area_m2: 52,
    price_czk: 3_450_000,
    address: "Dukelská, Ústí nad Orlicí - Hylváty",
    description: TEXT,
    geo_json: null,
    replaced_by: null,
    manual_group: null,
    ...overrides,
  };
}

const A = (o) => listing({ id: "sreality:a", source: "sreality", ...o });
const B = (o) => listing({ id: "idnes:b", source: "idnes", ...o });
const C = (o) => listing({ id: "bazos:c", source: "bazos", ...o });

/** Aplikuje plán zásahu na řádky (to, co server zapíše do databáze). */
function apply(rows, plan) {
  if (!plan) return rows;
  return rows.map((r) => (plan.ids.includes(r.id) ? { ...r, manual_group: plan.token } : r));
}
const idsOf = (groups) => groups.map((g) => g.members.map((m) => m.id).sort().join("+")).sort();
const groupOf = (groups, id) => groups.find((g) => g.members.some((m) => m.id === id));

test("bez ručních zásahů se seskupení nemění (stejná cena + výměra z víc portálů je jeden byt)", () => {
  const groups = groupListings([A(), B()]);
  assert.deepEqual(idsOf(groups), ["idnes:b+sreality:a"]);
  assert.equal(groups[0].manual, undefined);
});

test("ruční sloučení spojí nabídky, které by automatika nespojila (jiná cena i výměra, jiný text)", () => {
  const rows = [A(), B({ price_czk: 2_900_000, area_m2: 70, description: "Úplně jiný popis bytu, nic společného s prvním inzerátem, žádná shoda úseku textu." })];
  assert.deepEqual(idsOf(groupListings(rows)), ["idnes:b", "sreality:a"]);
  const groups = groupListings(apply(rows, planLock(groupListings(rows))));
  assert.deepEqual(idsOf(groups), ["idnes:b+sreality:a"]);
  assert.equal(groups[0].manual, true);
  assert.equal(groups[0].merged, true); // dva portály
});

test("rozdělení: nabídka spojená automaticky se oddělí a zůstane sama", () => {
  const rows = [A(), B()];
  const before = groupListings(rows);
  assert.equal(before.length, 1);
  const after = groupListings(apply(rows, planDetach(before[0], "idnes:b")));
  assert.deepEqual(idsOf(after), ["idnes:b", "sreality:a"]);
  assert.equal(groupOf(after, "idnes:b").manual, true);
  assert.equal(groupOf(after, "sreality:a").manual, undefined); // druhá strana zůstává v rukou automatiky
});

test("oddělená nabídka se k ničemu automaticky nepřipojí, ani když by sedělo vše ostatní", () => {
  const detached = apply([A(), B()], planDetach(groupListings([A(), B()])[0], "idnes:b"));
  // přibyde další portál se stejným bytem: připojí se k automatické straně (Sreality), ne k oddělené iDNES
  const withBazos = groupListings([...detached, C()]);
  assert.deepEqual(idsOf(withBazos), ["bazos:c+sreality:a", "idnes:b"]);
});

test("ruční byt nevstřebává ani nové automatické nabídky (je uzavřený)", () => {
  const rows = [A(), B()];
  const locked = apply(rows, planLock(groupListings(rows)));
  const groups = groupListings([...locked, C()]);
  assert.deepEqual(idsOf(groups), ["bazos:c", "idnes:b+sreality:a"]);
});

test("z trojice se oddělí jedna nabídka, zbylé dvě zůstanou spolu", () => {
  const rows = [A(), B(), C()];
  const trio = groupListings(rows);
  assert.equal(trio.length, 1);
  const after = groupListings(apply(rows, planDetach(trio[0], "bazos:c")));
  assert.deepEqual(idsOf(after), ["bazos:c", "idnes:b+sreality:a"]);
});

test("vrácení zpět na automatiku: původní seskupení se obnoví", () => {
  const rows = [A(), B()];
  const detached = apply(rows, planDetach(groupListings(rows)[0], "idnes:b"));
  assert.equal(groupListings(detached).length, 2);
  const detachedGroup = groupOf(groupListings(detached), "idnes:b");
  const released = apply(detached, planRelease(detachedGroup));
  assert.deepEqual(idsOf(groupListings(released)), ["idnes:b+sreality:a"]);
});

test("znovu vložený inzerát (replaced_by) se k ruční skupině připojí i tak", () => {
  const old = A({ id: "bazos:old", source: "bazos", status: "removed", replaced_by: "bazos:new", manual_group: "m1" });
  const fresh = A({ id: "bazos:new", source: "bazos", price_czk: null });
  const groups = groupListings([old, fresh]);
  assert.deepEqual(idsOf(groups), ["bazos:new+bazos:old"]);
  assert.equal(groups[0].manual, true);
});

test("plány: detach jen pro existující nabídku, lock převezme existující token, release jen u ruční skupiny", () => {
  const rows = [A({ manual_group: "mX" }), B({ manual_group: "mX" })];
  const [group] = groupListings(rows);
  assert.equal(planDetach(group, "neexistuje:1"), null);
  assert.deepEqual(planDetach(group, "idnes:b", "mNEW"), { ids: ["idnes:b"], token: "mNEW" });
  // jediná oddělená nabídka už není co oddělovat
  const solo = groupListings([A({ manual_group: "mS" })])[0];
  assert.equal(planDetach(solo, "sreality:a"), null);
  // lock: stejný token už mají všichni → nic; přidání třetí skupiny převezme token "mX"
  assert.equal(planLock([group]), null);
  const other = groupListings([C()])[0];
  assert.deepEqual(planLock([group, other]), { ids: ["sreality:a", "idnes:b", "bazos:c"], token: "mX" });
  assert.deepEqual(planRelease(group), { ids: ["sreality:a", "idnes:b"], token: null });
  assert.equal(planRelease(groupListings([A()])[0]), null);
  assert.equal(planLock([]), null);
  assert.notEqual(newGroupToken(), newGroupToken());
});
