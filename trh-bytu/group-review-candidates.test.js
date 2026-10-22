// node --test trh-bytu/group-review-candidates.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { mergeCandidates } from "./group-review.js";

const g = (key, disposition, area, address = "") => ({ key, members: [{ id: `${key}:1`, source: "sreality", disposition, area_m2: area, address }] });

test("kandidáti na sloučení: stejná dispozice, nejbližší výměra první, vlastní byt nikdy; limit se drží", () => {
  const self = g("self", "2+1", 52, "Dukelská");
  const groups = [self, g("a", "2+1", 70, "Lukesova"), g("b", "2+1", 53, "Spořitelní"), g("c", "3+1", 52, "Dukelská"), g("d", "2+1", 52, "Žižkova"), g("e", "2+1", null, "Bez výměry")];
  assert.deepEqual(mergeCandidates(groups, self).map((x) => x.key), ["d", "b", "a", "e"]); // 3+1 vypadlo, bez výměry je poslední
  assert.deepEqual(mergeCandidates(groups, self, 2).map((x) => x.key), ["d", "b"]);
});

test("kandidáti na sloučení: při shodné výměře rozhoduje adresa; byt bez dispozice se nabídne", () => {
  const self = g("self", "2+1", 52);
  const groups = [self, g("z", "2+1", 52, "Žamberk"), g("a", "2+1", 52, "Adamov"), g("n", null, 52, "Neznámá")];
  assert.deepEqual(mergeCandidates(groups, self).map((x) => x.key), ["a", "n", "z"]);
});
