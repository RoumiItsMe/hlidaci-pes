// Stav přesné adresy bytu pro přehledy a úkoly (viz db.js exact_address).
// Čistá logika nad členy skupiny, aby šla otestovat (server.js se importovat
// nedá — spustí server).

import { pickOwnValue, bestAddress, isCooperativeOwnership } from "./group.js";

/**
 * `state`:
 *  - `known`     vyplněná adresa nebo jednotka;
 *  - `notNeeded` družstevní byt s aspoň nějakou lokalitou (ulice, část obce,
 *                město): v katastru se nepřevádí vkladem, takže se nedá ověřit
 *                ani s přesnou adresou, a k odlišení bytu stačí lokalita z
 *                inzerátu — adresa se po uživateli nechce (zapsat ji smí);
 *  - `unknown`   uživatel nabídku prošel a adresu nezjistil;
 *  - `missing`   ještě nikdo nekoukal (hlídá je filtr "Bez adresy" a úkol
 *                "Doplnit přesnou adresu").
 * Čte se přes celou skupinu — adresa zapsaná na jednom portálu platí pro byt.
 */
export function addressInfo(members) {
  const exact = pickOwnValue(members, "exact_address");
  const unit = pickOwnValue(members, "unit_number");
  const unknown = members.some((m) => m.address_unknown);
  const cooperative = isCooperativeOwnership(members) && Boolean(bestAddress(members));
  return {
    exact,
    unit,
    state: exact || unit ? "known" : cooperative ? "notNeeded" : unknown ? "unknown" : "missing",
    // Adresu doplnila appka sama z polohy (viz auto-address.js), ne uživatel.
    auto: Boolean(exact) && members.some((m) => m.address_auto === 1),
    // Uživatel automatickou adresu smazal — automat ji znovu nedoplňuje.
    autoOff: members.some((m) => m.address_auto === -1),
  };
}
