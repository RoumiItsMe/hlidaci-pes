// Denní kontrola plomb přes bezplatné API katastru (kn-api.js) pro byty ve
// frontě "Kontrola v katastru" (kn-schedule.js). Volá ji track.js po sběru.
//
// Co dělá:
//  - projde domy bytů, které mají rezervaci a přesnou adresu (a jejichž dům
//    zná RÚIAN: `isknId`), jednou za ~den, v rámci denního rozpočtu volání;
//  - výsledek uloží do `kn_scans` — karta Katastr a Telegram souhrn z něj čtou;
//  - u bytu se ZNÁMOU jednotkou, na které je po rezervaci plomba, sama zapíše
//    "vklad podán" (stejně jako tlačítko v appce) a pošle zprávu. U bytu bez
//    zapsané jednotky nezapíše nic — plomba v domě nemusí patřit jemu, to
//    potvrzuje uživatel tlačítkem "To je ten byt".

import { nowIso, updateListingFields } from "./db.js";
import { groupListings, pickOwnValue, isHidden, primaryListing } from "./group.js";
import { buildAddressContext, knInfoForGroup, resolveForGroup } from "./auto-address.js";
import { buildSaleTrack, FILING_CHECK_DAYS } from "./kn-schedule.js";
import { createKnClient, scanBuilding, parseUnitNumber, KnApiError } from "./kn-api.js";
import { analyzePlombas, formatDay } from "./kn-plomba.js";
import { sendTelegramMessage } from "../lib/telegram.js";

const HOUR_MS = 60 * 60 * 1000;
// Dům se znovu prochází nejdřív za tolik hodin (denní běh tak projde vždy).
const RESCAN_AFTER_HOURS = 20;
// Kolik volání denně smí sken spotřebovat; zbytek limitu (a rezerva) zůstane.
const DAILY_BUDGET = 350;
const RESERVE = 100;

export function loadKnScans(db) {
  const scans = new Map();
  for (const r of db.prepare("SELECT building_id, result_json FROM kn_scans").all()) scans.set(r.building_id, JSON.parse(r.result_json));
  return scans;
}

export function saveKnScan(db, scan) {
  db.prepare("INSERT OR REPLACE INTO kn_scans (building_id, scanned_at, result_json) VALUES (?, ?, ?)").run(scan.buildingId, scan.scannedAt, JSON.stringify(scan));
}

/**
 * Skupiny bytů, které stojí za kontrolu plomby: mají platnou rezervaci,
 * rozvrh kontrol ještě neskončil (není hotovo, neprodáno ani "nezjištěno"),
 * znají přesnou adresu a dům má id v ISKN.
 */
export function collectTrackedGroups(db, now = Date.now()) {
  const listings = db.prepare("SELECT * FROM listings").all();
  const groups = groupListings(listings);
  const actx = buildAddressContext(db, listings, groups);
  const eventsByListing = new Map();
  for (const e of db.prepare("SELECT listing_id, event_type, occurred_at FROM events WHERE event_type IN ('reserved', 'unreserved')").all()) {
    if (!eventsByListing.has(e.listing_id)) eventsByListing.set(e.listing_id, []);
    eventsByListing.get(e.listing_id).push(e);
  }
  const tracked = [];
  for (const group of groups) {
    if (isHidden(group.members)) continue;
    const track = buildSaleTrack(group.members, group.members.flatMap((m) => eventsByListing.get(m.id) || []), now);
    if (!track || track.expired || (track.stage !== "filing" && track.stage !== "price")) continue;
    if (!pickOwnValue(group.members, "exact_address")) continue;
    const kn = knInfoForGroup(actx, group, resolveForGroup(actx, group));
    const buildingId = kn?.building?.isknId;
    if (!buildingId) continue;
    tracked.push({ group, track, buildingId, unitNumber: parseUnitNumber(pickOwnValue(group.members, "unit_number")), filedAt: pickOwnValue(group.members, "kn_filed_at") });
  }
  return tracked;
}

function filingMessage(entry, candidate) {
  const rep = primaryListing(entry.group.members);
  const specs = [rep.disposition, rep.area_m2 ? `${rep.area_m2} m²` : null].filter(Boolean).join(", ") || "byt";
  const first = candidate.proceedings.find((r) => r.datumPrijeti?.slice(0, 10) === candidate.filedAt) ?? candidate.proceedings[0];
  const priceCheck = new Date(Date.parse(candidate.filedAt) + FILING_CHECK_DAYS[0] * 24 * HOUR_MS).toISOString();
  return [
    "🔖 Vklad podán v katastru",
    "",
    `• ${specs}${pickOwnValue(entry.group.members, "exact_address") ? `, ${pickOwnValue(entry.group.members, "exact_address")}` : ""}`,
    `  jednotka ${candidate.label}${candidate.lv ? ` (LV ${candidate.lv})` : ""}, návrh přijat ${formatDay(candidate.filedAt)}${first?.cislo ? ` (řízení V-${first.cislo}/${first.rok})` : ""}`,
    `  rezervováno od ${formatDay(entry.track.reservedAt)}`,
    "",
    `Zapsáno do appky jako „Vklad podán“. Cenu jde zjistit po rozhodnutí o vkladu (zpravidla do měsíce) — připomenu ji kolem ${formatDay(priceCheck)}.`,
    "Kdyby to nebyl tenhle byt, zruš to v Katastru („Zrušit vklad podán“).",
  ].join("\n");
}

/**
 * Projde domy (viz hlavička) a zapíše nalezené plomby. Vrací řádek do logu,
 * nebo null, když nebylo co dělat. Nikdy nevyhazuje — track.js běží bez dohledu.
 */
export async function refreshKnScans(db, log, { now = Date.now(), client = createKnClient(), send = sendTelegramMessage } = {}) {
  if (!client.hasKey) return null;
  try {
    const usage = await client.usage();
    const budget = Math.min(DAILY_BUDGET, usage.limitVolani - usage.provedenoVolani - RESERVE);
    if (budget <= 0) {
      log(`KN API: málo volání (${usage.provedenoVolani}/${usage.limitVolani}), kontrola plomb přeskočena`);
      return null;
    }

    const tracked = collectTrackedGroups(db, now);
    if (!tracked.length) return null;
    const scans = loadKnScans(db);

    // Jeden sken na dům: neznámá jednotka u kteréhokoli bytu = projít celý dům.
    const buildings = new Map();
    for (const t of tracked) {
      const b = buildings.get(t.buildingId) ?? { id: t.buildingId, entries: [], wantUnits: new Set(), full: false, due: false };
      b.entries.push(t);
      if (t.unitNumber == null) b.full = true;
      else b.wantUnits.add(t.unitNumber);
      if (t.track.due) b.due = true;
      buildings.set(t.buildingId, b);
    }
    const queue = [...buildings.values()]
      .filter((b) => {
        const prev = scans.get(b.id);
        return !prev || now - Date.parse(prev.scannedAt) >= RESCAN_AFTER_HOURS * HOUR_MS;
      })
      .sort((a, b) => Number(b.due) - Number(a.due));

    let used = 0;
    let scanned = 0;
    let applied = 0;
    for (const b of queue) {
      if (budget - used < 1) break;
      let scan;
      try {
        scan = await scanBuilding(client, b.id, { prev: scans.get(b.id) ?? null, wantUnits: b.full ? null : b.wantUnits, now, budget: budget - used });
      } catch (err) {
        log(`KN API: dům ${b.id} se nepodařilo zkontrolovat: ${err.message}`);
        // Neplatný klíč / vyčerpaný limit — další domy by dopadly stejně.
        if (err instanceof KnApiError && [401, 403, 429].includes(err.status)) break;
        continue;
      }
      if (scan.skipped) {
        log(`KN API: dům ${b.id} přeskočen (potřebuje ${scan.needed} volání, zbývá rozpočet ${budget - used})`);
        continue;
      }
      used += scan.calls;
      scanned++;
      saveKnScan(db, scan);
      scans.set(b.id, scan);

      for (const entry of b.entries) {
        if (entry.unitNumber == null || entry.filedAt) continue; // bez jednotky jen nápověda; hotový vklad už je zapsaný
        const analysis = analyzePlombas(scan, { reservedAt: entry.track.reservedAt, unitNumber: entry.unitNumber });
        const candidate = analysis.candidates[0];
        if (!candidate) continue;
        const updates = { sale_verdict: "sold", kn_filed_at: candidate.filedAt, kn_checked_at: nowIso() };
        if (candidate.lv && !pickOwnValue(entry.group.members, "lv_number")) updates.lv_number = String(candidate.lv);
        for (const m of entry.group.members) updateListingFields(db, m.id, updates);
        applied++;
        try {
          await send(filingMessage(entry, candidate));
        } catch (err) {
          log(`KN API: zpráva o podaném vkladu se neodeslala: ${err.message}`);
        }
      }
    }
    if (!scanned && !applied) return null;
    return `KN API: zkontrolováno ${scanned} domů (${used} volání z ${budget}), vklad zapsán u ${applied} bytů`;
  } catch (err) {
    log(`KN API: kontrola plomb selhala: ${err.message}`);
    return null;
  }
}
