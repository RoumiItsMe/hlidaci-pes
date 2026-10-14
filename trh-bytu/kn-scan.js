// Denní kontrola plomb přes bezplatné API katastru (kn-api.js) pro byty ve
// frontě "Kontrola v katastru" (kn-schedule.js). Volá ji track.js po sběru.
//
// Co dělá:
//  - prochází domy bytů, které mají rezervaci a přesnou adresu (a jejichž dům
//    zná RÚIAN: `isknId`), DÁVKOVANĚ: dům se znovu kontroluje nejdřív po
//    CYCLE_DAYS dnech a denně se vezme jen asi pětina domů (nejstarší první),
//    aby volání rostla s počtem nabídek pomalu. Plomba trvá týdny (řízení o
//    vkladu), takže ji pětidenní cyklus nepropásne, jen oznámí o pár dní
//    později. Výjimky: nový byt se zkontroluje hned a byt, kterému právě nastal
//    kontrolní bod, dostane čerstvá data, je-li sken starší než 2 dny;
//  - výsledek ukládá do `kn_scans` — karta Katastr a Telegram souhrn z něj čtou;
//  - plombu po rezervaci spojí s bytem sama, když je to dost jednoznačné
//    (viz matchFilings), jinak jen nabídne na kartě tlačítko "To je ten byt".

import { nowIso, updateListingFields } from "./db.js";
import { groupListings, pickOwnValue, isHidden, primaryListing } from "./group.js";
import { buildAddressContext, knInfoForGroup, resolveForGroup } from "./auto-address.js";
import { buildSaleTrack, FILING_CHECK_DAYS } from "./kn-schedule.js";
import { createKnClient, scanBuilding, parseUnitNumber, KnApiError } from "./kn-api.js";
import { analyzePlombas, formatDay } from "./kn-plomba.js";
import { sendTelegramMessage } from "../lib/telegram.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
// Dům se znovu prochází nejdřív za tolik dní; denně se bere ~1/CYCLE_DAYS domů.
export const CYCLE_DAYS = 5;
// Byt s právě nastalým kontrolním bodem: sken starší než tohle se obnoví.
export const DUE_REFRESH_HOURS = 48;
// Kolik volání denně smí sken spotřebovat; zbytek limitu (a rezerva) zůstane.
const DAILY_BUDGET = 350;
const RESERVE = 100;
// Sken starší než tohle znamená, že rozpočet nestačí na všechny domy.
const STALE_WARN_DAYS = 10;

export function loadKnScans(db) {
  const scans = new Map();
  for (const r of db.prepare("SELECT building_id, result_json FROM kn_scans").all()) scans.set(r.building_id, JSON.parse(r.result_json));
  return scans;
}

export function saveKnScan(db, scan) {
  db.prepare("INSERT OR REPLACE INTO kn_scans (building_id, scanned_at, result_json) VALUES (?, ?, ?)").run(scan.buildingId, scan.scannedAt, JSON.stringify(scan));
}

/** Jednotka bytu: ručně zapsaná má přednost před odhadnutou. */
export function unitOf(entry) {
  return entry.unitNumber ?? entry.autoUnitNumber ?? null;
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
    tracked.push({
      group,
      track,
      buildingId,
      unitNumber: parseUnitNumber(pickOwnValue(group.members, "unit_number")),
      autoUnitNumber: parseUnitNumber(pickOwnValue(group.members, "kn_auto_unit")),
      autoOff: Boolean(pickOwnValue(group.members, "kn_auto_off")),
      filedAt: pickOwnValue(group.members, "kn_filed_at"),
    });
  }
  return tracked;
}

/**
 * Které domy se dnes projdou (v tomto pořadí): nové (ještě bez skenu), domy
 * bytů s právě nastalým kontrolním bodem a starým skenem, a pak plánovaná
 * dávka — nejstarší domy, jejichž sken je starý aspoň CYCLE_DAYS, nejvýš
 * 1/CYCLE_DAYS všech domů denně.
 *
 * @param buildings `[{ id, due }]`
 * @param scans     Map id → poslední sken
 */
export function selectBuildingsToScan(buildings, scans, now = Date.now()) {
  const age = (b) => (scans.has(b.id) ? now - Date.parse(scans.get(b.id).scannedAt) : Infinity);
  const fresh = buildings.filter((b) => age(b) === Infinity).sort((a, b) => Number(b.due) - Number(a.due));
  const due = buildings.filter((b) => b.due && age(b) !== Infinity && age(b) >= DUE_REFRESH_HOURS * HOUR_MS).sort((a, b) => age(b) - age(a));
  const taken = new Set([...fresh, ...due].map((b) => b.id));
  const quota = Math.max(1, Math.ceil(buildings.length / CYCLE_DAYS));
  const rotation = buildings
    .filter((b) => !taken.has(b.id) && age(b) >= CYCLE_DAYS * DAY_MS)
    .sort((a, b) => age(b) - age(a))
    .slice(0, quota);
  return [...fresh, ...due, ...rotation];
}

/**
 * Které byty v domě se spojí s plombou po rezervaci:
 *  - jednotka bytu je zapsaná ručně → její plomba po rezervaci (`via: "unit"`);
 *  - jednotka neznámá → jen když je jasno: dům má právě JEDEN sledovaný byt bez
 *    jednotky a vkladu a právě JEDNU volnou jednotku s plombou po rezervaci
 *    (`via: "building"`). V malé lokalitě se v domě za pár týdnů neprodávají dva
 *    byty, takže shoda je pravděpodobná, ale je to odhad — appka ho tak označí a
 *    jde vrátit. Neřeší se, když v domě jiný byt má vklad zapsaný bez jednotky
 *    (nevíme, kterou plombu už má), ani byt, kterému uživatel odhad zrušil.
 * @param entries  sledované byty jednoho domu (collectTrackedGroups)
 */
export function matchFilings(entries, scan) {
  const matches = [];
  for (const e of entries) {
    if (e.unitNumber == null || e.filedAt) continue;
    const candidate = analyzePlombas(scan, { reservedAt: e.track.reservedAt, unitNumber: e.unitNumber }).candidates[0];
    if (candidate) matches.push({ entry: e, candidate, via: "unit" });
  }

  const open = entries.filter((e) => unitOf(e) == null && !e.filedAt);
  const unitUnknownButFiled = entries.some((e) => e.filedAt && unitOf(e) == null);
  if (open.length === 1 && !open[0].autoOff && !unitUnknownButFiled && scan.full) {
    const claimed = new Set(entries.map(unitOf).filter((u) => u != null));
    const free = analyzePlombas(scan, { reservedAt: open[0].track.reservedAt }).candidates.filter((c) => !claimed.has(c.number));
    if (free.length === 1) matches.push({ entry: open[0], candidate: free[0], via: "building" });
  }
  return matches;
}

function filingMessage(entry, candidate, via) {
  const rep = primaryListing(entry.group.members);
  const specs = [rep.disposition, rep.area_m2 ? `${rep.area_m2} m²` : null].filter(Boolean).join(", ") || "byt";
  const first = candidate.proceedings.find((r) => r.datumPrijeti?.slice(0, 10) === candidate.filedAt) ?? candidate.proceedings[0];
  const priceCheck = new Date(Date.parse(candidate.filedAt) + FILING_CHECK_DAYS[0] * DAY_MS).toISOString();
  const exact = pickOwnValue(entry.group.members, "exact_address");
  return [
    via === "building" ? "🔖 Vklad podán v katastru (odhad)" : "🔖 Vklad podán v katastru",
    "",
    `• ${specs}${exact ? `, ${exact}` : ""}`,
    `  jednotka ${candidate.label}${candidate.lv ? ` (LV ${candidate.lv})` : ""}, návrh přijat ${formatDay(candidate.filedAt)}${first?.cislo ? ` (řízení V-${first.cislo}/${first.rok})` : ""}`,
    `  rezervováno od ${formatDay(entry.track.reservedAt)}`,
    "",
    via === "building"
      ? "V domě je po rezervaci jediná plomba a tenhle byt je v domě jediný, který sledujeme — proto jsem ji k němu přiřadil. Je to odhad: pokud to není on, zruš to v Katastru („Zrušit vklad podán“) a appka už nic sama nepřiřadí."
      : "Jednotku bytu máš zapsanou, takže plomba na ní sedí.",
    `Zapsáno do appky jako „Vklad podán“. Cenu jde zjistit po rozhodnutí o vkladu (zpravidla do měsíce) — připomenu ji kolem ${formatDay(priceCheck)}.`,
    ...(via === "building" ? [] : ["Kdyby to nebyl tenhle byt, zruš to v Katastru („Zrušit vklad podán“)."]),
  ].join("\n");
}

/**
 * Projde dnešní dávku domů (viz hlavička) a zapíše nalezené plomby. Vrací řádek
 * do logu, nebo null, když nebylo co dělat. Nikdy nevyhazuje — track.js běží
 * bez dohledu.
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

    // Jeden sken na dům: byt bez známé jednotky = projít všechny byty domu.
    const buildings = new Map();
    for (const t of tracked) {
      const b = buildings.get(t.buildingId) ?? { id: t.buildingId, entries: [], wantUnits: new Set(), full: false, due: false };
      b.entries.push(t);
      const unit = unitOf(t);
      if (unit == null) b.full = true;
      else b.wantUnits.add(unit);
      if (t.track.due) b.due = true;
      buildings.set(t.buildingId, b);
    }
    const todays = selectBuildingsToScan([...buildings.values()], scans, now);

    let used = 0;
    let scanned = 0;
    let applied = 0;
    let guessed = 0;
    for (const b of todays) {
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

      for (const { entry, candidate, via } of matchFilings(b.entries, scan)) {
        const updates = { sale_verdict: "sold", kn_filed_at: candidate.filedAt, kn_checked_at: nowIso() };
        if (via === "building") updates.kn_auto_unit = candidate.label;
        if (candidate.lv && !pickOwnValue(entry.group.members, "lv_number")) updates.lv_number = String(candidate.lv);
        for (const m of entry.group.members) updateListingFields(db, m.id, updates);
        applied++;
        if (via === "building") guessed++;
        try {
          await send(filingMessage(entry, candidate, via));
        } catch (err) {
          log(`KN API: zpráva o podaném vkladu se neodeslala: ${err.message}`);
        }
      }
    }

    // Rozpočet nestačí na všechny domy → nejstarší sken stárne. Řekni to nahlas.
    const oldest = Math.max(0, ...[...buildings.keys()].map((id) => (scans.has(id) ? now - Date.parse(scans.get(id).scannedAt) : 0)));
    if (oldest > STALE_WARN_DAYS * DAY_MS) log(`KN API: nejstarší kontrola domu je ${Math.floor(oldest / DAY_MS)} dní stará — denní rozpočet volání nestačí na všechny domy`);

    if (!scanned && !applied) return null;
    return `KN API: dnes ${scanned} z ${buildings.size} domů (${used} volání z ${budget}), vklad zapsán u ${applied} bytů${guessed ? ` (z toho ${guessed}× odhadem)` : ""}`;
  } catch (err) {
    log(`KN API: kontrola plomb selhala: ${err.message}`);
    return null;
  }
}
