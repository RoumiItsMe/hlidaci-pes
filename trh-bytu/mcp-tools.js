// Nástroje (jen pro čtení) pro dotazy v chatu přes MCP (mcp-server.js).
//
// Čísla se berou ze STEJNÉ logiky jako ve webové appce: entries.js (skupiny nabídek
// napříč portály, stavy, ceny), sale-status.js (co je "Prodáno" a co "Čeká na
// ověření"), sale-stats.js (cena prodeje: ověřená x odhad). Chat tak neříká jiná čísla
// než Statistiky v appce. Nic se nezapisuje — databáze se otevírá jen pro čtení.
//
// Každý nástroj vrací obyčejný objekt (JSON) s poli česky, včetně `upozorneni` —
// vysvětlení, z čeho čísla vznikla (ověřená x odhadnutá cena, malý vzorek, ...).

import { computeEntries } from "./entries.js";
import { saleMoment, marketSnapshot } from "./dashboard.js";
import { isConfirmedSale, isPendingSale, isSoldOrAlmost } from "./sale-status.js";
import { effectivePriceForStats } from "./sale-stats.js";
import { saleEvidence } from "./sale-record.js";
import { entryDiscount, percent, discountRange, discountRangeLabel, MIN_CALIBRATION_SAMPLES } from "./price-discount.js";
import { stripDiacritics } from "./geo-suggest.js";
import { PARAM_FIELDS, OWN_FIELDS } from "./params.js";
import { traceVanished, CATEGORY_LABELS as TRACE_LABELS } from "./vanish-trace.js";

const SOURCE_NAMES = { sreality: "Sreality.cz", bezrealitky: "Bezrealitky.cz", idnes: "Reality.iDNES.cz", realitymix: "RealityMIX.cz", bazos: "Bazoš.cz" };
const EVENT_NAMES = {
  created: "zaevidováno",
  price_change: "změna ceny",
  reserved: "označeno jako rezervováno",
  unreserved: "rezervace zrušena",
  sold: "prodáno",
  removed: "zmizelo z nabídky",
  reactivated: "znovu v nabídce",
  relisted: "inzerát znovu vložen pod novým ID",
};
const DAY_MS = 24 * 60 * 60 * 1000;
const SMALL_SAMPLE = 5;

export class ToolInputError extends Error {}

// --- pomocné ---

/** Den ve tvaru YYYY-MM-DD: datum bez času platí tak, jak je; časový údaj (ISO, UTC) se přepočte na pražský den. */
export function dayOf(value) {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toLocaleDateString("sv-SE", { timeZone: "Europe/Prague" }) : null;
}

function parseDay(value, name) {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new ToolInputError(`Parametr „${name}“ musí být datum ve tvaru RRRR-MM-DD (např. 2026-09-30), dostal jsem: ${JSON.stringify(value)}.`);
  }
  return value;
}

function parseLimit(value, fallback, max = 200) {
  if (value == null) return fallback;
  if (!Number.isInteger(value) || value < 1) throw new ToolInputError(`Parametr „limit“ musí být celé číslo od 1 do ${max}.`);
  return Math.min(value, max);
}

function parseNumber(value, name) {
  if (value == null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new ToolInputError(`Parametr „${name}“ musí být číslo.`);
  return value;
}

function parseEnum(value, name, allowed, fallback) {
  if (value == null) return fallback;
  if (!allowed.includes(value)) throw new ToolInputError(`Parametr „${name}“ smí být jen: ${allowed.join(", ")}. Dostal jsem: ${JSON.stringify(value)}.`);
  return value;
}

/** "1 byt", "3 byty", "5 bytů". */
export const bytu = (n) => `${n} ${n === 1 ? "byt" : n >= 2 && n <= 4 ? "byty" : "bytů"}`;

const norm = (s) => stripDiacritics(s).replace(/\s+/g, " ").trim();
const normDisposition = (s) => stripDiacritics(s).replace(/\s+/g, "");

function median(values) {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return Math.round(sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2);
}
const mean = (values) => (values.length ? Math.round(values.reduce((s, v) => s + v, 0) / values.length) : null);

/** průměr / medián / min / max (zaokrouhleno) — null, když není z čeho. */
function summarize(values) {
  const v = values.filter((x) => Number.isFinite(x));
  if (!v.length) return null;
  return { prumer: mean(v), median: median(v), min: Math.round(Math.min(...v)), max: Math.round(Math.max(...v)) };
}

// Stav bytu = vlastní hodnocení "Stav" (params.js, OWN_FIELDS): kód pro chat → kód v databázi.
const CONDITION_FIELD = OWN_FIELDS.find((f) => f.column === "own_condition");
const CONDITION_CODES = { nutna_rekonstrukce: "needs_reno", udrzovany: "maintained", po_rekonstrukci: "renovated", v_topu: "top", novostavba: "novostavba", bez_hodnoceni: null };
const CONDITION_ENUM = Object.keys(CONDITION_CODES);
const CONDITION_HELP =
  "Stav bytu podle vlastního hodnocení uživatele: nutna_rekonstrukce, udrzovany, po_rekonstrukci, v_topu (nejlepší stav — drahá, kvalitní rekonstrukce; nejde o ⭐ TOP z přehledu), novostavba, bez_hodnoceni (stav nevyplněn).";
const conditionLabel = (e) => (e.ownCondition ? CONDITION_FIELD.options.find(([code]) => code === e.ownCondition)?.[1] ?? e.ownCondition : null);

function matchesFilters(e, { mesto, dispozice, plochaOd, plochaDo, stavBytu }) {
  if (stavBytu !== undefined && (e.ownCondition ?? null) !== CONDITION_CODES[stavBytu]) return false;
  if (mesto && !norm(e.city ?? "").includes(norm(mesto)) && !norm(e.address ?? "").includes(norm(mesto))) return false;
  if (dispozice && normDisposition(e.rep.disposition ?? "") !== normDisposition(dispozice)) return false;
  if (plochaOd != null && !(e.rep.area_m2 >= plochaOd)) return false;
  if (plochaDo != null && !(e.rep.area_m2 <= plochaDo)) return false;
  return true;
}

// Popisek původu ceny; sleva je ta, kterou appka u bytu opravdu použila (pevná 10 % nebo odvozená z ověřených prodejů).
const basisLabel = (basis, discount) =>
  ({
    verified: "ověřená kupní cena",
    assumed: `odhad (poslední inzerovaná cena −${percent(discount)} %, v katastru nejde ověřit)`,
    pending: `odhad (poslední inzerovaná cena −${percent(discount)} %, čeká na ověření v katastru)`,
    none: "cena neznámá",
  })[basis];

/** Odkud se bere sleva u odhadů — pro odpověď v chatu (stejná informace jako na stránce Statistiky). */
function discountInfo(e) {
  const info = e?.discount ?? { discount: entryDiscount(e), calibrated: false, samples: 0 };
  return {
    slevaZPosledniCenyProcent: percent(info.discount),
    rozpetiSlevyProcent: discountRangeLabel(info.discount),
    odvozenaZOverenychProdeju: info.calibrated,
    pocetOverenychProdeju: info.samples,
    poznamka: info.calibrated
      ? `Sleva je odvozená z ${info.samples} ověřených prodejů (medián rozdílu mezi poslední inzerovanou a kupní cenou).`
      : `Sleva je zatím pevných ${percent(info.discount)} % (ověřených prodejů je ${info.samples} z ${MIN_CALIBRATION_SAMPLES} potřebných pro odvození z dat).`,
  };
}
const EVIDENCE_LABELS = { sold: "portál označil jako prodáno", gone: "po rezervaci zmizelo z portálů", reserved: "zatím rezervováno" };

function momentSource(e) {
  if (e.verifiedSaleDate) return "datum prodeje z katastru (zadané ručně)";
  if (e.knFiledAt) return "den podání vkladu v katastru";
  if (e.removedAt) return "den zmizení inzerátu";
  return null;
}

function portals(e) {
  return [...new Set(e.g.members.map((m) => SOURCE_NAMES[m.source] ?? m.source))];
}

/** Parametry bytu s českými názvy (Vlastnictví, Stav, …); prázdné se vynechají. */
function labeledParams(params) {
  const out = {};
  for (const [key, label] of PARAM_FIELDS) if (params?.[key] != null && params[key] !== "") out[label] = params[key];
  return out;
}

/** Vlastní hodnocení uživatele (Stav, Konstrukce, Revitalizace domu) slovy místo interních kódů. */
function ownRatings(e) {
  const values = { own_condition: e.ownCondition, own_construction: e.ownConstruction, own_revitalized: e.ownRevitalized };
  const out = {};
  for (const field of OWN_FIELDS) {
    if (!(field.column in values) || !values[field.column]) continue;
    out[field.label] = field.options.find(([code]) => code === values[field.column])?.[1] ?? values[field.column];
  }
  return out;
}

/** Základní popis bytu pro seznamy. */
function baseRow(e, baseUrl) {
  return {
    id: e.rep.id,
    odkaz: baseUrl ? `${baseUrl}/byt/${encodeURIComponent(e.rep.id)}` : undefined,
    nazev: `Byt${e.rep.disposition ? ` ${e.rep.disposition}` : ""}${e.rep.area_m2 ? `, ${e.rep.area_m2} m²` : ""}`,
    adresa: e.address || null,
    mesto: e.city || null,
    dispozice: e.rep.disposition || null,
    plochaM2: e.rep.area_m2 ?? null,
    stavBytu: conditionLabel(e),
    portaly: portals(e),
  };
}

function saleRow(e, baseUrl) {
  const { price, basis } = effectivePriceForStats(e);
  const area = e.rep.area_m2;
  const moment = saleMoment(e);
  return {
    ...baseRow(e, baseUrl),
    stav: isConfirmedSale(e) ? "prodáno (cena potvrzená)" : isPendingSale(e) ? "čeká na ověření" : "rezervováno",
    doklad: EVIDENCE_LABELS[saleEvidence(e.status)],
    vKatastruPodanVklad: e.knFiledAt ? dayOf(e.knFiledAt) : null,
    datumProdeje: dayOf(moment),
    datumProdejeZdroj: momentSource(e),
    posledniInzerovanaCenaKc: e.price ?? null,
    cenaProdejeKc: price,
    cenaProdejeZaklad: basisLabel(basis, entryDiscount(e)),
    cenaZaM2Kc: price != null && area ? Math.round(price / area) : null,
    dnuVNabidce: e.daysOnMarket,
    pocetSnizeniCeny: e.priceDropCount,
    snizeniCenyCelkemKc: e.totalDiscountCzk,
  };
}

function basisCounts(rows) {
  const count = (b) => rows.filter((r) => r.basis === b).length;
  return { overenych: count("verified"), odhadNejdeOverit: count("assumed"), odhadCekaNaOvereni: count("pending") };
}

function evidenceCounts(rows) {
  const count = (kind) => rows.filter((r) => saleEvidence(r.e.status) === kind).length;
  return { portalOznacilJakoProdano: count("sold"), poRezervaciZmizeloZPortalu: count("gone"), zatimRezervovano: count("reserved") };
}

function priceNotes(rows, label = "ceny", discount = entryDiscount(undefined)) {
  const c = basisCounts(rows);
  const notes = [];
  if (c.odhadNejdeOverit + c.odhadCekaNaOvereni > 0) {
    notes.push(
      `Z ${bytu(rows.length)} má ${c.overenych} ověřenou kupní cenu z katastru a ${c.odhadNejdeOverit + c.odhadCekaNaOvereni} jen ODHAD (poslední inzerovaná cena −${percent(discount)} %, rozpětí ${discountRangeLabel(discount)}) — ${label} jsou proto orientační.`
    );
  }
  if (rows.length > 0 && rows.length < SMALL_SAMPLE) notes.push(`Malý vzorek (${bytu(rows.length)}) — čísla vypovídají jen velmi málo.`);
  return notes;
}

function entriesOf(db) {
  return computeEntries(db).filter((e) => !e.hidden);
}

// --- nástroje ---

const SALE_DEFINITIONS =
  "Prodáno = byt je označený jako prodaný A jeho cena prodeje je potvrzená (z katastru, nebo to v katastru nejde ověřit, tak platí poslední cena). " +
  "Čeká na ověření = portál označil prodej, ale cena v katastru ještě není potvrzená, nebo byt po rezervaci zmizel z portálů (téměř jistý prodej, bez potvrzení). " +
  `Cena prodeje: ověřená kupní cena z katastru, jinak ODHAD = poslední inzerovaná cena snížená o slevu (zatím pevných ${percent(entryDiscount(undefined))} %; od ${MIN_CALIBRATION_SAMPLES} ověřených prodejů ji appka odvodí z reálných cen — aktuální hodnota a rozpětí jsou v odpovědi ve „slevaOdhadu“). U odhadů uváděj rozpětí, ne jedno číslo.`;

export function createTools({ baseUrl = null, now = () => Date.now() } = {}) {
  return [
    {
      name: "trh_prehled",
      title: "Přehled trhu",
      description:
        "Souhrn aktuálního stavu sledovaného trhu s byty v této sekci: kolik je nabídek (v nabídce, rezervovaných), kolik se prodalo / čeká na ověření, novinky za týden, medián ceny za m² u nabídek a stáří dat. Dobrý první krok, když se uživatel ptá obecně „jak to vypadá“.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      handler(db) {
        const entries = entriesOf(db);
        const snap = marketSnapshot(entries, { now: now() });
        const newest = db.prepare("SELECT MAX(last_seen_at) AS seen FROM listings").get().seen;
        return {
          sekce: baseUrl,
          pocetBytuVEvidenci: entries.length,
          vNabidce: snap.active,
          rezervovano: snap.reserved,
          noveZaTyden: snap.newThisWeek,
          prodanoPotvrzeno: snap.confirmed,
          cekaNaOvereni: snap.pending,
          medianCenyZaM2NabidekKc: snap.medianPricePerM2,
          posledniAktualizaceDat: newest ? dayOf(newest) : null,
          upozorneni: [SALE_DEFINITIONS, "Data jsou jen z této sekce (sledované lokality); skryté byty se nepočítají."],
        };
      },
    },
    {
      name: "prodane_byty",
      title: "Prodané byty",
      description:
        "Seznam prodaných a téměř jistě prodaných bytů, ve kterém lze omezit období prodeje, město, dispozici a stav. " +
        SALE_DEFINITIONS +
        " Datum prodeje = datum z katastru (zadané ručně), jinak den podání vkladu, jinak den zmizení inzerátu — u každého bytu je uvedeno, které z nich to je.",
      inputSchema: {
        type: "object",
        properties: {
          od: { type: "string", description: "Začátek období prodeje (včetně), RRRR-MM-DD. Výchozí: před 90 dny." },
          do: { type: "string", description: "Konec období prodeje (včetně), RRRR-MM-DD. Výchozí: dnes." },
          stav: { type: "string", enum: ["vse", "potvrzene", "cekajici"], description: "vse = Prodáno i Čeká na ověření (výchozí); potvrzene = jen Prodáno; cekajici = jen Čeká na ověření." },
          mesto: { type: "string", description: "Jen byty z tohoto města (např. Letohrad), bez ohledu na diakritiku." },
          dispozice: { type: "string", description: "Jen tato dispozice (např. 2+1, 3+kk)." },
          stav_bytu: { type: "string", enum: CONDITION_ENUM, description: CONDITION_HELP },
          limit: { type: "integer", description: "Nejvýš kolik bytů vrátit (výchozí 50, nejvíc 200)." },
        },
        additionalProperties: false,
      },
      handler(db, args) {
        const doDen = parseDay(args.do, "do") ?? dayOf(new Date(now()).toISOString());
        const odDen = parseDay(args.od, "od") ?? dayOf(new Date(now() - 90 * DAY_MS).toISOString());
        if (odDen > doDen) throw new ToolInputError(`Začátek období (${odDen}) je později než konec (${doDen}).`);
        const stav = parseEnum(args.stav, "stav", ["vse", "potvrzene", "cekajici"], "vse");
        const limit = parseLimit(args.limit, 50);
        const filters = { mesto: args.mesto, dispozice: args.dispozice, stavBytu: parseEnum(args.stav_bytu, "stav_bytu", CONDITION_ENUM, undefined) };
        const pool = entriesOf(db).filter((e) => (stav === "potvrzene" ? isConfirmedSale(e) : stav === "cekajici" ? isPendingSale(e) : isSoldOrAlmost(e)) && matchesFilters(e, filters));
        const undated = pool.filter((e) => !dayOf(saleMoment(e)));
        const inPeriod = pool
          .filter((e) => {
            const day = dayOf(saleMoment(e));
            return day && day >= odDen && day <= doDen;
          })
          .sort((a, b) => (dayOf(saleMoment(b)) < dayOf(saleMoment(a)) ? -1 : 1));
        const rows = inPeriod.map((e) => saleRow(e, baseUrl));
        const priced = rows.filter((r) => r.cenaProdejeKc != null);
        const notes = [SALE_DEFINITIONS];
        if (undated.length) notes.push(`${undated.length} prodaných bytů nemá žádné datum, takže se do období nevešly.`);
        if (rows.length > limit) notes.push(`Vráceno prvních ${limit} z ${rows.length} (nejnovější prodeje první).`);
        notes.push(...priceNotes(inPeriod.map((e) => effectivePriceForStats(e)).filter((p) => p.price != null), "ceny", entryDiscount(inPeriod[0])));
        return {
          obdobi: { od: odDen, do: doDen },
          pocet: rows.length,
          pocetPotvrzenych: inPeriod.filter(isConfirmedSale).length,
          pocetCekajicichNaOvereni: inPeriod.filter(isPendingSale).length,
          souhrnCenyProdeje: summarize(priced.map((r) => r.cenaProdejeKc)),
          souhrnCenyZaM2: summarize(priced.map((r) => r.cenaZaM2Kc)),
          slevaOdhadu: discountInfo(inPeriod[0]),
          byty: rows.slice(0, limit),
          upozorneni: notes,
        };
      },
    },
    {
      name: "statistiky_cen",
      title: "Statistiky cen",
      description:
        "Průměr, medián, minimum a maximum ceny a ceny za m² (a doby v nabídce), volitelně členěné podle města, dispozice, měsíce nebo stavu bytu (na otázku „za kolik se prodávají byty v TOPu“ použij stav_bytu=v_topu). typ=prodane počítá z prodaných a téměř jistě prodaných bytů (cena prodeje: ověřená, jinak odhad; období se bere podle data prodeje), typ=nabidky z inzerovaných cen aktuálních nabídek. " +
        SALE_DEFINITIONS +
        " Vždy uveď, kolik bytů je za číslem a kolik z toho jsou odhady.",
      inputSchema: {
        type: "object",
        properties: {
          typ: { type: "string", enum: ["prodane", "nabidky"], description: "prodane (výchozí) | nabidky (aktuální inzerované ceny bytů v nabídce a rezervovaných)." },
          vzorek: { type: "string", enum: ["vse", "potvrzene"], description: "Jen pro typ=prodane. vse = jako Statistiky v appce (prodané, po rezervaci zmizelé i rezervované); potvrzene = jen Prodáno s potvrzenou cenou. Výchozí vse." },
          od: { type: "string", description: "Začátek období (RRRR-MM-DD). Pro prodane datum prodeje, pro nabidky datum, kdy se nabídka objevila. Výchozí: bez omezení." },
          do: { type: "string", description: "Konec období (RRRR-MM-DD). Výchozí: bez omezení." },
          clenit_podle: { type: "string", enum: ["zadne", "mesto", "dispozice", "mesic", "stav_bytu"], description: "Jak výsledek rozdělit do skupin. Výchozí zadne (jeden souhrn)." },
          mesto: { type: "string", description: "Jen byty z tohoto města." },
          dispozice: { type: "string", description: "Jen tato dispozice (např. 2+1)." },
          stav_bytu: { type: "string", enum: CONDITION_ENUM, description: CONDITION_HELP },
        },
        additionalProperties: false,
      },
      handler(db, args) {
        const typ = parseEnum(args.typ, "typ", ["prodane", "nabidky"], "prodane");
        const vzorek = parseEnum(args.vzorek, "vzorek", ["vse", "potvrzene"], "vse");
        const clenit = parseEnum(args.clenit_podle, "clenit_podle", ["zadne", "mesto", "dispozice", "mesic", "stav_bytu"], "zadne");
        const od = parseDay(args.od, "od");
        const doDen = parseDay(args.do, "do");
        if (od && doDen && od > doDen) throw new ToolInputError(`Začátek období (${od}) je později než konec (${doDen}).`);
        const filters = { mesto: args.mesto, dispozice: args.dispozice, stavBytu: parseEnum(args.stav_bytu, "stav_bytu", CONDITION_ENUM, undefined) };
        const inRange = (day) => day && (!od || day >= od) && (!doDen || day <= doDen);

        let rows;
        const notes = [];
        if (typ === "prodane") {
          // Stejný výběr jako Statistiky v appce (almostSoldSaleStats), případně jen potvrzené.
          const pool = entriesOf(db).filter((e) => (vzorek === "potvrzene" ? isConfirmedSale(e) : e.almostSold && e.statsInclude !== "exclude") && matchesFilters(e, filters));
          const dated = pool.filter((e) => inRange(dayOf(saleMoment(e))) || (!od && !doDen));
          rows = dated
            .map((e) => {
              const { price, basis } = effectivePriceForStats(e);
              const area = e.rep.area_m2;
              return { e, price, basis, perM2: price != null && area ? price / area : null, day: dayOf(saleMoment(e)), days: e.daysOnMarket };
            })
            .filter((r) => r.price != null);
          notes.push(SALE_DEFINITIONS);
          if (vzorek === "vse") notes.push("Vzorek je stejný jako Statistiky v appce: prodané, po rezervaci zmizelé i zatím rezervované byty; ruční „Ve statistice: vyřadit“ se respektuje.");
        } else {
          const pool = entriesOf(db).filter((e) => (e.status === "active" || e.status === "reserved") && matchesFilters(e, filters));
          rows = pool
            .filter((e) => (!od && !doDen) || inRange(dayOf(e.discoveredAt)))
            .map((e) => ({ e, price: e.price, basis: "asking", perM2: e.pricePerM2, day: dayOf(e.discoveredAt), days: e.daysOnMarket }))
            .filter((r) => r.price != null);
          notes.push("Ceny jsou INZEROVANÉ ceny aktuálních nabídek (ne ceny, za které se byty prodají).");
        }

        const keyOf = (r) =>
          clenit === "mesto" ? r.e.city || "(neznámé město)" : clenit === "dispozice" ? r.e.rep.disposition || "(neznámá dispozice)" : clenit === "mesic" ? (r.day ?? "bez data").slice(0, 7) : clenit === "stav_bytu" ? conditionLabel(r.e) ?? "bez hodnocení" : "celkem";
        const groups = new Map();
        for (const r of rows) {
          const k = keyOf(r);
          if (!groups.has(k)) groups.set(k, []);
          groups.get(k).push(r);
        }
        // Průměr ceny za m² při jiné slevě než základní: odhady (poslední cena −X %) jsou nejistější než ověřené
        // ceny, proto se k průměru přidává rozpětí. Ověřené ceny se nehýbou; bez odhadů se rozpětí vynechá.
        const spreadOf = (list) => {
          if (!list.some((r) => r.basis === "assumed" || r.basis === "pending")) return {};
          const base = entryDiscount(list[0].e);
          const range = discountRange(base);
          const avgAt = (discount) =>
            mean(
              list
                .map((r) => {
                  const { price } = effectivePriceForStats(r.e, discount);
                  return price != null && r.e.rep.area_m2 ? price / r.e.rep.area_m2 : null;
                })
                .filter((v) => v != null)
            );
          return {
            rozpetiPrumeruZaM2Kc: {
              slevaProcent: discountRangeLabel(base),
              priVyssiSleve: avgAt(range.max),
              zaklad: avgAt(base),
              priNizsiSleve: avgAt(range.min),
              poznamka: "Průměr ceny za m² při slevě o 5 procentních bodů víc a míň u odhadů; ověřené ceny se nemění.",
            },
          };
        };
        const describe = (key, list) => ({
          skupina: key,
          pocetBytu: list.length,
          cenaKc: summarize(list.map((r) => r.price)),
          cenaZaM2Kc: summarize(list.map((r) => r.perM2)),
          dnuVNabidce: summarize(list.map((r) => r.days)),
          ...(typ === "prodane" ? { zakladCeny: basisCounts(list), podleDokladu: evidenceCounts(list), ...spreadOf(list) } : {}),
          ...(list.length < SMALL_SAMPLE ? { poznamka: "malý vzorek" } : {}),
        });
        const skupiny = [...groups.entries()].sort((a, b) => (clenit === "mesic" ? (a[0] < b[0] ? -1 : 1) : b[1].length - a[1].length)).map(([k, list]) => describe(k, list));
        if (typ === "prodane") notes.push(...priceNotes(rows, "ceny", entryDiscount(rows[0]?.e)));
        else if (rows.length > 0 && rows.length < SMALL_SAMPLE) notes.push(`Malý vzorek (${bytu(rows.length)}).`);
        if (!rows.length) notes.push("Za zadaných podmínek není žádný byt s cenou.");
        return {
          typ,
          obdobi: { od, do: doDen },
          clenitPodle: clenit,
          celkem: describe("celkem", rows),
          slevaOdhadu: typ === "prodane" ? discountInfo(rows[0]?.e) : undefined,
          skupiny: clenit === "zadne" ? undefined : skupiny,
          upozorneni: notes,
        };
      },
    },
    {
      name: "nabidky",
      title: "Aktuální nabídky",
      description: "Aktuální nabídky bytů (v nabídce a rezervované) s možností filtrovat podle města, dispozice, ceny a plochy a řadit. Ceny jsou inzerované.",
      inputSchema: {
        type: "object",
        properties: {
          stav: { type: "string", enum: ["vse", "v_nabidce", "rezervovano"], description: "vse = v nabídce i rezervované (výchozí)." },
          mesto: { type: "string" },
          dispozice: { type: "string", description: "např. 2+1, 3+kk" },
          cena_od: { type: "number", description: "Minimální inzerovaná cena v Kč." },
          cena_do: { type: "number", description: "Maximální inzerovaná cena v Kč." },
          plocha_od: { type: "number", description: "Minimální plocha v m²." },
          plocha_do: { type: "number", description: "Maximální plocha v m²." },
          stav_bytu: { type: "string", enum: CONDITION_ENUM, description: CONDITION_HELP },
          razeni: { type: "string", enum: ["nejnovejsi", "cena_vzestupne", "cena_sestupne", "cena_za_m2"], description: "Výchozí nejnovejsi (podle toho, kdy se nabídka objevila)." },
          limit: { type: "integer", description: "Výchozí 30, nejvíc 200." },
        },
        additionalProperties: false,
      },
      handler(db, args) {
        const stav = parseEnum(args.stav, "stav", ["vse", "v_nabidce", "rezervovano"], "vse");
        const razeni = parseEnum(args.razeni, "razeni", ["nejnovejsi", "cena_vzestupne", "cena_sestupne", "cena_za_m2"], "nejnovejsi");
        const limit = parseLimit(args.limit, 30);
        const cenaOd = parseNumber(args.cena_od, "cena_od");
        const cenaDo = parseNumber(args.cena_do, "cena_do");
        const filters = { mesto: args.mesto, dispozice: args.dispozice, plochaOd: parseNumber(args.plocha_od, "plocha_od"), plochaDo: parseNumber(args.plocha_do, "plocha_do"), stavBytu: parseEnum(args.stav_bytu, "stav_bytu", CONDITION_ENUM, undefined) };
        const pool = entriesOf(db).filter((e) => {
          if (!(e.status === "active" || e.status === "reserved")) return false;
          if (stav === "v_nabidce" && e.status !== "active") return false;
          if (stav === "rezervovano" && e.status !== "reserved") return false;
          if (cenaOd != null && !(e.price >= cenaOd)) return false;
          if (cenaDo != null && !(e.price <= cenaDo)) return false;
          return matchesFilters(e, filters);
        });
        const sorters = {
          nejnovejsi: (a, b) => (Date.parse(b.discoveredAt) || 0) - (Date.parse(a.discoveredAt) || 0),
          cena_vzestupne: (a, b) => (a.price ?? Infinity) - (b.price ?? Infinity),
          cena_sestupne: (a, b) => (b.price ?? -Infinity) - (a.price ?? -Infinity),
          cena_za_m2: (a, b) => (a.pricePerM2 ?? Infinity) - (b.pricePerM2 ?? Infinity),
        };
        pool.sort(sorters[razeni]);
        const rows = pool.slice(0, limit).map((e) => ({
          ...baseRow(e, baseUrl),
          stav: e.status === "reserved" ? "rezervováno" : "v nabídce",
          cenaKc: e.price ?? null,
          cenaZaM2Kc: e.pricePerM2,
          objevenoDne: dayOf(e.discoveredAt),
          dnuVNabidce: e.daysOnMarket,
          pocetSnizeniCeny: e.priceDropCount,
          snizeniCenyCelkemKc: e.totalDiscountCzk,
        }));
        const notes = ["Ceny jsou INZEROVANÉ ceny (ne ceny, za které se byty prodají)."];
        if (pool.length > limit) notes.push(`Vráceno prvních ${limit} z ${pool.length}.`);
        return { pocetNalezenych: pool.length, souhrnCeny: summarize(pool.map((e) => e.price)), souhrnCenyZaM2: summarize(pool.map((e) => e.pricePerM2)), nabidky: rows, upozorneni: notes };
      },
    },
    {
      name: "zmeny_cen",
      title: "Změny cen",
      description: "Byty, u kterých se v daném období změnila inzerovaná cena (zlevnění i zdražení). Více změn jednoho bytu se spojí do jedné (nejstarší původní → nejnovější cena).",
      inputSchema: {
        type: "object",
        properties: {
          od: { type: "string", description: "Začátek období, RRRR-MM-DD. Výchozí: před 30 dny." },
          do: { type: "string", description: "Konec období, RRRR-MM-DD. Výchozí: dnes." },
          smer: { type: "string", enum: ["vse", "zlevneni", "zdrazeni"], description: "Výchozí vse." },
          limit: { type: "integer", description: "Výchozí 50, nejvíc 200." },
        },
        additionalProperties: false,
      },
      handler(db, args) {
        const doDen = parseDay(args.do, "do") ?? dayOf(new Date(now()).toISOString());
        const odDen = parseDay(args.od, "od") ?? dayOf(new Date(now() - 30 * DAY_MS).toISOString());
        if (odDen > doDen) throw new ToolInputError(`Začátek období (${odDen}) je později než konec (${doDen}).`);
        const smer = parseEnum(args.smer, "smer", ["vse", "zlevneni", "zdrazeni"], "vse");
        const limit = parseLimit(args.limit, 50);
        const entries = entriesOf(db);
        const entryOf = new Map();
        for (const e of entries) for (const m of e.g.members) entryOf.set(m.id, e);
        const events = db.prepare("SELECT listing_id, old_price_czk, new_price_czk, occurred_at FROM events WHERE event_type = 'price_change' ORDER BY occurred_at").all();
        const chains = new Map();
        for (const ev of events) {
          const e = entryOf.get(ev.listing_id);
          const day = dayOf(ev.occurred_at);
          if (!e || !day || day < odDen || day > doDen || ev.old_price_czk == null || ev.new_price_czk == null) continue;
          if (!chains.has(e)) chains.set(e, []);
          chains.get(e).push({ ...ev, day });
        }
        let rows = [...chains.entries()].map(([e, chain]) => {
          const oldPrice = chain[0].old_price_czk;
          const newPrice = chain[chain.length - 1].new_price_czk;
          return {
            ...baseRow(e, baseUrl),
            stav: e.status === "active" ? "v nabídce" : e.status === "reserved" ? "rezervováno" : e.status === "sold" ? "prodáno" : "zmizelo z nabídky",
            puvodniCenaKc: oldPrice,
            novaCenaKc: newPrice,
            zmenaKc: newPrice - oldPrice,
            zmenaProcent: Math.round(((newPrice - oldPrice) / oldPrice) * 1000) / 10,
            pocetZmen: chain.length,
            datumPosledniZmeny: chain[chain.length - 1].day,
          };
        });
        rows = rows.filter((r) => r.zmenaKc !== 0 && (smer === "vse" || (smer === "zlevneni" ? r.zmenaKc < 0 : r.zmenaKc > 0)));
        rows.sort((a, b) => (b.datumPosledniZmeny < a.datumPosledniZmeny ? -1 : b.datumPosledniZmeny > a.datumPosledniZmeny ? 1 : 0));
        const drops = rows.filter((r) => r.zmenaKc < 0);
        const notes = ["Jsou to inzerované ceny; zlevnění následované zdražením o stejnou částku se nezapočítává."];
        if (rows.length > limit) notes.push(`Vráceno prvních ${limit} z ${rows.length}.`);
        return {
          obdobi: { od: odDen, do: doDen },
          pocetBytu: rows.length,
          pocetZlevneni: drops.length,
          prumerneZlevneniProcent: drops.length ? Math.round((drops.reduce((s, r) => s + r.zmenaProcent, 0) / drops.length) * 10) / 10 : null,
          byty: rows.slice(0, limit),
          upozorneni: notes,
        };
      },
    },
    {
      name: "dohledatelnost_zmizelych",
      title: "Dohledatelnost zmizelých bytů",
      description:
        "Kolik bytů zmizelo z nabídky BEZ rezervace a u kolika z nich se dá v katastru zjistit, co se s nimi stalo. Zmizení bez rezervace nic neříká o prodeji (portály důvod neuvádějí), a v katastru jde byt hledat jen podle domu. Vrací rozdělení (hlídá API katastru / nejde ověřit — družstevní byt, novostavba / stažený balík — víc stejných bytů zmizelo týž den / adresa označena jako nedohledatelná / chybí adresa) a seznam bytů, které jdou zachránit doplněním adresy. Použij na otázky typu „proč nevíme, jestli se ty byty prodaly“.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      handler(db) {
        const trace = traceVanished(computeEntries(db).filter((e) => !e.hidden), { now: now() });
        const keys = { watched: "hlida_se_api_katastru", closed: "hlidani_skoncilo", unverifiable: "nejde_overit_v_katastru", bulk: "stazeny_balik", unknown: "adresa_nedohledatelna", noWatch: "dum_v_katastru_nenalezen", missing: "chybi_adresa" };
        return {
          zmizeloBezRezervace: trace.total,
          hlidaSe: trace.traceable,
          nejdeZPrincipuNeboNeniProdej: trace.untraceable,
          kZachraneDoplnenimAdresy: trace.actionable.length,
          rozdeleni: Object.entries(trace.counts).map(([key, pocet]) => ({ kategorie: keys[key], popis: TRACE_LABELS[key], pocet })),
          byty: trace.actionable.map((a) => ({
            id: a.id,
            odkaz: baseUrl ? `${baseUrl}/byt/${encodeURIComponent(a.id)}` : undefined,
            byt: a.label,
            adresa: a.address,
            zmizelPredDny: a.daysGone,
            proc: a.why,
          })),
          upozorneni: [
            "Zmizení z nabídky bez rezervace nemusí být prodej (stažení, vypršení inzerátu, pronájem). Portály důvod nesdělují, jistotu dá jen katastr.",
            "Katastr jde hledat jen podle domu, proto se hlídají jen byty s přesnou adresou. Družstevní byty a novostavby před dokončením se v katastru neověří vůbec.",
          ],
        };
      },
    },
    {
      name: "detail_bytu",
      title: "Detail bytu",
      description: "Podrobnosti o jednom bytu podle `id` (z ostatních nástrojů, např. „sreality:123456“): parametry, popis, časová osa (zaevidování, změny cen, rezervace, zmizení), stav prodeje a cena, údaje z katastru a vlastní poznámka. Přijme id kterékoli nabídky bytu (byt na více portálech je jedna položka).",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string", description: "Identifikátor nabídky, např. sreality:1294843980 nebo bazos:225285612." } },
        required: ["id"],
        additionalProperties: false,
      },
      handler(db, args) {
        if (typeof args.id !== "string" || !args.id.trim()) throw new ToolInputError("Chybí parametr „id“ (např. sreality:1294843980).");
        const id = args.id.trim();
        const entries = computeEntries(db);
        const e = entries.find((x) => x.g.members.some((m) => m.id === id));
        if (!e) throw new ToolInputError(`Byt s id „${id}“ jsem nenašel.`);
        const ids = e.g.members.map((m) => m.id);
        const placeholders = ids.map(() => "?").join(",");
        const events = db.prepare(`SELECT listing_id, event_type, old_price_czk, new_price_czk, occurred_at FROM events WHERE listing_id IN (${placeholders}) ORDER BY occurred_at`).all(...ids);
        const sourceOf = new Map(e.g.members.map((m) => [m.id, SOURCE_NAMES[m.source] ?? m.source]));
        const sold = isSoldOrAlmost(e);
        const description = (e.rep.description ?? "").replace(/\s+/g, " ").trim();
        return {
          ...baseRow(e, baseUrl),
          skryty: e.hidden,
          stav: e.status === "active" ? "v nabídce" : e.status === "reserved" ? "rezervováno" : e.status === "sold" ? "prodáno (podle portálu)" : "zmizelo z nabídky",
          aktualniInzerovanaCenaKc: e.price ?? null,
          cenaZaM2Kc: e.pricePerM2,
          zaevidovanoDne: dayOf(e.discoveredAt),
          vNabidceOdDne: dayOf(e.firstSeenAt),
          zmizeloDne: dayOf(e.removedAt),
          dnuVNabidce: e.daysOnMarket,
          pocetSnizeniCeny: e.priceDropCount,
          snizeniCenyCelkemKc: e.totalDiscountCzk,
          prodej: sold ? pickSale(saleRow(e, baseUrl)) : null,
          katastr: {
            verdikt: e.saleVerdict ?? null,
            vkladPodanDne: dayOf(e.knFiledAt),
            cisloLV: e.lvNumber ?? null,
            jednotka: e.knAutoUnit ?? null,
            overenaKupniCenaKc: e.verifiedSalePrice ?? null,
            datumProdejeZKatastru: dayOf(e.verifiedSaleDate),
          },
          parametry: labeledParams(e.params),
          vlastniHodnoceni: ownRatings(e),
          poznamka: e.notes ?? null,
          popis: description.length > 1500 ? `${description.slice(0, 1500)}…` : description || null,
          nabidky: e.g.members.map((m) => ({ id: m.id, portal: SOURCE_NAMES[m.source] ?? m.source, stav: m.status, url: m.url, cenaKc: m.price_czk ?? null })),
          casovaOsa: events.map((ev) => ({
            datum: dayOf(ev.occurred_at),
            udalost: EVENT_NAMES[ev.event_type] ?? ev.event_type,
            portal: sourceOf.get(ev.listing_id),
            ...(ev.event_type === "price_change" || ev.old_price_czk != null || ev.new_price_czk != null ? { puvodniCenaKc: ev.old_price_czk, novaCenaKc: ev.new_price_czk } : {}),
          })),
          upozorneni: sold ? [SALE_DEFINITIONS] : [],
        };
      },
    },
  ];
}

/** Z řádku prodeje jen údaje o prodeji (zbytek je v detailu bytu zvlášť). */
function pickSale(row) {
  const { stav, doklad, vKatastruPodanVklad, datumProdeje, datumProdejeZdroj, posledniInzerovanaCenaKc, cenaProdejeKc, cenaProdejeZaklad, cenaZaM2Kc } = row;
  return { stav, doklad, vKatastruPodanVklad, datumProdeje, datumProdejeZdroj, posledniInzerovanaCenaKc, cenaProdejeKc, cenaProdejeZaklad, cenaZaM2Kc };
}
