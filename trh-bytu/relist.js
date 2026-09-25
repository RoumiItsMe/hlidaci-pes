// Vyhodnocení inzerátů, které se při sběrném běhu nenašly ve výpisu portálu.
// "Nenašel se ve výpisu" ještě neznamená "zmizel z nabídky" — appka to
// dřív brala jako jistotu a dvakrát ji to zmátlo:
//
// 1) Znovu vložený inzerát. Bazoš (a občas jiné portály) při opětovném
//    vložení dá inzerátu NOVÉ ID — staré zanikne, nové má stejný text,
//    ale třeba jinou cenu ("Dohodou"). Z pohledu appky vypadá jako "zmizel
//    jeden byt a objevil se jiný". Tady se takový pár pozná a propojí
//    (`replaced_by`), takže z toho není falešné "zmizelo z nabídky", ale
//    událost `relisted` s případnou změnou ceny.
//
// 2) Přechodný výpadek. Inzerát může z výpisu jednorázově vypadnout, aniž
//    by zmizel (rotující sponzorované položky, výkyv portálu). Proto se
//    "zmizel" potvrzuje až tím, že chybí ve dvou po sobě jdoucích bězích;
//    do té doby zůstává v nabídce a jen se poznamená `missed_since`.
//
// (Nejčastější příčina falešného zmizení — Sreality, které se stahovalo jen
// z 1. stránky výsledků — je opravená u zdroje, viz fetchSrealityAllPages.)

import { sameAdByDescription } from "./group.js";
import { nowIso, getListing, updateListingFields, insertEvent, getActiveListingIdsForSource } from "./db.js";

/**
 * Nástupce (znovu vložený inzerát) pro inzerát, který zmizel — z kandidátů,
 * tj. nových inzerátů TÉHOŽ zdroje z téhož běhu. Znovu vložený inzerát bývá
 * kopie původního, změní se typicky jen titulek nebo cena, takže se shoduje
 * dispozice, plocha a začátek popisu (viz sameAdByDescription). Vrací ho
 * jen při jednoznačné shodě; při dvou a více shodách radši žádného
 * (zůstane obyčejné zmizení).
 */
export function findRelistSuccessor(gone, candidates) {
  const matches = candidates.filter((c) => sameAdByDescription(gone, c) === true);
  return matches.length === 1 ? matches[0] : null;
}

function priceText(price) {
  return price == null ? "na vyžádání" : `${price} Kč`;
}

/**
 * Zpracuje inzeráty zdroje, které jsou v DB aktivní, ale v aktuálním běhu
 * se nenašly (`currentIds` = ID nalezená v tomhle běhu). `createdThisRun`
 * jsou nové inzeráty téhož zdroje z téhož běhu (kandidáti na nástupce).
 */
export function handleDisappeared(db, sourceName, currentIds, createdThisRun, log) {
  const unclaimed = [...createdThisRun];
  let removedCount = 0;
  let relistedCount = 0;

  for (const id of getActiveListingIdsForSource(db, sourceName)) {
    if (currentIds.has(id)) continue;
    const now = nowIso();
    const gone = getListing(db, id);

    const successor = findRelistSuccessor(gone, unclaimed);
    if (successor) {
      unclaimed.splice(unclaimed.indexOf(successor), 1);
      updateListingFields(db, id, { status: "removed", removed_at: now, missed_since: null, replaced_by: successor.id });
      insertEvent(db, {
        listing_id: id,
        event_type: "relisted",
        old_price_czk: gone.price_czk,
        new_price_czk: successor.price_czk,
        occurred_at: now,
      });
      relistedCount++;
      log(`[${sourceName}] inzerát znovu vložen pod novým ID: ${id} → ${successor.id} (cena ${priceText(gone.price_czk)} → ${priceText(successor.price_czk)})`);
      continue;
    }

    if (!gone.missed_since) {
      updateListingFields(db, id, { missed_since: now });
      log(`[${sourceName}] nenalezen ve výpisu, čekám na potvrzení dalším během: ${id}`);
      continue;
    }

    // Chybí podruhé po sobě — zmizení potvrzeno, datum je ale okamžik, kdy
    // ho appka poprvé nenašla.
    updateListingFields(db, id, { status: "removed", removed_at: gone.missed_since, missed_since: null });
    insertEvent(db, { listing_id: id, event_type: "removed", occurred_at: gone.missed_since });
    removedCount++;
    log(`[${sourceName}] zmizel z nabídky: ${id}`);
  }

  return { removedCount, relistedCount };
}
