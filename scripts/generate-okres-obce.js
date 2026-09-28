// Jednorázově (a znovu při podezření, že se seznam obcí změnil) vygeneruje
// lib/okres-obce.json: podřízené desky okresu na edesky.cz = obce okresu,
// s adresou jejich webu. Zprávy z lib/boards-runner.js z toho ukazují "Web
// obce", ať je snadné dohledat oznámení přímo u obce (samotné edesky.cz
// neregistrovaným uživatelům obsah dokumentů nezobrazuje).
//
// Použití:  node scripts/generate-okres-obce.js [edeskyId]     (výchozí 1033 =
// okres Ústí nad Orlicí; ID okresu najdeš v adrese jeho desky na edesky.cz)
//
// ~120 požadavků s pauzou 300 ms, tj. asi minuta. Nic jiného než ten JSON
// nemění.

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as cheerio from "cheerio";
import { fetchText } from "../lib/http.js";

const edeskyId = process.argv[2] ?? "1033";
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "lib", "okres-obce.json");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clean = (text) => (text ?? "").replace(/\s+/g, " ").trim();

const boardUrl = (id) => `https://edesky.cz/desky/${id}`;
const boardIdOf = (href) => href?.match(/^\/desky\/(\d+)-/)?.[1];

const okresHtml = await fetchText(boardUrl(edeskyId), { timeoutMs: 30_000 });
const $ = cheerio.load(okresHtml);

const children = new Map();
$("a[href^='/desky/']").each((_, a) => {
  const id = boardIdOf($(a).attr("href"));
  const name = clean($(a).text());
  if (id && id !== edeskyId && name && !/page=/.test($(a).attr("href"))) children.set(id, name);
});
console.log(`Podřízených desek: ${children.size}`);

const result = {};
for (const [id, name] of children) {
  let web = null;
  try {
    const page = cheerio.load(await fetchText(boardUrl(id), { timeoutMs: 30_000 }));
    web =
      page("a[href^='http']")
        .map((_, a) => page(a).attr("href"))
        .get()
        .find((h) => !/edesky\.cz|facebook\.com|twitter\.com|google|blog\.edesky/.test(h)) ?? null;
  } catch (err) {
    console.warn(`  ${name} (${id}): web se nepodařilo zjistit — ${err.message}`);
  }
  result[id] = { name, web };
  await sleep(300);
}

await writeFile(OUT, JSON.stringify(result, null, 1) + "\n", "utf-8");
console.log(`Zapsáno ${Object.keys(result).length} obcí do ${OUT}; bez webu: ${Object.values(result).filter((o) => !o.web).length}`);
