// node --test trh-bytu/group-text-disposition.test.js
// Dispozici z pole portálu opravuje vlastní text inzerátu (group.js, textDisposition).
// Reálný případ: Letohrad, Podměstí 219 — na Sreality, Bazoši a RealityMIX je byt 5+1, 133 m²; iDNES má v polích
// 5+kk a 279 m², ale text stejný jako ostatní ("byt 5+1, 133 m²", bez ceny). Appka z toho dělala dva byty, i když
// ostatní nabídky uživatel sloučil ručně.
import test from "node:test";
import assert from "node:assert/strict";
import { groupListings } from "./group.js";
import { mentionedDispositions } from "./parse.js";
import { reviewGroup, mergeCandidates } from "./group-review.js";

const TEXT =
  "Prostorný byt 5+1, 133 m² se zahradou, vedlejšími stavbami a parkováním – Letohrad. Hledáte prostorné bydlení s výhodami " +
  "rodinného domu, vlastní zahradou a dostatkem soukromí? Nabízíme k prodeji prostorný byt o dispozici 5+1 a celkové výměře " +
  "133 m², který se nachází ve 2. nadzemním podlaží domu s pouhými dvěma bytovými jednotkami.";

function listing(overrides) {
  return {
    id: "x:1",
    source: "x",
    disposition: "5+1",
    area_m2: 133,
    price_czk: 5_500_000,
    address: "Podměstí, Letohrad",
    exact_address: "Podměstí 219, Letohrad",
    description: TEXT,
    geo_json: null,
    replaced_by: null,
    manual_group: null,
    ...overrides,
  };
}

const sreality = (o) => listing({ id: "sreality:s", source: "sreality", price_czk: null, ...o });
const bazos = (o) => listing({ id: "bazos:b", source: "bazos", ...o });
// iDNES: pole 5+kk a 279 m², text jako ostatní (iDNES ho předsazuje titulkem), bez ceny.
const idnes = (o) => listing({ id: "idnes:i", source: "idnes", disposition: "5+kk", area_m2: 279, price_czk: null, description: `Prodej bytu v Letohradě ${TEXT}`, ...o });

const groupOf = (groups, id) => groups.find((g) => g.members.some((m) => m.id === id));

test("dispozice zmíněné v textu: každá jednou, i zápis bez plusu a garsonka", () => {
  assert.deepEqual(mentionedDispositions(TEXT), ["5+1"]);
  assert.deepEqual(mentionedDispositions("Byt 2+kk, vedle 3 + 1 a 1kk, také garsonka"), ["2+kk", "3+1", "1+kk"]);
  assert.deepEqual(mentionedDispositions(""), []);
  assert.deepEqual(mentionedDispositions(null), []);
});

test("iDNES s dispozicí 5+kk z pole se připojí k 5+1, když jeho text říká 5+1", () => {
  const groups = groupListings([sreality(), bazos(), idnes()]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].members.map((m) => m.id).sort(), ["bazos:b", "idnes:i", "sreality:s"]);
});

test("ručně sloučený byt: nabídka s dispozicí opravenou textem se k němu připojí sama", () => {
  const groups = groupListings([sreality({ manual_group: "mtok" }), bazos({ manual_group: "mtok" }), idnes()]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].manual, true);
  assert.equal(groups[0].members.length, 3);
});

test("text, který zmiňuje i dispozici z pole, nic neopravuje (developerský text pro víc bytů)", () => {
  const project = `${TEXT} V domě se prodává také byt 5+kk v podkroví.`;
  const groups = groupListings([sreality({ description: project }), idnes({ description: project })]);
  assert.equal(groups.length, 2);
});

test("text, který zmiňuje víc jiných dispozic, nic neopravuje", () => {
  const several = `${TEXT} V sousedním domě je k mání i byt 4+1.`;
  const groups = groupListings([sreality(), idnes({ description: `Prodej bytu v Letohradě ${several}` })]);
  assert.equal(groups.length, 2);
});

test("opravená dispozice s jiným textem se nespojí", () => {
  const other =
    "Prodej bytu 5+1 o výměře 133 m² v klidné části Letohradu. Byt je ve druhém patře cihlového domu, má balkon, sklep " +
    "a vlastní parkovací stání. K bytu patří podíl na zahradě. Volný dle dohody, prohlídky po domluvě s makléřem.";
  const groups = groupListings([sreality(), idnes({ description: other })]);
  assert.equal(groups.length, 2);
});

test("opravená dispozice bez porovnatelného textu: shoda adresy nestačí", () => {
  const short = "Byt 5+1, 133 m².";
  const groups = groupListings([sreality({ description: null }), idnes({ description: short })]);
  assert.equal(groups.length, 2);
  assert.notEqual(groupOf(groups, "sreality:s"), groupOf(groups, "idnes:i"));
});

test("kontrola sloučení řekne, v čem se dispozice rozchází", () => {
  // Bez ruční skupiny: automaticky spojený byt jde ke kontrole kvůli dispozici i výměře z polí iDNES.
  const [group] = groupListings([sreality(), bazos(), idnes()]);
  const result = reviewGroup(group);
  assert.equal(result.level, "check");
  assert.deepEqual(result.weak, [{ id: "idnes:i", source: "idnes", notes: ["dispozice 5+kk místo 5+1", "výměra 279 m² místo 133 m²"] }]);
});

test("ruční sloučení nabídne byt ve stejném domě i s jinou dispozicí, a to jako první", () => {
  const g = (key, disposition, area, exact = null) => ({ key, members: [{ id: `${key}:1`, source: "sreality", disposition, area_m2: area, address: "", exact_address: exact }] });
  const self = g("self", "5+kk", 279, "Podměstí 219, Letohrad");
  const groups = [self, g("blizko", "5+kk", 280, "Jinde 1, Letohrad"), g("dum", "5+1", 133, "Podměstí 219, Letohrad"), g("cizi", "5+1", 133, "Jinde 2, Letohrad")];
  assert.deepEqual(mergeCandidates(groups, self).map((x) => x.key), ["dum", "blizko"]);
});
