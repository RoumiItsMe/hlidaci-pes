// Které sloučené byty stojí za ruční kontrolu. Čisté funkce bez DB.
//
// Automatika spojí nabídky z víc portálů podle ceny a výměry, nebo podle textu inzerátu (group.js). Text je
// spolehlivý, jenže portály uvádějí u téhož bytu různou výměru (RealityMIX se sklepem: 58 m² místo 52 m²) a
// stejně tak se takhle mohou omylem spojit dva různé byty. Ke kontrole proto jdou byty, kde se nabídky
// PROTIŘEČÍ — jiná výměra nebo jiná známá cena. Chybějící údaj (RK cenu nezveřejnila, portál plochu neuvádí)
// rozpor není, jinak by byla každá nabídka "na vyžádání" podezřelá. Potvrzení bytu ho zamkne (manual-groups.js).

import { AREA_TOLERANCE_M2, byPriority } from "./group.js";

/**
 * Nabídky si neprotiřečí: stejná dispozice, výměra v toleranci (nebo jedna chybí) a cena shodná (nebo jedna chybí).
 */
export function compatible(a, b) {
  if (a.disposition != null && b.disposition != null && a.disposition !== b.disposition) return false;
  if (a.area_m2 != null && b.area_m2 != null && Math.abs(a.area_m2 - b.area_m2) > AREA_TOLERANCE_M2) return false;
  if (a.price_czk != null && b.price_czk != null && a.price_czk !== b.price_czk) return false;
  return true;
}

/**
 * Byty, se kterými jde daný byt ručně sloučit: jiné byty téže dispozice (nebo bez dispozice), nejdřív ty s nejbližší
 * výměrou, pak podle adresy; nejvýš `limit`. `groups` jsou všechny byty z groupListings.
 */
export function mergeCandidates(groups, group, limit = 30) {
  const rep = group.members[0];
  const area = group.members.map((m) => m.area_m2).find((v) => v != null) ?? null;
  const addressOf = (g) => g.members.map((m) => m.address).find(Boolean) ?? "";
  const areaOf = (g) => g.members.map((m) => m.area_m2).find((v) => v != null) ?? null;
  const dispositionOf = (g) => g.members.map((m) => m.disposition).find(Boolean) ?? null;
  const disposition = dispositionOf(group) ?? rep?.disposition ?? null;
  return groups
    .filter((g) => g !== group && g.key !== group.key)
    .filter((g) => disposition == null || dispositionOf(g) == null || dispositionOf(g) === disposition)
    .sort((a, b) => {
      const da = area != null && areaOf(a) != null ? Math.abs(areaOf(a) - area) : Infinity;
      const db = area != null && areaOf(b) != null ? Math.abs(areaOf(b) - area) : Infinity;
      return da - db || addressOf(a).localeCompare(addressOf(b), "cs");
    })
    .slice(0, limit);
}

const median = (values) => {
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/**
 * Posoudí jeden byt (skupinu z groupListings).
 * @returns `{ level: "ok" | "check", weak: [{ id, source, notes }] }`
 *   - ok:    nabídka jediná, ruční byt, nebo si nabídky neprotiřečí;
 *   - check: aspoň jedna nabídka se rozchází s ostatními; `weak` říká která a v čem (výměra / cena).
 */
export function reviewGroup(group) {
  const { members } = group;
  if (members.length < 2 || group.manual) return { level: "ok", weak: [] };

  // Spory se hledají mezi DVOJICEMI (ne přes souvislé komponenty): nabídka bez ceny by jinak "přemostila" dvě
  // nabídky s různou cenou a spor by zmizel. Pak se postupně vyřazuje nabídka s nejvíc spory (při shodě ta méně
  // důvěryhodného portálu), dokud si zbylé neprotiřečí — vyřazené jsou "slabé", zbylé jsou jádro bytu.
  const conflictsOf = (m, among) => among.filter((n) => n !== m && !compatible(m, n)).length;
  if (members.every((m) => conflictsOf(m, members) === 0)) return { level: "ok", weak: [] };
  const trust = new Map(byPriority(members).map((m, i) => [m.id, i])); // nižší = důvěryhodnější
  const remaining = [...members];
  const removed = [];
  for (;;) {
    let worst = null;
    let worstCount = 0;
    for (const m of remaining) {
      const count = conflictsOf(m, remaining);
      if (count > worstCount || (count === worstCount && count > 0 && trust.get(m.id) > trust.get(worst.id))) {
        worst = m;
        worstCount = count;
      }
    }
    if (!worst) break;
    remaining.splice(remaining.indexOf(worst), 1);
    removed.push(worst);
  }
  const core = remaining;
  const areas = core.map((m) => m.area_m2).filter((v) => v != null);
  const prices = core.map((m) => m.price_czk).filter((v) => v != null);
  const coreArea = areas.length ? median(areas) : null;
  const corePrice = prices.length ? median(prices) : null;

  const weak = members
    .filter((m) => removed.includes(m))
    .map((m) => {
      const notes = [];
      if (m.area_m2 != null && coreArea != null && Math.abs(m.area_m2 - coreArea) > AREA_TOLERANCE_M2) notes.push(`výměra ${m.area_m2} m² místo ${coreArea} m²`);
      if (m.price_czk != null && corePrice != null && m.price_czk !== corePrice) notes.push(`cena ${m.price_czk.toLocaleString("cs-CZ")} Kč místo ${corePrice.toLocaleString("cs-CZ")} Kč`);
      return { id: m.id, source: m.source, notes };
    });
  return { level: "check", weak };
}
