// Ruční kontrola úředních desek — nic neodesílá a nic neukládá.
//
// Stáhne všechny desky z config.js (`noticeBoards`), vypíše kolik oznámení
// se našlo a která by filtr (lib/notice-filter.js) nahlásil. Hodí se:
//  - po změně klíčových slov ve filtru (co by se změnilo?),
//  - při podezření, že se některá obec předělala web (parser vrátí 0),
//  - k ověření, že deska je dostupná i z GitHub Actions.
//
// Použití:
//   node scripts/check-boards.js          # jen shody
//   node scripts/check-boards.js --all    # všechna oznámení včetně nezajímavých
//
// Exit kód 1, když se některou desku nepodařilo stáhnout / přečíst.

import { noticeBoards } from "../config.js";
import { fetchBoardNotices } from "../sources/uredni-desky.js";
import { classifyNotice } from "../lib/notice-filter.js";

const showAll = process.argv.includes("--all");
let failed = 0;

for (const board of noticeBoards) {
  try {
    const started = Date.now();
    const notices = await fetchBoardNotices(board);
    const ms = Date.now() - started;
    const hits = notices.map((notice) => ({ notice, classification: classifyNotice(notice) }));
    const matched = hits.filter((h) => h.classification);
    console.log(`\n✔ ${board.label} (${board.type}): ${notices.length} oznámení za ${ms} ms, ${matched.length} zajímavých`);
    for (const { notice, classification } of showAll ? hits : matched) {
      const tag = classification ? `[${classification.kind}${classification.mentionsFlat ? "+byt" : ""}]` : "[ ]";
      console.log(`  ${tag} ${notice.postedFrom ?? "?"} (${notice.category || "bez kategorie"}) ${notice.title}`);
      if (classification) console.log(`        ${notice.url}`);
    }
  } catch (err) {
    failed += 1;
    console.log(`\n✘ ${board.label} (${board.type}): ${err.message}`);
  }
}

if (failed > 0) {
  console.log(`\n${failed} z ${noticeBoards.length} desek selhalo.`);
  process.exitCode = 1;
}
