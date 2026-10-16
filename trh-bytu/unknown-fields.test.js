// node --test trh-bytu/unknown-fields.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { parseUnknownFields, addUnknownFields, removeUnknownFields, serializeUnknownFields, parseFieldList, labelsOf, ESSENTIAL_KEYS } from "./unknown-fields.js";

const json = (list) => JSON.stringify(list);

test("nezjistitelné údaje se čtou jako sjednocení přes všechny nabídky bytu", () => {
  const members = [{ unknown_fields: json(["condition"]) }, { unknown_fields: null }, { unknown_fields: json(["ownership"]) }];
  assert.deepEqual(parseUnknownFields(members), ["ownership", "condition"]); // pořadí podle ESSENTIAL_KEYS
});

test("poškozená nebo cizí hodnota ve sloupci se ignoruje, neplatné klíče se zahodí", () => {
  assert.deepEqual(parseUnknownFields([{ unknown_fields: "nejde-json" }, { unknown_fields: json({ a: 1 }) }, { unknown_fields: json(["condition", "cena", "x"]) }]), ["condition"]);
  assert.deepEqual(parseUnknownFields([{}]), []);
});

test("přidání a odebrání: neduplikuje, drží pořadí, bez klíčů odebere vše", () => {
  assert.deepEqual(addUnknownFields(["condition"], ["ownership", "condition", "nesmysl"]), ["ownership", "condition"]);
  assert.deepEqual(removeUnknownFields(["ownership", "condition"], ["condition"]), ["ownership"]);
  assert.deepEqual(removeUnknownFields(["ownership", "condition"]), []);
});

test("sloupec: prázdný seznam = null, jinak JSON", () => {
  assert.equal(serializeUnknownFields([]), null);
  assert.equal(serializeUnknownFields(["condition"]), '["condition"]');
});

test("klíče z formuláře: jen platné, bez mezer; popisky pro uživatele", () => {
  assert.deepEqual(parseFieldList(" disposition, condition ,xyz,"), ["disposition", "condition"]);
  assert.deepEqual(parseFieldList(""), []);
  assert.deepEqual(parseFieldList(null), []);
  assert.deepEqual(labelsOf(["ownership", "area"]), ["plocha", "vlastnictví"]);
  assert.deepEqual(ESSENTIAL_KEYS, ["disposition", "area", "ownership", "condition"]);
});
