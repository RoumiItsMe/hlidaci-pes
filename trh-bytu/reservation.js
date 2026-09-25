// Změna stavu rezervace u známého inzerátu. `observedReserved` je to, co
// portál v TOMHLE běhu řekl: true = rezervováno, false = není, null/undefined
// = portál to nesdělil (u Bazoše rezervace neexistuje; u Sreality selhalo
// stažení detailu) — pak se nic nemění, chybějící informace nesmí rezervaci
// ani vytvořit, ani zrušit.
//
// Vrací `{ status, eventType }` při změně, jinak `null`. Jen active ↔ reserved:
// "removed" řeší relist.js.

export function reservationChange(currentStatus, observedReserved) {
  if (observedReserved === true && currentStatus === "active") {
    return { status: "reserved", eventType: "reserved" };
  }
  if (observedReserved === false && currentStatus === "reserved") {
    return { status: "active", eventType: "unreserved" };
  }
  return null;
}
