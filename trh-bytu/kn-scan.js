// Denní kontrola plomb přes bezplatné API katastru (kn-api.js) pro byty ve
// frontě "Kontrola v katastru" (kn-schedule.js). Volá ji track.js po sběru.
//
// Co dělá:
//  - prochází domy bytů, které mají rezervaci a přesnou adresu (a jejichž dům
//    zná RÚIAN: `isknId`), DÁVKOVANĚ: dům se znovu kontroluje nejdřív po
//    CYCLE_DAYS dnech a denně se vezme jen asi pětina domů (nejstarší první),
//    aby volání rostla s počtem nabídek pomalu. Plomba trvá týdny (řízení o
//    vkladu), takže ji pětidenní cyklus nepropásne, jen oznámí o pár dní
//    později. Nový byt se zkontroluje hned;
//  - výsledek ukládá do `kn_scans` — karta Katastr a Telegram souhrn z něj čtou;
//  - plombu po rezervaci spojí s bytem sama, když je to dost jednoznačné
//    (viz matchFilings), jinak jen nabídne na kartě tlačítko "To je ten byt".

import { nowIso, updateListingFields } from "./db.js";
import { groupListings, pickOwnValue, isHidden, primaryListing, mergedStatus, saleVerdict, latestRemovedAt, mergeParams, isCooperativeOwnership } from "./group.js";
import { buildAddressContext, knInfoForGroup, resolveForGroup } from "./auto-address.js";
import { buildSaleTrack, FILING_CHECK_DAYS } from "./kn-schedule.js";
import { createKnClient, scanBuilding, parseUnitNumber, KnApiError } from "./kn-api.js";
import { analyzePlombas, apiWatch, formatDay } from "./kn-plomba.js";
import { diffKnScan, saveKnEvents } from "./kn-events.js";
import { isNewBuildPending } from "./new-build.js";
import { fileLedger, markPrimaryDone, primaryDoneToday, secondaryBudget } from "./kn-priority.js";
import { sendTelegramMessage } from "../lib/telegram.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
// Dům se znovu prochází nejdřív za tolik dní; denně se bere ~1/CYCLE_DAYS domů.
export const CYCLE_DAYS = 5;
// Dům, který v katastru nemá žádné jednotky (družstevní byty), se nemění —
// prohledává se jen výjimečně, kdyby se v katastru jednotky přece jen objevily.
export const NO_UNITS_RECHECK_DAYS = 60;
// Kolik volání denně smí sken spotřebovat; zbytek limitu (a rezerva) zůstane.
const DAILY_BUDGET = 350;
const RESERVE = 100;
// Sken starší než tohle znamená, že rozpočet nestačí na všechny domy.
const STALE_WARN_DAYS = 10;
// Zmizelý byt bez rezervace se hlídá tolik dní po zmizení. Po rezervaci se
// prodej objeví za týdny až měsíce; kdo se do ~4 měsíců neprodal, nejspíš byl
// jen stažený, a širší okno by hlídalo i zbytečně staré případy.
export const UNRESERVED_HORIZON_DAYS = 120;
// Plomba se může objevit i po půl roce (pomalá transakce, odložený prodej).
// Byt, kterému kalendářní rozvrh kontrol už skončil ("nezjištěno"), se proto
// přes API hlídá dál, aby nezapadl; po tolika dnech od rezervace už ne.
export const SCAN_HORIZON_DAYS = 400;

/** Stojí byt s touhle fází za skenování domu? (fáze vkladu / ceny, vč. dohlídání po konci rozvrhu) */
export function worthScanning(track) {
  if (!track || (track.stage !== "filing" && track.stage !== "price")) return false;
  return !track.expired || (track.ageDays ?? 0) <= SCAN_HORIZON_DAYS;
}
// Odhad "jediná plomba v domě patří jedinému sledovanému bytu" se dělá jen v
// malých domech. Ve velkém (panelák o devadesáti bytech) se za pár týdnů
// prodává mimo sledovaný byt i jiný docela běžně, takže tam plomba bez
// potvrzení uživatele k bytu nepatří.
export const AUTO_LINK_MAX_FLATS = 30;

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
 * Zmizelý byt BEZ rezervace (portál ji neukazuje — třeba Sreality — nebo se
 * inzerát stáhl dřív) a bez verdiktu: plomba po zmizení inzerátu je stejný
 * signál jako po rezervaci. Místo začátku rezervace se bere zmizení; plomba
 * podaná krátce před ním (rezerva v analyzePlombas) se ještě počítá.
 * Hlídá se UNRESERVED_HORIZON_DAYS po zmizení. Jinak null.
 */
export function unreservedTrack(members, now = Date.now()) {
  if (mergedStatus(members) !== "removed" || saleVerdict(members)) return null;
  const removedAt = latestRemovedAt(members);
  if (!removedAt || now - Date.parse(removedAt) > UNRESERVED_HORIZON_DAYS * DAY_MS) return null;
  return { stage: "filing", reservedAt: removedAt, unreserved: true, due: false, expired: false };
}

/**
 * Skupiny bytů, které stojí za kontrolu plomby: mají platnou rezervaci (nebo
 * zmizely bez ní, viz unreservedTrack),
 * rozvrh kontrol ještě neskončil (není hotovo, neprodáno ani "nezjištěno"),
 * znají přesnou adresu a dům má id v ISKN.
 *
 * Skryté byty (✕) se hlídají taky: "tohle mě nezajímá" je o seznamu a
 * statistikách, ne o tom, že by se přestal sbírat údaj o trhu — prodej a cena
 * zmizelého bytu zůstanou zapsané (viditelné v pohledu Skryté a po vrácení
 * bytu). Neposílá se jen zpráva do Telegramu (viz `hidden` u položky).
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
    if (isCooperativeOwnership(group.members)) continue; // v katastru nemá vklad, sken by byl zbytečný
    // Novostavba, jejíž adresu RÚIAN zatím nezná: bod z inzerátu může ležet u
    // sousedního domu, sken by hlídal cizí dům (viz new-build.js).
    if (isNewBuildPending(group.members, actx.ruianCache)) continue;
    const track =
      buildSaleTrack(group.members, group.members.flatMap((m) => eventsByListing.get(m.id) || []), now) ?? unreservedTrack(group.members, now);
    if (!worthScanning(track)) continue;
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
      hidden: isHidden(group.members),
    });
  }
  return tracked;
}

/**
 * Které domy se dnes projdou (v tomto pořadí): nové (ještě bez skenu) a domy,
 * kde od posledního skenu zmizel inzerát sledovaného bytu (`changedAt` — po
 * zmizení se vklad čeká, tak nesmí čekat na pětidenní cyklus), a pak plánovaná
 * dávka — nejstarší domy, jejichž sken je starý aspoň CYCLE_DAYS, nejvýš
 * 1/CYCLE_DAYS všech domů denně. (Kontrolní bod rozvrhu na pořadí
 * vliv nemá: byt, který nikdo nikdy "nezkontroloval", je podle rozvrhu
 * k vyřízení pořád, takže by se domy obnovovaly každé 2 dny a dávkování by
 * přestalo fungovat.)
 *
 * @param buildings `[{ id, changedAt? }]` (changedAt = kdy naposledy zmizel inzerát některého bytu, ms)
 * @param scans     Map id → poslední sken
 */
export function selectBuildingsToScan(buildings, scans, now = Date.now()) {
  const age = (b) => (scans.has(b.id) ? now - Date.parse(scans.get(b.id).scannedAt) : Infinity);
  const noUnits = (b) => scans.get(b.id)?.units?.length === 0;
  const cycleDays = (b) => (noUnits(b) ? NO_UNITS_RECHECK_DAYS : CYCLE_DAYS);
  const changedSinceScan = (b) => scans.has(b.id) && !noUnits(b) && b.changedAt != null && b.changedAt > Date.parse(scans.get(b.id).scannedAt);
  const fresh = buildings.filter((b) => age(b) === Infinity || changedSinceScan(b));
  const taken = new Set(fresh.map((b) => b.id));
  const quota = Math.max(1, Math.ceil(buildings.length / CYCLE_DAYS));
  const rotation = buildings
    .filter((b) => !taken.has(b.id) && age(b) >= cycleDays(b) * DAY_MS)
    .sort((a, b) => age(b) - age(a))
    .slice(0, quota);
  return [...fresh, ...rotation];
}

/**
 * Které byty v domě se spojí s plombou po rezervaci:
 *  - jednotka bytu je zapsaná ručně → její plomba po rezervaci (`via: "unit"`);
 *  - jednotka neznámá → jen když je jasno: dům má právě JEDEN sledovaný byt bez
 *    jednotky a vkladu a právě JEDNU volnou jednotku s plombou po rezervaci
 *    (`via: "building"`). V malé lokalitě se v domě za pár týdnů neprodávají dva
 *    byty, takže shoda je pravděpodobná, ale je to odhad — appka ho tak označí a
 *    jde vrátit. Neřeší se, když v domě jiný byt má vklad zapsaný bez jednotky
 *    (nevíme, kterou plombu už má), byt, kterému uživatel odhad zrušil, ani dům
 *    s víc než AUTO_LINK_MAX_FLATS byty.
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
  const flatCount = scan.units.filter((u) => u.use == null || u.use === "byt").length;
  if (open.length === 1 && !open[0].autoOff && !unitUnknownButFiled && scan.full && flatCount <= AUTO_LINK_MAX_FLATS) {
    const claimed = new Set(entries.map(unitOf).filter((u) => u != null));
    const free = analyzePlombas(scan, { reservedAt: open[0].track.reservedAt }).candidates.filter((c) => !claimed.has(c.number));
    if (free.length === 1) matches.push({ entry: open[0], candidate: free[0], via: "building" });
  }
  return matches;
}

// Družstevní byt (v katastru nejde ověřit) — definice žije v group.js, aby ji
// mohly číst i moduly, které kn-scan.js importují (auto-address.js).
export { isCooperativeOwnership };

/**
 * Jak se k bytu chová kontrola v katastru — pro text upozornění "možný prodej":
 *  - `watched`: dům má sken, appka plomby hlídá;
 *  - `pending-scan`: má adresu i dům, jen ještě nebyl prohledán (stane se při
 *    tomhle sběru);
 *  - `unverifiable`: družstevní byt nebo dům bez jednotek, v katastru nejde ověřit;
 *  - `no-address`: bez přesné adresy (nebo domu v ISKN) se nedá zkontrolovat.
 */
export function knWatchState(db, group) {
  if (isCooperativeOwnership(group.members)) return "unverifiable";
  if (!pickOwnValue(group.members, "exact_address")) return "no-address";
  const listings = db.prepare("SELECT * FROM listings").all();
  const groups = groupListings(listings);
  const same = groups.find((g) => g.members.some((m) => group.members.some((x) => x.id === m.id)));
  if (!same) return "no-address";
  const actx = buildAddressContext(db, listings, groups);
  if (isNewBuildPending(same.members, actx.ruianCache)) return "unverifiable";
  const buildingId = knInfoForGroup(actx, same, resolveForGroup(actx, same))?.building?.isknId;
  if (!buildingId) return "no-address";
  const scan = loadKnScans(db).get(buildingId);
  if (!scan) return "pending-scan";
  return scan.units.length ? "watched" : "unverifiable";
}

const UNVERIFIABLE_WATCH = { needsConfirm: false, confirmAt: null, unverifiable: true };

/**
 * Pro `buildSaleTrack`: jak plombu u dané skupiny hlídá API (viz apiWatch).
 * Družstevní byt je neověřitelný hned podle vlastnictví, bez skenu. Ostatní
 * se hlídají, jen když dům má sken a byt přesnou adresu — bez adresy sken
 * nepoběží, takže se nehlídá a platí ruční rozvrh.
 */
export function createWatchResolver(db, listings, groups, now = Date.now(), existingContext = null) {
  const scans = loadKnScans(db);
  let actx = existingContext;
  return (group) => (reservedAt) => {
    if (isCooperativeOwnership(group.members)) return UNVERIFIABLE_WATCH;
    if (!pickOwnValue(group.members, "exact_address")) return null;
    actx ??= buildAddressContext(db, listings, groups);
    // Novostavba před dokončením: zatím není v čem hledat (viz new-build.js).
    if (isNewBuildPending(group.members, actx.ruianCache)) return UNVERIFIABLE_WATCH;
    if (!scans.size) return null;
    const buildingId = knInfoForGroup(actx, group, resolveForGroup(actx, group))?.building?.isknId;
    const scan = buildingId ? scans.get(buildingId) : null;
    const unitNumber = parseUnitNumber(pickOwnValue(group.members, "unit_number")) ?? parseUnitNumber(pickOwnValue(group.members, "kn_auto_unit"));
    return apiWatch(scan, { reservedAt, unitNumber, now });
  };
}

/**
 * Zapíše změny, které sken přinesl, do kn_events (zvoneček a přehled, viz
 * kn-events.js). Zvoneček je vedlejší produkt — selhání zápisu nesmí shodit
 * kontrolu plomb ani zprávu o podaném vkladu.
 */
function recordKnChanges(db, log, prev, scan, entries, matches) {
  try {
    const mapped = entries.map((e) => ({
      listingId: primaryListing(e.group.members).id,
      unit: unitOf(e),
      address: pickOwnValue(e.group.members, "exact_address") ?? null,
    }));
    const events = diffKnScan(prev, scan, {
      entries: mapped,
      matches: matches.map(({ entry, candidate, via }) => ({
        listingId: primaryListing(entry.group.members).id,
        filedAt: candidate.filedAt,
        unit: candidate.number,
        lv: candidate.lv,
        via,
        proceedingIds: candidate.proceedings.map((r) => r.id),
      })),
    });
    saveKnEvents(db, events);
  } catch (err) {
    log(`KN API: změny v katastru se nepodařilo zapsat do zvonečku: ${err.message}`);
  }
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
    entry.track.unreserved ? `  inzerát zmizel ${formatDay(entry.track.reservedAt)} (bez rezervace)` : `  rezervováno od ${formatDay(entry.track.reservedAt)}`,
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
 *
 * `priority` ({ role: "primary" | "secondary", ledger? }) řadí sekce při čerpání
 * společného limitu (viz kn-priority.js): hlavní sekce po dnešní kontrole zapíše,
 * že doběhla, a druhá v pořadí si bere jen to, co Ústí nemůže potřebovat.
 * Bez `priority` (testy, jednosekční použití) se bere jen vlastní strop.
 */
export async function refreshKnScans(db, log, { now = Date.now(), client = createKnClient(), send = sendTelegramMessage, dailyBudget = DAILY_BUDGET, priority = null } = {}) {
  if (!client.hasKey) return null;
  const ledger = priority ? (priority.ledger ?? fileLedger()) : null;
  // Hlavní sekce zapíše "dnes doběhla" — i když nebylo co skenovat; ne po selhání API.
  const markDone = () => {
    if (priority?.role !== "primary") return;
    try {
      markPrimaryDone(ledger, now);
    } catch (err) {
      log(`KN API: nepodařilo se zapsat, že kontrola doběhla (druhá sekce zůstane na minimu): ${err.message}`);
    }
  };
  try {
    const usage = await client.usage();
    // Limit API je jeden na klíč, tedy společný pro všechny regiony — region si
    // smí vzít nejvýš `dailyBudget` a zbytek (RESERVE) zůstává. Sekce druhá v
    // pořadí navíc nechává Ústí, co by mohlo potřebovat (kn-priority.js).
    const available = usage.limitVolani - usage.provedenoVolani - RESERVE;
    const secondary = priority?.role === "secondary";
    const budget = secondary
      ? secondaryBudget({
          ownCap: dailyBudget,
          limit: usage.limitVolani,
          used: usage.provedenoVolani,
          reserve: RESERVE,
          primaryBudget: DAILY_BUDGET,
          primaryDone: primaryDoneToday(ledger, now),
        })
      : Math.min(dailyBudget, available);
    if (budget <= 0) {
      log(
        secondary && available > 0
          ? `KN API: přednost má Ústí nad Orlicí (${usage.provedenoVolani}/${usage.limitVolani} volání), kontrola plomb této sekce přeskočena`
          : `KN API: málo volání (${usage.provedenoVolani}/${usage.limitVolani}), kontrola plomb přeskočena`
      );
      markDone();
      return null;
    }

    const tracked = collectTrackedGroups(db, now);
    if (!tracked.length) {
      markDone();
      return null;
    }
    const scans = loadKnScans(db);

    // Jeden sken na dům: byt bez známé jednotky = projít všechny byty domu.
    const buildings = new Map();
    for (const t of tracked) {
      const b = buildings.get(t.buildingId) ?? { id: t.buildingId, entries: [], wantUnits: new Set(), full: false, changedAt: null };
      b.entries.push(t);
      const removedAt = latestRemovedAt(t.group.members);
      if (removedAt) b.changedAt = Math.max(b.changedAt ?? 0, Date.parse(removedAt));
      const unit = unitOf(t);
      if (unit == null) b.full = true;
      else b.wantUnits.add(unit);
      buildings.set(t.buildingId, b);
    }
    const todays = selectBuildingsToScan([...buildings.values()], scans, now);

    let used = 0;
    let scanned = 0;
    let applied = 0;
    let guessed = 0;
    let aborted = false;
    for (const b of todays) {
      if (budget - used < 1) break;
      let scan;
      const prev = scans.get(b.id) ?? null;
      try {
        scan = await scanBuilding(client, b.id, { prev, wantUnits: b.full ? null : b.wantUnits, now, budget: budget - used });
      } catch (err) {
        log(`KN API: dům ${b.id} se nepodařilo zkontrolovat: ${err.message}`);
        // Neplatný klíč / vyčerpaný limit — další domy by dopadly stejně.
        if (err instanceof KnApiError && [401, 403, 429].includes(err.status)) {
          aborted = true;
          break;
        }
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

      const matches = matchFilings(b.entries, scan);
      recordKnChanges(db, log, prev, scan, b.entries, matches);

      for (const { entry, candidate, via } of matches) {
        const updates = { sale_verdict: "sold", kn_filed_at: candidate.filedAt, kn_checked_at: nowIso() };
        if (via === "building") updates.kn_auto_unit = candidate.label;
        if (candidate.lv && !pickOwnValue(entry.group.members, "lv_number")) updates.lv_number = String(candidate.lv);
        for (const m of entry.group.members) updateListingFields(db, m.id, updates);
        applied++;
        if (via === "building") guessed++;
        // Skrytému bytu se zpráva neposílá — nález je zapsaný, to stačí.
        if (!entry.hidden) {
          try {
            await send(filingMessage(entry, candidate, via));
          } catch (err) {
            log(`KN API: zpráva o podaném vkladu se neodeslala: ${err.message}`);
          }
        }
      }
    }

    // Rozpočet nestačí na všechny domy → nejstarší sken stárne. Řekni to nahlas.
    const oldest = Math.max(0, ...[...buildings.keys()].map((id) => (scans.has(id) ? now - Date.parse(scans.get(id).scannedAt) : 0)));
    if (oldest > STALE_WARN_DAYS * DAY_MS) log(`KN API: nejstarší kontrola domu je ${Math.floor(oldest / DAY_MS)} dní stará — denní rozpočet volání nestačí na všechny domy`);

    if (!aborted) markDone();
    if (!scanned && !applied) return null;
    return `KN API: dnes ${scanned} z ${buildings.size} domů (${used} volání z ${budget}), vklad zapsán u ${applied} bytů${guessed ? ` (z toho ${guessed}× odhadem)` : ""}`;
  } catch (err) {
    log(`KN API: kontrola plomb selhala: ${err.message}`);
    return null;
  }
}
