// Jednorázové (bezpečně opakovatelné) doplnění polohy u nabídek, které jsou
// ještě online. track.js poloze rozumí od začátku sběru polohy, starší
// záznamy ji nemají — a po zmizení inzerátu už ji ze stránky nedostaneme
// (viz geo.js), takže u běžících nabídek je potřeba stihnout to teď.
//
// Postup: (1) stáhne detail nabídek bez polohy a uloží lat/lon/geo_json,
// (2) geokóduje nové body (max. 1 dotaz/s, viz geo.js), (3) automaticky
// doplní adresy s vysokou důvěrou, (4) vypíše přehled — co se přiřadilo,
// co ne a proč, ať jde kvalitu posoudit očima.
//
// Spuštění: node trh-bytu/backfill-geo.js

import { openDb } from "./db.js";
import { geoFields, geocodePending } from "./geo.js";
import { ruianPending } from "./ruian.js";
import { applyAutoAddresses, buildAddressContext, resolveForGroup, describeEvidence, knInfoForGroup, describeKn } from "./auto-address.js";
import { groupListings } from "./group.js";
import { fetchSrealityDetail } from "./detail/sreality.js";
import { fetchBezrealitkyDetail } from "./detail/bezrealitky.js";
import { fetchIdnesDetail } from "./detail/idnes.js";
import { fetchRealitymixDetail } from "./detail/realitymix.js";

const DETAIL = {
  sreality: fetchSrealityDetail,
  bezrealitky: fetchBezrealitkyDetail,
  idnes: fetchIdnesDetail,
  realitymix: fetchRealitymixDetail,
  // Bazoš polohu na detailu nemá.
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (line) => console.log(line);
const db = openDb();

// --- 1) poloha z detailů ---
const rows = db
  .prepare("SELECT id, source, url FROM listings WHERE status IN ('active','reserved') AND lat IS NULL AND geo_json IS NULL")
  .all()
  .filter((r) => DETAIL[r.source]);
let captured = 0;
for (const r of rows) {
  const detail = await DETAIL[r.source](r.url);
  const fields = geoFields(detail.geo);
  if (Object.keys(fields).length > 0) {
    const sets = Object.keys(fields).map((k) => `${k} = ?`).join(", ");
    db.prepare(`UPDATE listings SET ${sets} WHERE id = ?`).run(...Object.values(fields), r.id);
    captured++;
  }
  await sleep(350); // zdvořilost vůči portálu
}
console.log(`Poloha z detailů: zkoumáno ${rows.length} nabídek, zachycena u ${captured}.`);

// --- 2) geokódování bodů ---
const geo = await geocodePending(db, log, { limit: 300 });
console.log(`Geokódování: ${geo.done} nových bodů, ${geo.pending} zbývá.`);

// --- 2b) oficiální ověření v RÚIAN (budova v bodě, katastrální území) ---
const ru = await ruianPending(db, log, { limit: 400 });
console.log(`RÚIAN: ${ru.done} nových dotazů, ${ru.pending} zbývá.`);

// --- 3) automatické doplnění ---
const applied = applyAutoAddresses(db, log);
console.log(`Adresy: ${applied.assigned} doplněno automaticky, ${applied.revoked} odvoláno.`);

// --- 4) přehled u nabídek, které jsou ještě online ---
const listings = db.prepare("SELECT * FROM listings").all();
const allGroups = groupListings(listings);
const actx = buildAddressContext(db, listings, allGroups);
const groups = allGroups.filter((g) => g.members.some((m) => m.status === "active" || m.status === "reserved"));
const counts = {};
const lines = [];
for (const g of groups) {
  const res = resolveForGroup(actx, g);
  counts[res.level] = (counts[res.level] || 0) + 1;
  const rep = g.members[0];
  const head = `${res.level.padEnd(8)} ${(rep.address || "").slice(0, 30).padEnd(30)}`;
  const kn = knInfoForGroup(actx, g, res);
  lines.push(`${head} ${res.text ? "→ " + res.text + "  [" + describeEvidence(res) + "]" : res.reasons.slice(0, 2).join(" | ")}${kn ? "\n         " + describeKn(kn) : ""}`);
}
console.log(`\nVýsledek u ${groups.length} bytů, které jsou ještě online:`, counts);
console.log(lines.sort().join("\n"));
db.close();
