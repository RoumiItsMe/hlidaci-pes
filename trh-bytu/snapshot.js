// Snímek výpisů portálů — to, co umí zjistit cloudový sběrač (scout.js), když PC není zapnuté. Sběrač do databáze
// nesahá: jen zaznamená, v jaký okamžik byly na kterém portálu jaké nabídky a ceny. Appka je při startu přehraje
// (snapshot-replay.js) stejnými pravidly jako běžný sběr, ale s časem pozorování, takže po týdnu bez PC vidí, kdy se
// co zhruba stalo, a ne "všechno dnes".
//
// Formát (JSON, jeden soubor na běh a region):
//   { version: 1, region: "default", collectedAt: "2026-10-31T04:10:00.000Z",
//     sources: { sreality: { ok: true, items: [ { id, title, url, priceCzk, address, reserved?, sold?, … } ] },
//                bazos:    { ok: false, error: "…" } } }
// `items` jsou položky výpisu tak, jak je vrací `source.fetchList`; u portálů, které rezervaci / prodej ukazují jen na
// detailu (Sreality, iDNES), je sběrač doplní z detailu jako `reserved` / `sold`.

export const SNAPSHOT_VERSION = 1;
const DETAIL_PAUSE_MS = 250; // zdvořilost vůči portálu

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Cesta snímku v úložišti: `<region>/<ISO čas s pomlčkami>.json` (řadí se podle času). */
export function snapshotRelPath(snapshot) {
  return `${snapshot.region}/${snapshot.collectedAt.replace(/[:.]/g, "-")}.json`;
}

/** Čas pozorování ze jména souboru snímku (inverze snapshotRelPath), nebo null. */
export function collectedAtFromFile(fileName) {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3}Z)\.json$/.exec(fileName);
  return m ? `${m[1]}:${m[2]}:${m[3]}.${m[4]}` : null;
}

/** Je to snímek, kterému rozumíme? (verze, region, čas, zdroje) */
export function isValidSnapshot(snapshot) {
  return Boolean(
    snapshot &&
      snapshot.version === SNAPSHOT_VERSION &&
      typeof snapshot.region === "string" &&
      Number.isFinite(Date.parse(snapshot.collectedAt)) &&
      snapshot.sources &&
      typeof snapshot.sources === "object" &&
      Object.values(snapshot.sources).every((s) => s && typeof s.ok === "boolean" && (!s.ok || Array.isArray(s.items)))
  );
}

/**
 * Stáhne výpisy všech zdrojů a poskládá snímek. Zdroj, jehož výpis se nepodařilo stáhnout, se zapíše jako
 * `{ ok: false, error }` — appka ho při přehrání přeskočí, takže výpadek jednoho portálu nevyrobí falešná zmizení.
 * Příznak rezervace / prodeje, který portál ukazuje jen na detailu, se doplní u každé nabídky zvlášť; když se detail
 * nestáhne, příznak zůstane nezadaný (= "nevíme", nic se nemění).
 *
 * @param sources `[{ name, fetchList(watch), fetchDetail(url), reservationFromDetail?, soldFromDetail? }]`
 */
export async function collectSnapshot({ sources, watch, regionKey, log = () => {}, now = new Date(), pause = sleep }) {
  const snapshot = { version: SNAPSHOT_VERSION, region: regionKey, collectedAt: now.toISOString(), sources: {} };
  for (const source of sources) {
    let items;
    try {
      items = await source.fetchList(watch);
    } catch (err) {
      log(`[${source.name}] CHYBA při stahování seznamu: ${err.message}`);
      snapshot.sources[source.name] = { ok: false, error: String(err.message ?? err) };
      continue;
    }
    if (source.reservationFromDetail || source.soldFromDetail) {
      for (const item of items) {
        try {
          const detail = await source.fetchDetail(item.url);
          if (source.reservationFromDetail) item.reserved = detail.reserved;
          if (source.soldFromDetail) item.sold = detail.sold === true;
        } catch (err) {
          log(`[${source.name}] detail ${item.id} se nepodařilo stáhnout (${err.message}) — příznak zůstává nezadaný`);
        }
        await pause(DETAIL_PAUSE_MS);
      }
    }
    snapshot.sources[source.name] = { ok: true, items };
    log(`[${source.name}] ${items.length} nabídek`);
  }
  return snapshot;
}

/** Aspoň jeden zdroj se podařilo stáhnout (jinak snímek nemá smysl ukládat). */
export function hasAnyData(snapshot) {
  return Object.values(snapshot.sources).some((s) => s.ok);
}
