// Novostavba před dokončením: byt z webu developera má adresu z marketingu
// ("Lhotka 51, Česká Třebová"), ale číslo popisné a adresní místo se v RÚIAN
// objeví až po dokončení domu, a do té doby není v katastru ani budova s
// jednotkami. Takový byt se zatím nedá ověřit (podobně jako družstevní) — appka
// ho tak označí a RÚIAN se na adresu znovu zeptá jednou za RECHECK_UNKNOWN_DAYS
// (ruian.js). Jakmile dům v registru je, byt se tiše zařadí mezi ověřitelné:
// nic se nehlásí, jen se začne hlídat jako každý jiný.
//
// Čisté funkce nad členy skupiny a mezipamětí RÚIAN (Map klíč → výsledek).

import { pickOwnValue, mergeParams } from "./group.js";
import { parseExactAddress, addressKey } from "./ruian.js";

/**
 * Je to novostavba? Ruční (nebo appkou odhadnutý) stav bytu rozhoduje; bez něj
 * portálový "Novostavba" / "Ve výstavbě".
 */
export function isNewBuild(members) {
  const own = pickOwnValue(members, "own_condition");
  if (own) return own === "novostavba";
  return /výstavb|novostavb/i.test(mergeParams(members).condition ?? "");
}

/**
 * Výsledek RÚIAN pro ZAPSANOU přesnou adresu bytu: objekt (adresa nalezena),
 * `null` (RÚIAN adresu nezná) nebo `undefined` (bez adresy, nebo se ještě
 * nezjišťovalo).
 */
export function ruianEntryForExactAddress(ruianCache, members) {
  const parsed = parseExactAddress(pickOwnValue(members, "exact_address"));
  return parsed ? ruianCache.get(addressKey(parsed.street, parsed.number, parsed.city)) : undefined;
}

/** Novostavba, jejíž zapsanou adresu RÚIAN zatím nezná → v katastru se zatím nedá ověřit. */
export function isNewBuildPending(members, ruianCache) {
  return isNewBuild(members) && ruianEntryForExactAddress(ruianCache, members) === null;
}
