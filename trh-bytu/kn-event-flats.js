// Události domu v katastru, které appka nepřiřadila k žádnému bytu (kn-events.js: `listing_id` je NULL) — typicky
// "řízení o vkladu v domě skončilo", protože u žádného sledovaného bytu není zapsaná jednotka. Samotná událost řekne
// jen "dům, jednotka 93/4"; tady se dohledá, KTERÝ byt z domu to může být, aby upozornění vedlo rovnou na jeho detail
// a v detailu šla událost potvrdit ("To je ten byt"). Čistá logika bez DB (kromě groupsByBuilding), aby šla otestovat.

import { mergedStatus, saleVerdict, pickOwnValue, latestRemovedAt } from "./group.js";
import { parseUnitNumber } from "./kn-api.js";
import { knInfoForGroup } from "./auto-address.js";

const DAY_MS = 24 * 60 * 60 * 1000;
// Druhy událostí domu, které mají smysl přiřadit k bytu (nový filing už k bytu přiřazený je).
export const HOUSE_EVENT_KINDS = ["plomba", "ended"];
// Jak dlouho se událost domu nabízí v detailu bytu — dál už ji uživatel buď vyřešil, nebo to nebyl jeho byt.
export const HOUSE_EVENT_DAYS = 90;

/** Jednotka bytu: ručně zapsaná má přednost před odhadnutou (stejné pravidlo jako unitOf v kn-scan.js). */
function ownUnit(group) {
  return parseUnitNumber(pickOwnValue(group.members, "unit_number")) ?? parseUnitNumber(pickOwnValue(group.members, "kn_auto_unit"));
}

/**
 * Byty (skupiny) domu podle id domu v ISKN. Jen ty s přesnou adresou — jen takové se v domě sledují (kn-scan.js,
 * collectTrackedGroups), takže jen u nich mohl sken vzniknout.
 *
 * @param actx kontext z buildAddressContext (nese i skupiny)
 * @returns Map id domu → skupiny
 */
export function groupsByBuilding(actx) {
  const byBuilding = new Map();
  for (const group of actx.groups) {
    if (!pickOwnValue(group.members, "exact_address")) continue;
    const id = knInfoForGroup(actx, group, null)?.building?.isknId;
    if (id == null) continue;
    if (!byBuilding.has(id)) byBuilding.set(id, []);
    byBuilding.get(id).push(group);
  }
  return byBuilding;
}

/**
 * Byt, který si jednotku z události domu už zapsal (třeba tlačítkem "To je ten byt" — událost sama zůstává uložená bez
 * bytu). K němu událost patří, jako by mu byla přiřazená hned. `null`, když takový byt není.
 */
export function claimingGroup(event, groupsInBuilding) {
  const unit = parseUnitNumber(event.detail?.unit);
  return unit == null ? null : (groupsInBuilding.find((group) => ownUnit(group) === unit) ?? null);
}

/**
 * Které byty z domu může událost domu znamenat, nejpravděpodobnější první. Vyřadí se byt, který se pořád nabízí
 * (neprodal se), byt s potvrzeným "neprodáno", byt s už ověřenou cenou (je vyřízený) a byt s JINOU jednotkou, než
 * jakou událost nese. Rezervovaný byt (inzerát ještě běží) je před zmizelými, ty od nejnověji zmizelého.
 */
export function candidateGroups(event, groupsInBuilding) {
  const unit = parseUnitNumber(event.detail?.unit);
  const removedKey = (group) => latestRemovedAt(group.members) ?? "9999";
  return groupsInBuilding
    .filter((group) => {
      if (mergedStatus(group.members) === "active") return false;
      if (saleVerdict(group.members) === "withdrawn") return false;
      if (pickOwnValue(group.members, "verified_sale_price_czk") != null) return false;
      const own = ownUnit(group);
      return own == null || unit == null || own === unit;
    })
    .sort((a, b) => removedKey(b).localeCompare(removedKey(a)));
}

/**
 * Události domu, které se mají ukázat v detailu bytu `group`: nepřiřazené k žádnému bytu, ne starší než
 * HOUSE_EVENT_DAYS, byt je jejich kandidát a nemá zapsanou jednotku (s jednotkou ukazuje plomby blok o jeho jednotce).
 * Jednotku, kterou už zapsal jiný byt, událost nenabízí — patří tomu.
 *
 * @param events          události téhož domu z loadKnEvents (`{ kind, occurred_at, listing_id, detail }`)
 * @param groupsInBuilding byty domu (groupsByBuilding)
 */
export function houseEventsForGroup(events, groupsInBuilding, group, now = Date.now()) {
  if (ownUnit(group) != null) return [];
  return events.filter((event) => {
    if (!HOUSE_EVENT_KINDS.includes(event.kind) || event.listing_id) return false;
    if (now - Date.parse(event.occurred_at) > HOUSE_EVENT_DAYS * DAY_MS) return false;
    const unit = parseUnitNumber(event.detail?.unit);
    if (unit != null && groupsInBuilding.some((other) => other !== group && ownUnit(other) === unit)) return false;
    return candidateGroups(event, groupsInBuilding).includes(group);
  });
}

/**
 * Kolik dní před (záporné: po) zmizením inzerátu bylo řízení podáno — nápověda, jestli se vklad k bytu hodí.
 * `null`, když se nezná den podání nebo byt nezmizel.
 */
export function filedBeforeRemovalDays(filedAt, removedAt) {
  if (!filedAt || !removedAt) return null;
  const filed = Date.parse(`${filedAt.slice(0, 10)}T12:00:00Z`);
  const removed = Date.parse(`${removedAt.slice(0, 10)}T12:00:00Z`);
  return Number.isFinite(filed) && Number.isFinite(removed) ? Math.round((removed - filed) / DAY_MS) : null;
}

const daysCs = (n) => (n === 1 ? "1 den" : n >= 2 && n <= 4 ? `${n} dny` : `${n} dní`);

/** Odstup podání od zmizení inzerátu česky ("20 dní před zmizením inzerátu"), `null` bez údaje. */
export function describeFilingGap(days) {
  if (days == null) return null;
  if (days === 0) return "v den zmizení inzerátu";
  return `${daysCs(Math.abs(days))} ${days > 0 ? "před zmizením" : "po zmizení"} inzerátu`;
}
