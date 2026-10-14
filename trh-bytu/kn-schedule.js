// Rozvrh kontrol v katastru po rezervaci bytu — kdy má smysl se podívat, kdy
// ne, a v jaké fázi prodej je. Čistá logika bez DB/HTTP (jako sale-triage.js).
//
// Proč rozvrh: po rezervaci trvá, než se prodej v katastru vůbec objeví.
// Kupec s hotovostí podá návrh na vklad za 1–3 týdny, kupec s hypotékou až za
// 6–12 týdnů (schválení úvěru, podpis kupní smlouvy). Dřívější pevná připomínka
// po 21 dnech a pak každé 3 týdny chodila u hypotéky zbytečně dvakrát a u
// hotovosti pozdě. Rozvrh proto vychází ze dnů od rezervace (viz konstanty
// níž) a navazuje na to, co uživatel v katastru skutečně uviděl:
//
//   filing → byt je rezervovaný (nebo už zmizel) a v katastru zatím není
//            vidět podaný návrh na vklad (plomba).
//   price  → uživatel plombu viděl (nebo označil byt za prodaný bez ceny) —
//            prodej je potvrzený, zbývá zjistit kupní cenu; ta jde zjistit až
//            po rozhodnutí o vkladu (ochranná lhůta 20 dní, rozhodnutí
//            většinou do měsíce), proto se první kontrola ceny plánuje na
//            25. den po podání.
//   done / withdrawn → hotovo / neprodáno, žádné další kontroly.
//
// Kontrolní bod je okamžik, od kterého je kontrola "splatná". Byt je k
// vyřízení, když existuje bod v minulosti, po kterém ještě nebyla kontrola
// (`kn_checked_at`). Kliknutí na "Zatím nic" proto byt odsune až k dalšímu
// bodu, ne o pevný počet dní, a vynechaný běh nic nestlačí.

import { mergedStatus, saleVerdict, latestRemovedAt, pickOwnValue } from "./group.js";
import { reservationStart } from "./sale-triage.js";

const DAY_MS = 24 * 60 * 60 * 1000;

// Dny od rezervace. 14 a 28 chytí hotovostního kupce, 45–100 týdně okno
// hypotéky (podání za ~6–14 týdnů), pak měsíčně do půl roku — potom se byt
// označí jako "nezjištěno" (stáhnuto, nebo prodej mimo naše oko).
export const RESERVATION_CHECK_DAYS = [14, 28, 45, 52, 59, 66, 73, 80, 87, 94, 100, 130, 160, 190];
// Dny po zmizení inzerátu rezervovaného bytu. Inzerát se stahuje často kolem
// podpisu kupní smlouvy, takže plomba bývá dny až týdny po zmizení.
export const VANISH_CHECK_DAYS = [3, 10];
// Dny po podání návrhu na vklad — kontrola ceny.
export const FILING_CHECK_DAYS = [25, 32, 39, 46, 53, 60, 75, 90];

function reservationKind(day) {
  return day <= 28 ? "cash" : day <= 100 ? "mortgage" : "late";
}

const KIND_LABELS = {
  cash: (day) => `${day}. den od rezervace — kontrola pro hotovostního kupce`,
  mortgage: (day) => `${day}. den od rezervace — týdenní kontrola (okno hypotéky)`,
  late: (day) => `${day}. den od rezervace — dlouhá rezervace, měsíční kontrola`,
  vanish: (day) => `${day} dní po zmizení inzerátu — kontrola`,
  price: (day) => `${day} dní po podání vkladu — zjisti kupní cenu`,
};

function toMs(value) {
  if (value == null || value === "") return null;
  const ms = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function checkpoint(base, day, kind) {
  return { at: base + day * DAY_MS, day, kind, label: KIND_LABELS[kind](day) };
}

/**
 * Posoudí fázi prodeje a to, jestli je byt teď k vyřízení.
 *
 * @param reservedAt     začátek rezervace (ISO)
 * @param removedAt      kdy zmizel (ISO), jinak null
 * @param filedAt        den podání vkladu podle uživatele (ISO / YYYY-MM-DD), jinak null
 * @param verdict        'sold' | 'withdrawn' | null (viz saleVerdict v group.js)
 * @param priceKnown     je zjištěná kupní cena?
 * @param priceBaseAt    odkdy počítat kontroly ceny, když byt je prodaný, ale
 *                       plomba se nezapsala (např. "Prodáno" z Telegramu)
 * @param lastCheckedAt  poslední kontrola v katastru (ISO), jinak null
 * @returns `{ stage, ageDays, due, dueAt, kind, reason, nextAt, expired }`
 */
export function assessSaleTrack({ reservedAt, removedAt = null, filedAt = null, verdict = null, priceKnown = false, priceBaseAt = null, lastCheckedAt = null, now = Date.now() }) {
  const reservedMs = toMs(reservedAt);
  const ageDays = reservedMs == null ? null : Math.floor((now - reservedMs) / DAY_MS);
  const base = { ageDays, due: false, dueAt: null, kind: null, reason: null, nextAt: null, expired: false };

  if (verdict === "withdrawn") return { ...base, stage: "withdrawn" };
  const sold = verdict === "sold" || filedAt != null;
  if (sold && priceKnown) return { ...base, stage: "done" };

  let stage;
  let points;
  if (sold) {
    stage = "price";
    const filedMs = toMs(filedAt) ?? toMs(priceBaseAt) ?? reservedMs ?? now;
    points = FILING_CHECK_DAYS.map((day) => checkpoint(filedMs, day, "price"));
  } else {
    stage = "filing";
    points = RESERVATION_CHECK_DAYS.map((day) => checkpoint(reservedMs ?? now, day, reservationKind(day)));
    const removedMs = toMs(removedAt);
    if (removedMs != null) points.push(...VANISH_CHECK_DAYS.map((day) => checkpoint(removedMs, day, "vanish")));
  }
  points.sort((a, b) => a.at - b.at);

  const checkedMs = toMs(lastCheckedAt) ?? -Infinity;
  const pending = points.filter((p) => p.at <= now && p.at > checkedMs);
  if (pending.length) {
    const latest = pending[pending.length - 1];
    return { ...base, stage, due: true, dueAt: latest.at, kind: latest.kind, reason: latest.label };
  }
  const next = points.find((p) => p.at > now);
  // Žádný další bod a nic nečeká = rozvrh je vyčerpaný, byt je "nezjištěno".
  return { ...base, stage, nextAt: next ? next.at : null, expired: !next };
}

/**
 * Totéž nad skupinou nabídek jednoho bytu. `null`, když byt nemá platnou
 * rezervaci (a tedy není součástí téhle fronty), nebo je pořád v nabídce.
 */
export function buildSaleTrack(members, events, now = Date.now()) {
  const reservedAt = reservationStart(members, events);
  if (!reservedAt) return null;
  const status = mergedStatus(members);
  const verdict = saleVerdict(members);
  if (status === "active") return null; // nabízí se dál (třeba jinde) — není to prodej
  if (!verdict && status === "sold") return { ...assessSaleTrack({ reservedAt, verdict: "sold", priceKnown: true, now }), reservedAt };

  const lastCheckedAt = members.reduce((max, m) => (m.kn_checked_at && m.kn_checked_at > max ? m.kn_checked_at : max), "") || null;
  const track = assessSaleTrack({
    reservedAt,
    removedAt: status === "removed" ? latestRemovedAt(members) : null,
    filedAt: pickOwnValue(members, "kn_filed_at"),
    verdict,
    priceKnown: pickOwnValue(members, "verified_sale_price_czk") != null,
    priceBaseAt: pickOwnValue(members, "reservation_sold_at") ?? lastCheckedAt,
    lastCheckedAt,
    now,
  });
  return { ...track, reservedAt };
}

/** Dny od rezervace do podání vkladu (pro "jak to u tebe obvykle trvá"), jinak null. */
export function filingLagDays(reservedAt, filedAt) {
  const a = toMs(reservedAt);
  const b = toMs(filedAt);
  return a == null || b == null || b < a ? null : Math.round((b - a) / DAY_MS);
}

/** Medián z čísel, jinak null. */
export function median(values) {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}
