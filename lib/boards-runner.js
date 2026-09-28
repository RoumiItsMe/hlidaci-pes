// Úřední desky obcí — jeden běh: stáhne oznámení, porovná s tím, co už viděl
// (data/seen.json, klíč `board:<key>`), vybere zajímavá (viz notice-filter.js),
// u dražeb dohledá v příloze výměru pozemku (notice-enrich.js) a pošle je na
// Telegram. Volá se z index.js po sledování portálů.
//
// Stejné principy jako u portálů nemovitostí:
//  - zdraví každé desky se sleduje zvlášť (lib/health.js) — alert až po
//    druhém selhání po sobě,
//  - do stavu se ukládají ID VŠECH oznámení (i nezajímavých), ať se
//    nevyhodnocují pořád dokola a nic se neohlásí dvakrát.
//
// Rozdíly proti portálům:
//  - první běh desky NENÍ tichý baseline. Oznámení o prodeji/dražbě visí
//    na desce týdny a uživatel o nich chce vědět i tehdy, když byla vyvěšená
//    těsně před zapnutím sledování — hlásí se tedy ta zajímavá, která jsou
//    ještě vyvěšená (s poznámkou, že jde o už vyvěšené). Zbytek desky
//    (nezajímavé) se jen zapamatuje.
//  - oznámení se do stavu zapíše až po úspěšném odeslání, takže když
//    Telegram zrovna nejde, zpráva se neztratí a zkusí se příště.

import { readFileSync } from "node:fs";
import { noticeBoards, maxSeenPerBoard } from "../config.js";
import { getSourceItems } from "./state.js";
import { getHealth, alertFailure, alertRecoveryIfNeeded } from "./health.js";
import { sendTelegramMessage, sleep } from "./telegram.js";
import { fetchBoardNotices } from "../sources/uredni-desky.js";
import { classifyNotice } from "./notice-filter.js";
import { refineCandidate, MIN_LAND_AREA_M2 } from "./notice-enrich.js";
import { formatAreaM2 } from "./notice-area.js";

// Nové oznámení, které má datum vyvěšení starší než tohle, se nehlásí:
// u desek se čtou jen posledních ~100 oznámení a když z nich některá
// vyprší, "vyjede" do okna nějaké staré trvalé (např. smlouvy o dotaci
// z roku 2021) a vypadalo by to jako nové. Skutečně nové oznámení má
// datum vyvěšení nanejvýš pár dní zpátky.
const STALE_NOTICE_DAYS = 30;

// Při prvním běhu se u desek bez data "vyvěšeno do" (edesky.cz) hlásí
// oznámení, která jsou starší nejvýš tolik dní — delší vyvěšení než pár týdnů
// se u prodejů a dražeb nevyskytuje, takže starší už je jistě sejmuté.
const FIRST_RUN_MAX_AGE_DAYS = 30;

// edesky.cz umí najednou načíst celou historii nově přidané desky (viděno:
// městys Mladkov — přes sto zápisů z let 2015–2025 s jedním datem "načteno").
// Kolik dokumentů od jedné obce se stejným datem načtení se ještě bere jako
// běžný provoz; víc = hromadné načtení, ze kterého se nic nehlásí.
const BULK_LOAD_THRESHOLD = 15;

// Strop zpráv na desku a běh — při chybě (třeba změněný formát ID, kvůli
// kterému by najednou všechno vypadalo nově) by jinak Telegram dostal
// desítky zpráv. Zbytek se shrne do jedné.
const MAX_MESSAGES_PER_BOARD = 10;

// Kolik dražeb na desku a běh se dovyhodnocuje čtením přílohy (každé = 1–2
// HTTP požadavky). Nad strop se oznámení hlásí bez zjištěné výměry.
const MAX_ATTACHMENT_LOOKUPS_PER_BOARD = 8;

const KINDS = {
  flat: { emoji: "🏠", label: "Prodej bytu" },
  auction: { emoji: "🔨", label: "Dražba / aukce" },
  house: { emoji: "🏢", label: "Prodej domu / nemovitosti" },
  unknown: { emoji: "❓", label: "Možný prodej majetku" },
};

// Adresy webů obcí okresu (viz scripts/generate-okres-obce.js) — jen pro
// zprávy; když soubor chybí, zprávy jsou prostě bez řádku "Web obce".
let obceCache;
function obceWeb(boardId) {
  if (obceCache === undefined) {
    try {
      obceCache = JSON.parse(readFileSync(new URL("./okres-obce.json", import.meta.url), "utf-8"));
    } catch {
      obceCache = {};
    }
  }
  return obceCache[boardId]?.web ?? null;
}

function todayIso(now) {
  return now.toISOString().slice(0, 10);
}

/** "2026-09-08" → "8. 9. 2026". */
function formatIsoDateCz(iso) {
  const m = iso?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${Number(m[3])}. ${Number(m[2])}. ${m[1]}` : null;
}

function daysBetween(fromIso, toIso) {
  return Math.floor((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000);
}

export function formatNoticeMessage(board, notice, classification, { initial = false } = {}) {
  const { emoji, label } = KINDS[classification.kind];
  const lines = [`${emoji} ${label} — úřední deska: ${notice.sourceLabel ?? board.label}`, notice.title];
  if (classification.kind === "auction") {
    if (classification.mentionsFlat) lines.push("🏠 V oznámení se zmiňuje byt.");
    else if (classification.mentionsHouse) lines.push("🏢 V oznámení se zmiňuje dům nebo budova.");
    if (classification.landOnly) {
      lines.push(
        classification.areaM2 != null
          ? `📐 Pozemek o výměře ${formatAreaM2(classification.areaM2)} m²`
          : `📐 Výměru pozemku se zjistit nepodařilo (hlásí se pozemky nad ${MIN_LAND_AREA_M2} m²).`
      );
    }
  }
  if (classification.kind === "unknown") {
    lines.push("Z názvu nepoznám, čeho se týká — je ale v kategorii věnované prodejům. Podívej se na oznámení.");
  }
  if (notice.category) lines.push(`📂 ${notice.category}`);
  const from = formatIsoDateCz(notice.postedFrom);
  const to = formatIsoDateCz(notice.postedTo);
  if (notice.viaEdesky) {
    if (from) lines.push(`📅 Načteno na edesky.cz ${from}`);
  } else if (from) {
    lines.push(`📅 Vyvěšeno ${from}${to ? ` do ${to}` : ""}`);
  }
  if (initial) lines.push("ℹ️ Už vyvěšené v okamžiku zapnutí sledování této desky.");
  lines.push(notice.url ?? board.url);
  const web = notice.viaEdesky ? obceWeb(notice.sourceBoardId) : null;
  if (web) lines.push(`🌐 Web obce: ${web}`);
  return lines.join("\n");
}

/**
 * Projde všechny úřední desky z config.js. `state` se mění na místě (volající
 * ho uloží). Vrací `{ sent, hadError, hadSeriousError }` — stejný význam jako
 * u portálů v index.js (vážná chyba = alert o výpadku nebo neodeslaná zpráva).
 *
 * Volitelné parametry jsou pro testy a `scripts/check-boards.js`.
 */
export async function runNoticeBoards(
  state,
  {
    boards = noticeBoards,
    send = sendTelegramMessage,
    now = new Date(),
    fetchNotices = fetchBoardNotices,
    refine = refineCandidate,
  } = {}
) {
  let sent = 0;
  let hadError = false;
  let hadSeriousError = false;
  const today = todayIso(now);

  for (const [index, board] of boards.entries()) {
    const stateKey = `board:${board.key}`;
    const label = `Úřední deska • ${board.label}`;
    const health = getHealth(state, stateKey);
    const known = getSourceItems(state, stateKey);
    const isFirstRun = known.size === 0;

    if (index > 0) await sleep(400); // zdvořilost k obecním webům

    let notices;
    try {
      notices = await fetchNotices(board, { deep: isFirstRun });
    } catch (err) {
      hadError = true;
      console.error(`[${stateKey}] CHYBA při stahování: ${err.message}`);
      if (await alertFailure(health, label, err)) hadSeriousError = true;
      continue;
    }
    await alertRecoveryIfNeeded(health, label);

    const fresh = notices.filter((notice) => !known.has(notice.id));

    // Hromadné načtení z edesky.cz: hodně dokumentů od jedné obce se stejným
    // datem "načteno" (viz BULK_LOAD_THRESHOLD) — jen se zapamatují.
    const perSourceDay = new Map();
    for (const notice of fresh) {
      if (!notice.viaEdesky) continue;
      const key = `${notice.sourceBoardId}|${notice.postedFrom}`;
      perSourceDay.set(key, (perSourceDay.get(key) ?? 0) + 1);
    }
    const isBulkLoad = (notice) =>
      notice.viaEdesky && perSourceDay.get(`${notice.sourceBoardId}|${notice.postedFrom}`) > BULK_LOAD_THRESHOLD;

    // Nová oznámení rozdělíme na zajímavá (poslat) a ostatní (jen zapamatovat).
    const candidates = [];
    let stale = 0;
    let bulk = 0;
    for (const notice of fresh) {
      if (isBulkLoad(notice)) {
        bulk += 1;
        known.set(notice.id, {});
        continue;
      }
      const classification = classifyNotice(notice);
      if (!classification) {
        known.set(notice.id, {});
        continue;
      }
      if (isFirstRun) {
        // Už dávno skončená oznámení z prvního načtení nikoho nezajímají.
        const expired = notice.postedTo
          ? notice.postedTo < today
          : notice.postedFrom && daysBetween(notice.postedFrom, today) > FIRST_RUN_MAX_AGE_DAYS;
        if (expired) {
          known.set(notice.id, {});
          continue;
        }
      } else if (notice.postedFrom && daysBetween(notice.postedFrom, today) > STALE_NOTICE_DAYS) {
        stale += 1;
        console.log(`[${stateKey}] přeskakuji "nové" oznámení ${notice.id} — vyvěšeno už ${notice.postedFrom}, jen vyjelo do okna seznamu.`);
        known.set(notice.id, {});
        continue;
      }
      candidates.push({ notice, classification });
    }

    // U dražeb dohledáme v příloze, co se dražší a jak velký je pozemek;
    // drobné pozemky (do MIN_LAND_AREA_M2) se vyřadí.
    const toSend = [];
    let lookups = 0;
    let tooSmall = 0;
    for (const candidate of candidates) {
      if (candidate.classification.kind === "auction" && lookups < MAX_ATTACHMENT_LOOKUPS_PER_BOARD) {
        lookups += 1;
        const refined = await refine(candidate.notice, candidate.classification);
        if (refined.skip) {
          tooSmall += 1;
          console.log(`[${stateKey}] vyřazuji ${candidate.notice.id} "${candidate.notice.title.slice(0, 70)}" — ${refined.reason}.`);
          known.set(candidate.notice.id, {});
          continue;
        }
        candidate.classification = refined.classification;
      }
      toSend.push(candidate);
    }

    console.log(
      `[${stateKey}] nalezeno ${notices.length} oznámení, z toho ${fresh.length} nových, ${toSend.length} zajímavých` +
        `${stale ? `, ${stale} starých přeskočeno` : ""}${bulk ? `, ${bulk} z hromadného načtení přeskočeno` : ""}` +
        `${tooSmall ? `, ${tooSmall} drobných pozemků vyřazeno` : ""}${isFirstRun ? " (první běh desky)" : ""}`
    );

    const batch = toSend.slice(0, MAX_MESSAGES_PER_BOARD);
    for (const { notice, classification } of batch) {
      try {
        await send(formatNoticeMessage(board, notice, classification, { initial: isFirstRun }));
        known.set(notice.id, {}); // zapamatovat až po odeslání
        sent += 1;
        await sleep(400);
      } catch (err) {
        // Stejně jako u portálů se nedebounceuje — nedoručená zpráva je
        // ztracená informace. Neodeslané oznámení ale ve stavu NENÍ, takže
        // se zkusí znovu při dalším běhu.
        hadError = true;
        hadSeriousError = true;
        console.error(`[${stateKey}] CHYBA při odesílání Telegram zprávy: ${err.message}`);
      }
    }

    const rest = toSend.slice(MAX_MESSAGES_PER_BOARD);
    if (rest.length > 0) {
      try {
        await send(`📋 Úřední deska: ${board.label} — dalších ${rest.length} zajímavých oznámení nebylo poslaných jednotlivě.\n${board.url}`);
        for (const { notice } of rest) known.set(notice.id, {});
        sent += 1;
      } catch (err) {
        hadError = true;
        hadSeriousError = true;
        console.error(`[${stateKey}] CHYBA při odesílání souhrnné Telegram zprávy: ${err.message}`);
      }
    }

    // Holá ID (bez ceny — deska žádnou nemá); `getSourceItems` čte i tenhle formát.
    state[stateKey] = [...known.keys()].slice(-maxSeenPerBoard);
  }

  return { sent, hadError, hadSeriousError };
}
