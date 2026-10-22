// Ruční sloučení a rozdělení bytů — čistá logika bez DB. Zápis do sloupce `listings.manual_group` dělá server.js,
// tady se jen rozhoduje, KTERÝM nabídkám se jaký token zapíše. Význam tokenu viz group.js (groupListings):
// nabídky se stejným tokenem jsou jeden byt a automatika se jich netýká; NULL = automatika.
//
// Každá funkce vrací plán `{ ids, token }` ("nabídkám `ids` nastav manual_group = `token`", token `null` = zpět
// na automatiku), nebo `null`, když není co měnit.

import { randomBytes } from "node:crypto";

/** Nový token ruční skupiny. Hodnota nic neznamená, jen musí být jiná než ostatní. */
export function newGroupToken() {
  return `m${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
}

const manualTokenOf = (group) => group.members.find((m) => m.manual_group)?.manual_group ?? null;

/**
 * Oddělí jednu nabídku od ostatních v jejím bytě: zůstane sama jako ruční byt a už se k ničemu automaticky
 * nepřipojí (ke správnému bytu ji případně připojíš ručně, viz planLock). Ostatní členy skupiny se to nedotkne.
 * `null`, když je nabídka v bytě sama a už ručně oddělená.
 */
export function planDetach(group, listingId, token = newGroupToken()) {
  const member = group.members.find((m) => m.id === listingId);
  if (!member) return null;
  if (group.members.length === 1 && member.manual_group) return null;
  return { ids: [listingId], token };
}

/**
 * Spojí dané byty (skupiny) do jednoho a zamkne ho: všechny jejich nabídky dostanou stejný token. Použije se i
 * pro "potvrdit sloučení" (jedna skupina). Když už některá skupina ruční je, převezme se její token.
 * `null`, když není co spojovat (žádná skupina) nebo je vše už jeden ručně zamčený byt.
 */
export function planLock(groups, token = null) {
  const unique = [...new Map(groups.map((g) => [g.key, g])).values()];
  if (!unique.length) return null;
  const ids = unique.flatMap((g) => g.members.map((m) => m.id));
  const existing = unique.map(manualTokenOf).find(Boolean) ?? null;
  const chosen = token ?? existing ?? newGroupToken();
  // Vše už má tenhle token → nic nového.
  if (unique.every((g) => g.members.every((m) => m.manual_group === chosen))) return null;
  return { ids, token: chosen };
}

/** Vrátí byt zpět automatice: nabídkám, které mají ruční token, ho smaže. `null`, když byt ruční není. */
export function planRelease(group) {
  const ids = group.members.filter((m) => m.manual_group).map((m) => m.id);
  return ids.length ? { ids, token: null } : null;
}
