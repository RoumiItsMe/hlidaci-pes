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
import { probeGone } from "./gone-probe.js";

// Kolik inzerátů jednoho zdroje se za běh ověří přímo na jejich stránce (viz gone-probe.js). Strop je pojistka: když
// najednou "chybí" desítky inzerátů, je to spíš výpadek výpisu než skutečný úklid portálu, a ten se potvrzuje
// pomalu (odstupem), ne dotazy na portál.
export const MAX_GONE_PROBES_PER_RUN = 10;
const PROBE_PAUSE_MS = 300; // zdvořilost vůči portálu
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

// Dva běhy po sobě mají být odstup, ne dva dotazy v řadě: sběr jde spustit i
// ručně (tlačítko "Aktualizovat teď") a plánovaná úloha se po startu PC
// dožene klidně hodinu po předchozím běhu. Kdyby stačilo "chybí ve dvou
// bězích", přechodný výpadek portálu by se potvrdil jako zmizení během minut.
export const MIN_CONFIRM_GAP_MS = 6 * 60 * 60 * 1000;

/** Je první výpadek (`missedSince`) dost starý na to, aby ho další běh potvrdil jako zmizení? */
export function isMissConfirmed(missedSince, now = Date.now()) {
  return Boolean(missedSince) && now - Date.parse(missedSince) >= MIN_CONFIRM_GAP_MS;
}

function priceText(price) {
  return price == null ? "na vyžádání" : `${price} Kč`;
}

/**
 * Zpracuje inzeráty zdroje, které jsou v DB aktivní, ale v aktuálním běhu
 * se nenašly (`currentIds` = ID nalezená v tomhle běhu). `createdThisRun`
 * jsou nové inzeráty téhož zdroje z téhož běhu (kandidáti na nástupce).
 */
export async function handleDisappeared(db, sourceName, currentIds, createdThisRun, log, { probe = probeGone, pause = sleep, at = null } = {}) {
  const unclaimed = [...createdThisRun];
  let removedCount = 0;
  let relistedCount = 0;
  let probes = 0;

  for (const id of getActiveListingIdsForSource(db, sourceName)) {
    if (currentIds.has(id)) continue;
    const now = at ?? nowIso(); // `at`: čas pozorování u přehrávaného snímku (snapshot-replay.js)
    const nowMs = Date.parse(now);
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

    // Přímý důkaz ze stránky inzerátu (gone-probe.js): portál ho smazal, takže není co potvrzovat po odstupu. Jinak
    // (chyba, nejasná odpověď, vyčerpaný strop) platí běžná pojistka níž.
    if (!isMissConfirmed(gone.missed_since, nowMs) && probes < MAX_GONE_PROBES_PER_RUN) {
      probes++;
      const proven = await probe(sourceName, gone.url);
      await pause(PROBE_PAUSE_MS);
      if (proven) {
        const removedAt = gone.missed_since ?? now; // okamžik, kdy ho appka poprvé nenašla
        updateListingFields(db, id, { status: "removed", removed_at: removedAt, missed_since: null });
        insertEvent(db, { listing_id: id, event_type: "removed", occurred_at: removedAt });
        removedCount++;
        log(`[${sourceName}] zmizel z nabídky (stránka inzerátu už neexistuje): ${id}`);
        continue;
      }
    }

    if (!gone.missed_since) {
      updateListingFields(db, id, { missed_since: now });
      log(`[${sourceName}] nenalezen ve výpisu, čekám na potvrzení dalším během: ${id}`);
      continue;
    }

    if (!isMissConfirmed(gone.missed_since, nowMs)) {
      log(`[${sourceName}] pořád nenalezen, ale první výpadek je čerstvý — potvrdí až další běh po odstupu: ${id}`);
      continue;
    }

    // Chybí podruhé po sobě (s odstupem) — zmizení potvrzeno, datum je ale
    // okamžik, kdy ho appka poprvé nenašla.
    updateListingFields(db, id, { status: "removed", removed_at: gone.missed_since, missed_since: null });
    insertEvent(db, { listing_id: id, event_type: "removed", occurred_at: gone.missed_since });
    removedCount++;
    log(`[${sourceName}] zmizel z nabídky: ${id}`);
  }

  return { removedCount, relistedCount };
}
