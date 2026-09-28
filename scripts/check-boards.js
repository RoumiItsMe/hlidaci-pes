// Ruční kontrola úředních desek — nic neodesílá a nic neukládá.
//
// Stáhne všechny desky z config.js (`noticeBoards`), vypíše kolik oznámení
// se našlo a která by filtr (lib/notice-filter.js) nahlásil. Hodí se:
//  - po změně klíčových slov ve filtru (co by se změnilo?),
//  - při podezření, že se některá obec předělala web (parser vrátí 0),
//  - k ověření, že deska je dostupná i z GitHub Actions.
//
// Použití:
//   node scripts/check-boards.js                 # jen shody
//   node scripts/check-boards.js --all           # všechna oznámení včetně nezajímavých
//   node scripts/check-boards.js --enrich        # u dražeb přečte přílohu (výměra pozemku)
//   node scripts/check-boards.js --deep          # edesky.cz hlouběji do historie (jako první běh, 30 dní)
//
// Deska okresu (edesky.cz) potřebuje klíč k API v proměnné EDESKY_API_KEY, ať
// ji nastavíš v shellu (např. `EDESKY_API_KEY=… node scripts/check-boards.js okres`);
// bez klíče se ta jedna deska ohlásí jako selhání a ostatní se přečtou normálně.
//   node scripts/check-boards.js okres           # jen desky, jejichž klíč obsahuje "okres"
//
// Exit kód 1, když se některou desku nepodařilo stáhnout / přečíst.

import { noticeBoards } from "../config.js";
import { fetchBoardNotices } from "../sources/uredni-desky.js";
import { classifyNotice } from "../lib/notice-filter.js";
import { refineCandidate } from "../lib/notice-enrich.js";
import { formatAreaM2 } from "../lib/notice-area.js";

const args = process.argv.slice(2);
const showAll = args.includes("--all");
const enrich = args.includes("--enrich");
const deep = args.includes("--deep");
const only = args.find((a) => !a.startsWith("--"));
let failed = 0;

for (const board of noticeBoards.filter((b) => !only || b.key.includes(only))) {
  try {
    const started = Date.now();
    const notices = await fetchBoardNotices(board, { deep });
    const ms = Date.now() - started;
    const hits = notices.map((notice) => ({ notice, classification: classifyNotice(notice) }));
    const matched = hits.filter((h) => h.classification);
    console.log(`\n✔ ${board.label} (${board.type}): ${notices.length} oznámení za ${ms} ms, ${matched.length} zajímavých`);
    for (const hit of showAll ? hits : matched) {
      const { notice } = hit;
      let { classification } = hit;
      let note = "";
      if (enrich && classification?.kind === "auction") {
        const refined = await refineCandidate(notice, classification);
        classification = refined.classification;
        const found = [
          classification.areaM2 != null && `výměra ${formatAreaM2(classification.areaM2)} m²`,
          classification.mentionsFlat && "zmiňuje byt",
          classification.mentionsHouse && "zmiňuje dům/budovu",
        ].filter(Boolean);
        note = refined.skip ? `  ← VYŘAZENO (${refined.reason})` : `  ← ${found.join(", ") || "z přílohy nic dalšího nezjištěno"}`;
      }
      const tag = classification ? `[${classification.kind}${classification.mentionsFlat ? "+byt" : ""}]` : "[ ]";
      const where = notice.sourceLabel ? `${notice.sourceLabel}: ` : "";
      console.log(`  ${tag} ${notice.postedFrom ?? "?"} (${notice.category || "bez kategorie"}) ${where}${notice.title}${note}`);
      if (classification) console.log(`        ${notice.url}`);
    }
  } catch (err) {
    failed += 1;
    console.log(`\n✘ ${board.label} (${board.type}): ${err.message}`);
  }
}

if (failed > 0) {
  console.log(`\n${failed} desek selhalo.`);
  process.exitCode = 1;
}
