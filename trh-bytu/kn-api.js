// Klient bezplatného REST API katastru nemovitostí (api-kn.cuzk.gov.cz) a
// sken domu: jednotky, plomby (podané vklady) a řízení k nim.
//
// Co API dává a co ne (ověřeno naostro 2026-10-14): u stavby seznam jednotek,
// u jednotky číslo LV, způsob využití, podíl na společných částech a seznam
// řízení, kterými je zaplombovaná (`rizeniPlomby`); u řízení datum přijetí
// návrhu, stav a provedené operace. Žádné ceny a žádní vlastníci — kupní cenu
// appka dál zjišťuje ručně. Limit volání je per období (`StavUctu`), takže
// sken šetří: plomby jsou vidět jen u jednotky, ne u stavby, proto se dům
// prochází po jednotkách, a detail řízení se bere jen u nových plomb.
//
// Klíč se čte z KN_API_KEY (`.env.local`, viz README) a nikdy se nevypisuje —
// chybové hlášky nesou jen cestu bez hlavičky.

const BASE = "https://api-kn.cuzk.gov.cz/api/v1";
const TIMEOUT_MS = 20000;
const DAY_MS = 24 * 60 * 60 * 1000;
// Detail řízení se znovu nestahuje dřív než za tolik dní (stav se mění pomalu).
const PROCEEDING_REFRESH_DAYS = 3;
// Kolik skončených řízení si dům pamatuje.
const CLOSED_KEEP = 20;

export class KnApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "KnApiError";
    this.status = status;
  }
}

export function createKnClient({ apiKey = process.env.KN_API_KEY, fetchImpl = globalThis.fetch } = {}) {
  let calls = 0;
  async function get(path) {
    calls++;
    const res = await fetchImpl(BASE + path, { headers: { ApiKey: apiKey, Accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new KnApiError(`KN API ${path.replace(/\/\d+$/, "/{id}")} HTTP ${res.status}`, res.status);
    const json = await res.json();
    return json.data ?? json;
  }
  return {
    get calls() {
      return calls;
    },
    hasKey: Boolean(apiKey),
    usage: () => get("/AplikacniSluzby/StavUctu"),
    building: (id) => get(`/Stavby/${id}`),
    unit: (id) => get(`/Jednotky/${id}`),
    proceeding: (id) => get(`/Rizeni/${id}`),
  };
}

/**
 * Číslo jednotky z "412/12" (číslo popisné / číslo jednotky, jak ho vidí
 * uživatel v katastru) na číslo, které vrací API (4120012 = č.p. × 10000 +
 * číslo jednotky). Číslo, které už vypadá jako z API (5–9 číslic), projde
 * beze změny. Jiný zápis (samotné "12") → null: bez čísla popisného nelze
 * jednotku v domě určit.
 */
export function parseUnitNumber(text) {
  const t = String(text ?? "").trim();
  const slash = /^(\d{1,5})\s*\/\s*(\d{1,4})$/.exec(t);
  if (slash) return Number(slash[1]) * 10000 + Number(slash[2]);
  return /^\d{5,9}$/.test(t) ? Number(t) : null;
}

/** 4120012 → "412/12" */
export function formatUnitNumber(number) {
  return `${Math.floor(number / 10000)}/${number % 10000}`;
}

function toProceeding(detail, ref, nowMs) {
  return {
    id: detail?.id ?? ref.id,
    typ: detail?.typRizeni ?? ref.typRizeni ?? null,
    cislo: detail?.poradoveCislo ?? ref.poradoveCislo ?? null,
    rok: detail?.rok ?? ref.rok ?? null,
    datumPrijeti: detail?.datumPrijeti ?? null,
    stav: detail?.stav ?? null,
    operace: (detail?.provedeneOperace ?? []).map((o) => ({ nazev: o.nazev, datum: o.datumProvedeni })),
    fetchedAt: detail ? new Date(nowMs).toISOString() : null,
  };
}

/**
 * Projde dům. `wantUnits` = množina čísel jednotek (z API), které stačí
 * zkontrolovat — jinak (null) se projdou všechny. Při nedostatku rozpočtu na
 * celý dům vrací `{ skipped: "budget" }` a nic nezapíše: neúplný sken by
 * prohlásil nezkontrolované jednotky za čisté.
 *
 * `prev` = předchozí sken téhož domu: ušetří dotaz na seznam jednotek při
 * částečném skenu, detail už známých řízení a umožní poznat plombu, která od
 * minula zmizela (řízení skončilo).
 */
export async function scanBuilding(client, buildingId, { prev = null, wantUnits = null, now = Date.now(), budget = Infinity } = {}) {
  const startCalls = client.calls;
  const left = () => budget - (client.calls - startCalls);
  const full = wantUnits == null;

  let units;
  let buildingPlomby = [];
  if (!full && prev?.units?.length) {
    units = prev.units.map((u) => ({ ...u }));
  } else {
    const b = await client.building(buildingId);
    buildingPlomby = (b.rizeniPlomby ?? []).map((r) => r.id);
    const known = new Map((prev?.units ?? []).map((u) => [u.id, u]));
    units = (b.jednotky ?? []).map((u) => ({ id: u.id, number: u.cisloJednotky, lv: known.get(u.id)?.lv ?? null, use: known.get(u.id)?.use ?? null, share: known.get(u.id)?.share ?? null }));
  }

  // Celý dům: jen byty. Garáže a nebytové prostory (druh známe z minulého
  // skenu) se přeskočí — ušetří to volání a jejich plomba není prodej bytu.
  const toScan = full ? units.filter((u) => u.use == null || u.use === "byt") : units.filter((u) => wantUnits.has(u.number));
  if (left() < toScan.length) return { skipped: "budget", needed: toScan.length };

  const prevByUnit = new Map((prev?.plomby ?? []).map((p) => [p.unit, p]));
  const prevProceedings = new Map();
  for (const p of prev?.plomby ?? []) for (const r of p.rizeni) prevProceedings.set(r.id, r);
  for (const c of prev?.closed ?? []) prevProceedings.set(c.proceeding.id, c.proceeding);

  const plomby = [];
  const closed = [...(prev?.closed ?? [])];
  const loadProceeding = async (ref) => {
    const old = prevProceedings.get(ref.id);
    const fresh = old?.fetchedAt && now - Date.parse(old.fetchedAt) < PROCEEDING_REFRESH_DAYS * DAY_MS && old.datumPrijeti;
    if (fresh) return old;
    if (left() < 1) return old ?? toProceeding(null, ref, now);
    return toProceeding(await client.proceeding(ref.id), ref, now);
  };

  for (const u of toScan) {
    const d = await client.unit(u.id);
    u.lv = d.lv?.cislo ?? u.lv;
    u.use = d.zpusobVyuziti?.nazev ?? u.use;
    u.share = d.podilNaSpolecnychCastechDomu ? `${d.podilNaSpolecnychCastechDomu.citatel}/${d.podilNaSpolecnychCastechDomu.jmenovatel}` : u.share;
    const refs = d.rizeniPlomby ?? [];
    if (refs.length) {
      const rizeni = [];
      for (const ref of refs) rizeni.push(await loadProceeding(ref)); // po jednom — API nezatěžujeme souběhem
      plomby.push({ unit: u.number, lv: u.lv, rizeni });
    }

    // Plomba, která tu minule byla a teď není: řízení skončilo (vklad
    // proveden, nebo zamítnut) — zapamatuj si jeho konečný stav.
    const nowIds = new Set(refs.map((r) => r.id));
    for (const old of prevByUnit.get(u.number)?.rizeni ?? []) {
      if (nowIds.has(old.id) || closed.some((c) => c.proceeding.id === old.id)) continue;
      let ended = old;
      if (left() >= 1) ended = toProceeding(await client.proceeding(old.id), old, now);
      closed.push({ unit: u.number, lv: u.lv, proceeding: ended, closedSeenAt: new Date(now).toISOString() });
    }
  }

  return {
    buildingId,
    scannedAt: new Date(now).toISOString(),
    full,
    calls: client.calls - startCalls,
    units,
    buildingPlomby,
    plomby,
    closed: closed.slice(-CLOSED_KEEP),
  };
}
