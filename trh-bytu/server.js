// Lokální prohlížecí appka — holý Node `http` server, žádná nová
// závislost (drží se filozofie repa). Server-rendered HTML, žádný build
// krok, žádný klientský framework. Spouští se ručně (`npm run sales-app`),
// na rozdíl od track.js NEBĚŽÍ na pozadí.

import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, DATA_DIR, updateListingFields, nowIso } from "./db.js";
import { groupListings, primaryListing, mergedStatus, earliestListedAt, latestRemovedAt, priceDropSummary, findGroupForListing, pickDescription, mergeParams, mergePortalParams, bestAddress, bestPrice, bestPriceListing, byPriority, latestChange, isStarred, isHidden, pickOwnValue, saleVerdict } from "./group.js";
import { assessSale, isProbableSale, SALE_LEVEL_LABELS } from "./sale-triage.js";
import { buildAddressContext, resolveForGroup, describeEvidence, applyAutoAddresses, knInfoForGroup, describeKn } from "./auto-address.js";
import { ruianLookupAddress, parseExactAddress, addressKey, saveRuian } from "./ruian.js";
import { buildSaleTrack, filingLagDays, median } from "./kn-schedule.js";
import { loadKnScans, createWatchResolver, refreshKnScans, UNRESERVED_HORIZON_DAYS } from "./kn-scan.js";
import { analyzePlombas, formatDay as formatKnDay } from "./kn-plomba.js";
import { parseUnitNumber, formatUnitNumber } from "./kn-api.js";
import { buildSaleRecordUpdates, currentSaleState, statsSalePrice, assumedSalePrice, isAlmostSold, saleEvidence, ASSUMED_PRICE_DISCOUNT } from "./sale-record.js";
import { PARAM_FIELDS, OWN_FIELDS, PARAM_OVERRIDE_FIELDS } from "./params.js";
import { extractCity, parsePriceNote } from "./parse.js";
import { calculateFlip, DEFAULT_FLIP_INPUTS } from "./flip-calculator.js";
import { getNotifications, getNotificationsSeenAt, markNotificationsSeen, countUnread } from "./notifications.js";
import { watches } from "../config.js";

// KN_API_KEY (a Telegram kvůli zprávě o nalezeném vkladu) z `.env.local` v
// kořeni repa, stejně jako v track.js. Server je potřebuje jen kvůli kontrole
// domu hned po zapsání adresy; bez souboru se ta kontrola přeskočí.
try {
  process.loadEnvFile(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".env.local"));
} catch {
  // Bez .env.local appka běží, jen nekontroluje plomby přes API.
}

// Kontrola domů přes API katastru (kn-scan.js), kterou nespouští denní sběr,
// ale uložení adresy: byt s čerstvě doplněnou adresou by jinak do příštího
// sběru visel v "Zkontrolovat teď", protože jeho dům ještě nikdo neprošel.
// Naráz běží nejvýš jedna (dvě souběžné by prošly tentýž dům podruhé).
let knRefreshRunning = null;
function refreshKnScansNow(db) {
  if (!knRefreshRunning) {
    knRefreshRunning = refreshKnScans(db, (line) => console.log(line))
      .then((line) => line && console.log(line))
      .catch((err) => console.log(`KN API: ${err.message}`))
      .finally(() => {
        knRefreshRunning = null;
      });
  }
  return knRefreshRunning;
}

const BYTY_WATCH = watches.find((w) => w.key === "byty");

const PORT = 4321;
const SOURCE_LABELS = {
  sreality: "Sreality.cz",
  bezrealitky: "Bezrealitky.cz",
  idnes: "Reality.iDNES.cz",
  realitymix: "RealityMIX.cz",
  bazos: "Bazoš.cz",
};
const STATUS_LABELS = {
  active: { text: "V nabídce", color: "#2563eb" },
  reserved: { text: "Rezervováno", color: "#d97706" },
  sold: { text: "Prodáno", color: "#16a34a" },
  // Odvozený štítek (ne stav v DB) — zmizelo po rezervaci, viz isPossibleSale.
  possible: { text: "Možný prodej", color: "#0f766e" },
  // Totéž po PROBABLE_SALE_AFTER_DAYS dnech bez návratu (sale-triage.js).
  probable: { text: "Pravděpodobně prodáno", color: "#15803d" },
  removed: { text: "Zmizelo z nabídky", color: "#6b7280" },
};
// Stav ručně zapsané přesné adresy bytu (viz db.js exact_address): `known`
// = vyplněná adresa nebo jednotka, `unknown` = uživatel nabídku prošel a
// adresu nezjistil, `missing` = ještě nikdo nekoukal (ty se hlídají filtrem
// "Bez adresy"). Čte se přes celou skupinu — adresa zapsaná na jednom
// portálu platí pro byt.
function addressInfo(members) {
  const exact = pickOwnValue(members, "exact_address");
  const unit = pickOwnValue(members, "unit_number");
  const unknown = members.some((m) => m.address_unknown);
  return {
    exact,
    unit,
    state: exact || unit ? "known" : unknown ? "unknown" : "missing",
    // Adresu doplnila appka sama z polohy (viz auto-address.js), ne uživatel.
    auto: Boolean(exact) && members.some((m) => m.address_auto === 1),
    // Uživatel automatickou adresu smazal — automat ji znovu nedoplňuje.
    autoOff: members.some((m) => m.address_auto === -1),
  };
}

// Zmizelý byt, který byl před zmizením rezervovaný, a nikdo zatím nezjistil,
// jak to dopadlo: po rezervaci se nabídka typicky stahuje, takže je to
// "možný prodej" (a ne jen "zmizelo"). Když se nabídka vrátí, byt přestane
// být zmizelý a štítek zmizí sám. Pro filtr "Možný prodej" i štítek.
function isPossibleSale(e) {
  return e.status === "removed" && !e.saleVerdict && Boolean(e.triage?.wasReserved);
}

// Pořadí a hodnoty stavových filtrů v přehledu i v srovnávací tabulce.
const STATUS_FILTERS = ["", "active", "reserved", "possible", "sold", "removed"];

// "Možný prodej" není stav v DB, ale podmnožina zmizelých — "Zmizelo z
// nabídky" proto zůstává filtrem všech zmizelých (i těch možných prodejů),
// jinak by byt po rezervaci z přehledu úplně zmizel.
// Filtr "Prodáno" ukazuje všechno, co je prodané určitě (katastr, portál) i
// téměř jistě (po rezervaci zmizelé) — to, o co v appce hlavně jde. Řádky se
// liší štítkem ("Prodáno" / "Možný prodej" / "Pravděpodobně prodáno") a údajem
// o ceně prodeje, viz saleInfoLine.
function isSoldOrAlmost(e) {
  return e.status === "sold" || isPossibleSale(e);
}

function matchesStatusFilter(e, filter) {
  if (filter === "possible") return isPossibleSale(e);
  if (filter === "sold") return isSoldOrAlmost(e);
  return e.status === filter;
}

// Popisek stavového filtru ("Prodáno" je širší než stav sold, viz výš).
function statusFilterLabel(s) {
  if (!s) return "Vše";
  return s === "sold" ? "Prodáno (i téměř jistě)" : STATUS_LABELS[s].text;
}

// Co víme o ceně prodeje bytu: kolik, odkud ta cena je a jak je to s vkladem.
// Jen pro prodané a téměř jistě prodané byty (jinak null).
function saleInfoLine(e) {
  if (!isSoldOrAlmost(e)) return null;
  const { price, basis } = effectivePriceForStats(e);
  const parts = [];
  if (price == null) parts.push("cena neznámá");
  else if (basis === "verified") parts.push(`${formatCzk(price)} (ověřeno)`);
  else
    parts.push(
      `~${formatCzk(price)} (odhad −${Math.round(ASSUMED_PRICE_DISCOUNT * 100)} %, ${basis === "assumed" ? "nejde ověřit" : "čeká na ověření"})`
    );
  if (e.knFiledAt) parts.push(`vklad podán ${formatDateOnly(e.knFiledAt)}`);
  if (e.plombaEnd) parts.push(`plomba ${Date.parse(e.plombaEnd) <= Date.now() ? "skončila" : "do"} ${formatDateOnly(e.plombaEnd)}`);
  return parts.join(" · ");
}

// Štítek s PŘESNOU adresou (viz addressInfo) — v přehledu i v tabulce
// srovnání: zapsaná (nebo appkou určená) se ukáže, nevyplněná u nabídky,
// která ještě má šanci, upozorní, "neznámá" jen připomene, že se na ni už
// koukalo. U zmizelých bytů bez adresy se nic neukazuje — doplnit už ji nejde
// (řeší fronta /kontrola). S `href` je štítek odkaz (v tabulce vede k
// formuláři adresy v detailu), jinak obyčejný text.
function addressChipHtml(ai, status, href = null) {
  const chip = (cls, text, title = null) => {
    const attrs = ` class="${cls}"${title ? ` title="${esc(title)}"` : ""}`;
    return href ? `<a href="${href}"${attrs}>${text}</a>` : `<span${attrs}>${text}</span>`;
  };
  if (ai.state === "known") {
    const text = `📍 ${esc([ai.exact, ai.unit ? `jednotka ${ai.unit}` : null].filter(Boolean).join(", "))}${ai.auto ? " (auto)" : ""}`;
    return chip(`addr-chip${ai.auto ? " addr-chip--auto" : ""}`, text, ai.auto ? "Adresu doplnila appka sama z polohy v inzerátu — ověř ji a doplň jednotku" : null);
  }
  if (ai.state === "unknown") return chip("addr-chip addr-chip--unknown", "📍 adresa neznámá");
  if (status === "active" || status === "reserved") return chip("addr-chip addr-chip--missing", "📍 doplnit adresu");
  return "";
}

// Štítek stavu bytu. Zmizelý byt, u kterého uživatel v katastru ověřil, že
// se neprodal, se nesmí tvářit jako obyčejně "zmizelo" (to je pořád ta
// nezodpovězená otázka, kvůli které fronta existuje) — a zmizelý po
// rezervaci je "možný prodej", viz isPossibleSale. `triage` je odhad z
// sale-triage.js (jen u zmizelých).
function statusLabelFor(status, verdict, triage) {
  if (status === "removed" && verdict === "withdrawn") return { text: "Staženo (neprodáno)", color: STATUS_LABELS.removed.color };
  if (status === "removed" && !verdict && triage?.wasReserved) return isProbableSale(triage) ? STATUS_LABELS.probable : STATUS_LABELS.possible;
  return STATUS_LABELS[status] || { text: status, color: "#000" };
}
const EVENT_LABELS = {
  created: "Zaevidováno",
  price_change: "Změna ceny",
  reserved: "Označeno jako rezervováno",
  unreserved: "Rezervace zrušena",
  sold: "Prodáno",
  removed: "Zmizelo z nabídky",
  reactivated: "Znovu v nabídce",
  relisted: "Inzerát znovu vložen pod novým ID",
};

// Pro řádek v přehledu se z plné sady parametrů (viz params.js) skládá
// jen kompaktní shrnutí — popisné hodnoty (vlastnictví, stav, typ budovy,
// podlaží, energ. třída) rovnou, ano/ne vybavení (balkón, sklep...) jen
// když je "Ano" (ne "Balkón: Ne" — to jen zabírá místo bez užitku).
const PARAM_LABEL_BY_KEY = Object.fromEntries(PARAM_FIELDS);
const AMENITY_KEYS = ["balcony", "loggia", "terrace", "cellar", "parking", "garage"];
const DESCRIPTIVE_KEYS = ["ownership", "condition", "buildingType", "floorInfo", "energyRating"];

// Vlastní hodnocení uživatele (viz OWN_FIELDS v params.js) — jen sloupce
// dovolené v `POST /byt/:id/own/:field` a popisek uložené hodnoty.
const OWN_FIELD_BY_COLUMN = Object.fromEntries(OWN_FIELDS.map((f) => [f.column, f]));
function ownValueLabel(column, value) {
  if (!value) return null;
  return OWN_FIELD_BY_COLUMN[column]?.options.find(([v]) => v === value)?.[1] ?? null;
}

function formatPricePerM2(pricePerM2) {
  return pricePerM2 == null ? "—" : `${pricePerM2.toLocaleString("cs-CZ")} Kč/m²`;
}

// Skloňování "den/dny/dní" — 1 den, 2-4 dny, 0 a 5+ dní.
function daysWord(n) {
  return n === 1 ? "den" : n >= 2 && n <= 4 ? "dny" : "dní";
}

// "45 dní" u živé/rezervované nabídky, "67 dní (staženo 12. 8. 2026)" u
// zmizelé — obojí odpovídá na stejnou otázku "jak dlouho už to leží", jen s
// jiným koncovým bodem (dnešek, vs. datum zmizení).
function daysOnMarketLabel(e) {
  const base = `${e.daysOnMarket} ${daysWord(e.daysOnMarket)}`;
  if (!e.removedAt) return base;
  if (e.status === "removed") return `${base} (staženo ${formatDateOnly(e.removedAt)})`;
  if (e.status === "sold") return `${base} (prodáno ${formatDateOnly(e.removedAt)})`;
  return base;
}

// "2× (−450 000 Kč)" — kolikrát cena SKUTEČNĚ klesla a o kolik celkem od
// prvně zaznamenané ceny. "—" když appka žádnou slevu nezaznamenala (ať už
// proto, že k ní nedošlo, nebo appka byt zaevidovala až po ní).
function priceDropLabel(e) {
  if (!e.priceDropCount) return "—";
  const amount = e.totalDiscountCzk ? ` (−${formatCzk(e.totalDiscountCzk)})` : "";
  return `${e.priceDropCount}×${amount}`;
}

// <select> pro jedno vlastní hodnocení (viz OWN_FIELDS) — sdílené mezi
// detailem (jeden formulář, tlačítko Uložit) a tabulkou srovnání (auto-submit
// při změně, viz .own-select-form v CSS). Prázdná volba "—" vždy první, ať
// jde hodnocení i vymazat, ne jen nastavit.
function ownFieldSelectHtml(column, currentValue, { autoSubmit = false } = {}) {
  const field = OWN_FIELD_BY_COLUMN[column];
  const opts = [`<option value="">—</option>`]
    .concat(field.options.map(([v, label]) => `<option value="${esc(v)}" ${currentValue === v ? "selected" : ""}>${esc(label)}</option>`))
    .join("");
  // `requestSubmit()`, NE `submit()` — `submit()` obchází submit event úplně
  // (WHATWG spec), takže by ho klientský JS (viz app.js) nikdy nezachytil a
  // skončilo by to normální navigací se skokem nahoru stránky.
  const onChange = autoSubmit ? ` onchange="this.form.requestSubmit()"` : "";
  return `<select name="${column}"${onChange}>${opts}</select>`;
}

const PARAM_OVERRIDE_FIELD_BY_COLUMN = Object.fromEntries(PARAM_OVERRIDE_FIELDS.map((f) => [f.column, f]));

// Vstup pro jedno ruční doplnění PARAM_FIELDS (viz PARAM_OVERRIDE_FIELDS)
// — text nebo <select>, podle `field.type`. `currentValue` je efektivní
// (sloučená, viz mergeParams) hodnota, ne jen override — pole tak ukazuje,
// co appka aktuálně zobrazuje, ať už to vytěžila z portálu, z textu, nebo
// to sem dřív ručně dopsal uživatel; needituje se přímo `params_json`, jen
// `params_override_json`, který má vždy přednost (viz POST /params).
function paramOverrideFieldHtml(column, currentValue, { autoSubmit = false } = {}) {
  const field = PARAM_OVERRIDE_FIELD_BY_COLUMN[column];
  const onChange = autoSubmit ? ` onchange="this.form.requestSubmit()"` : "";
  if (field.type === "select") {
    // Hodnota z portálu/textu se s nabídkou porovnává bez ohledu na velikost
    // písmen a hodnota MIMO nabídku (např. "Státní" u vlastnictví) se přidá
    // jako vlastní volba — jinak by pole vypadalo prázdné ("—"), ačkoli ho
    // appka zná, a další dotyk by hodnotu tiše přepsal.
    const wanted = currentValue == null ? "" : String(currentValue).toLocaleLowerCase("cs");
    const matched = wanted ? field.options.find(([v]) => v.toLocaleLowerCase("cs") === wanted) : null;
    const opts = [`<option value="">—</option>`]
      .concat(field.options.map(([v, label]) => `<option value="${esc(v)}" ${matched?.[0] === v ? "selected" : ""}>${esc(label)}</option>`))
      .concat(wanted && !matched ? [`<option value="${esc(currentValue)}" selected>${esc(currentValue)}</option>`] : [])
      .join("");
    return `<select name="${column}"${onChange}>${opts}</select>`;
  }
  return `<input type="text" name="${column}" value="${esc(currentValue)}" placeholder="—"${onChange}>`;
}

function esc(s) {
  if (s == null) return "";
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function formatCzk(n) {
  return n == null ? "—" : `${n.toLocaleString("cs-CZ")} Kč`;
}

function formatDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("cs-CZ", { day: "numeric", month: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function formatDateOnly(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("cs-CZ", { day: "numeric", month: "numeric", year: "numeric" });
}

// "V nabídce od" + "Poslední změna" jako dva samostatné odznaky, ne
// splývající text — uživatel je chtěl na první pohled odlišitelné od
// zbytku řádku. "Poslední změna" NIKDY z portálového "naposledy
// upraveno" (to si RK bumpují bez reálné změny), vždy z vlastní historie
// appky (viz group.js latestChange). Odznak beze změny je schválně
// tlumený/šedý — barevně (žlutě) vystupuje jen odznak, kde SE něco
// opravdu stalo, ať se dá v přehledu rychle zrakem najít, co je "živé".
function updatesChips(firstSeenAt, change, sources) {
  const since = `<span class="update-chip update-chip--since">📅 V nabídce od ${esc(formatDateOnly(firstSeenAt))}</span>`;
  const detail = change ? eventDetail(change) : "";
  // U bytu na víc portálech je důležité, KDE se změna stala — "zmizelo z
  // nabídky" na dvou portálech ze čtyř není totéž co zmizení z trhu.
  const where = sources ? ` (${esc(sources)})` : "";
  const changeChip = change
    ? `<span class="update-chip update-chip--change">🔄 Poslední změna ${esc(formatDateOnly(change.occurred_at))} · ${esc(EVENT_LABELS[change.event_type] || change.event_type)}${where}${detail ? ` · ${esc(detail)}` : ""}</span>`
    : `<span class="update-chip update-chip--none">Zatím beze změny</span>`;
  return `${since}${changeChip}`;
}

// Portály, u kterých proběhla poslední změna skupiny — jen když skupina
// spojuje víc portálů (jinak by to byla zbytečná informace navíc). Bere
// všechny události téhož typu z téhož sběrného běhu (do 10 minut od
// poslední), protože jeden běh často zaznamená zmizení na víc portálech
// naráz. `events` = události všech členů skupiny.
function changeSources(members, events, change) {
  if (!change || new Set(members.map((m) => m.source)).size < 2) return null;
  const sourceById = new Map(members.map((m) => [m.id, m.source]));
  const changeTime = new Date(change.occurred_at).getTime();
  const sources = new Set();
  for (const e of events) {
    if (e.event_type !== change.event_type) continue;
    if (Math.abs(new Date(e.occurred_at).getTime() - changeTime) > 10 * 60 * 1000) continue;
    const source = sourceById.get(e.listing_id);
    if (source) sources.add(SOURCE_LABELS[source] || source);
  }
  return sources.size ? [...sources].join(" + ") : null;
}

// "Cena na vyžádání" je u portálů cena bez čísla (Dohodou, V textu...) —
// v události ji appka drží jako null, tady se jen pojmenuje.
function priceText(price) {
  return price == null ? "na vyžádání" : formatCzk(price);
}

// Doplňující údaj k události (kolik se změnilo) — sdílí ho časová osa v
// detailu i odznak "Poslední změna" v přehledu, ať oba říkají totéž.
function eventDetail(e) {
  if (e.event_type === "price_change") return `${formatCzk(e.old_price_czk)} → ${formatCzk(e.new_price_czk)}`;
  if (e.event_type === "sold" && e.new_price_czk != null) return `prodejní cena ${formatCzk(e.new_price_czk)}`;
  if (e.event_type === "relisted" && e.old_price_czk !== e.new_price_czk) {
    return `cena ${priceText(e.old_price_czk)} → ${priceText(e.new_price_czk)}`;
  }
  return "";
}

// Tlačítka TOP (hvězdička) / Skrýt (křížek) — sdílené mezi řádkem přehledu
// a detailem. Každé je vlastní POST formulář (žádný klientský JS potřeba
// pro toggle) — a v řádku je vědomě SOUROZENEC obalujícího odkazu na
// detail (`.row-link`), ne jeho potomek: `<button>` uvnitř `<a>` je
// neplatné HTML a klik by bublal i na navigaci na detail.
function rowActionButtons(id, starred, hidden) {
  const encId = encodeURIComponent(id);
  const starBtn = `<form method="post" action="/byt/${encId}/star" class="row-action-form"><button type="submit" class="icon-btn${starred ? " icon-btn--active" : ""}" title="${starred ? "Odebrat z TOP" : "Označit jako TOP"}">${starred ? "⭐" : "☆"}</button></form>`;
  const hideBtn = hidden
    ? `<form method="post" action="/byt/${encId}/hide" class="row-action-form"><button type="submit" class="icon-btn" title="Vrátit do přehledu">↺</button></form>`
    : `<form method="post" action="/byt/${encId}/hide" class="row-action-form"><button type="submit" class="icon-btn" title="Skrýt z přehledu">✕</button></form>`;
  return `${starBtn}${hideBtn}`;
}

function layout(title, body, { wide = false } = {}) {
  // Zvoneček: počet nepřečtených upozornění — rezervace, změny cen, nové
  // nabídky (viz notifications.js).
  const unread = countUnread(getNotifications(db), getNotificationsSeenAt(db));
  const bell = `<a href="/upozorneni" class="bell" title="${unread ? `Nepřečtená upozornění: ${unread}` : "Upozornění (rezervace, změny cen, nové nabídky)"}">🔔${unread ? `<span class="bell-badge">${unread}</span>` : ""}</a>`;
  // Srovnávací tabulka má hodně sloupců a potřebuje co nejvíc vodorovného
  // místa — na rozdíl od ostatních stránek (karty, detail), kterým sedí
  // úzký čitelný sloupec uprostřed, viz main.wide v CSS.
  return `<!doctype html>
<html lang="cs">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="stylesheet" href="/style.css">
<script src="/app.js" defer></script>
</head>
<body>
<header><a href="/" class="brand">🏠 Trh bytů</a> <a href="/tabulka">🗂️ Srovnání</a> <a href="/stats">Statistiky</a> <a href="/kontrola">🏛️ Katastr</a>${bell}</header>
<main${wide ? ' class="wide"' : ""}>${body}</main>
</body>
</html>`;
}

// Titulek řádku — "Byt 2+1, 55 m², Letohrad, ul. U dvora — 3 750 000 Kč".
// Adresa (viz group.js bestAddress) je u většiny portálů už "ulice, město"
// (nebo jen "město", když ulici portál/appka nezná — fail-soft, žádná
// nabídka kvůli chybějící adrese nezmizí, jen bude titulek o kousek kratší.
function cardTitle(rep, address, priceLabelText) {
  const specs = [rep.disposition, rep.area_m2 ? `${rep.area_m2} m²` : null].filter(Boolean).join(", ");
  const head = specs ? `Byt ${specs}` : "Byt";
  const addressPart = address ? `, ${address}` : "";
  return `${head}${addressPart} — ${priceLabelText}`;
}

// Cena skupiny slovy pro titulek a detail. Cena bez čísla je věc portálů
// (RK ji neuvádí), ne chybějící údaj — proto se píše výslovně ("cena na
// vyžádání", u Bazoše i jeho vlastními slovy: Dohodou / Nabídněte / V
// textu), ne jako pomlčka, která vypadá jako chyba appky. Cena vyčtená z
// popisu se značí, protože text bývá zastaralý (RK cenu u inzerátu sníží a
// v textu nechá původní).
function priceLabel(members) {
  const listing = bestPriceListing(members);
  if (listing) return formatCzk(listing.price_czk) + (listing.price_from_text ? " (z textu inzerátu)" : "");
  const notes = [...new Set(members.map((m) => parsePriceNote(m.title)).filter(Boolean))];
  return `cena na vyžádání${notes.length ? ` (${notes.join(", ")})` : ""}`;
}

// Portály seskupené podle toho, jestli tam byt ještě je: "Sreality.cz +
// Reality.iDNES.cz" a zvlášť "zmizelo: Bazoš.cz + RealityMIX.cz". Portál
// se počítá jako aktivní, když je aktivní aspoň jeden jeho inzerát (znovu
// vložený inzerát má staré ID zmizelé a nové aktivní).
function sourcesByAvailability(members) {
  const active = new Map();
  const reservedSources = new Set();
  for (const m of byPriority(members)) {
    active.set(m.source, (active.get(m.source) || false) || m.status !== "removed");
    if (m.status === "reserved") reservedSources.add(m.source);
  }
  const label = (source) => SOURCE_LABELS[source] || source;
  return {
    live: [...active].filter(([, isActive]) => isActive).map(([source]) => label(source)),
    gone: [...active].filter(([, isActive]) => !isActive).map(([source]) => label(source)),
    reserved: [...reservedSources].map(label),
  };
}

// Kompaktní shrnutí parametrů pro řádek přehledu — plná tabulka se všemi
// popisky je až v detailu (viz PARAM_FIELDS tam), tady jde jen o rychlou
// orientaci na první pohled.
function paramsSummaryLine(params) {
  const bits = DESCRIPTIVE_KEYS.filter((k) => params[k] != null).map((k) =>
    k === "energyRating" ? `Energ. tř. ${params[k]}` : params[k]
  );
  const amenities = AMENITY_KEYS.filter((k) => params[k]?.startsWith("Ano")).map((k) => PARAM_LABEL_BY_KEY[k]);
  if (amenities.length) bits.push(amenities.join(", "));
  return bits.join(" · ");
}

function truncate(text, maxLen) {
  if (!text || text.length <= maxLen) return text || "";
  const cut = text.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(" ");
  return `${cut.slice(0, lastSpace > 40 ? lastSpace : maxLen)}…`;
}

// Sestaví "/?..." se stávajícími filtry + přepsáním jen zadaných klíčů —
// každý filtrovací/řadicí odkaz tak zachová VŠECHNY ostatní aktivní
// filtry (klik na "Cena ↑" nesmí zapomenout zvolené město atd.).
// `base` = stránka, na kterou odkaz vede ("/" přehled, "/tabulka" srovnání) —
// bez toho odkazy ve filtrech tabulky srovnání vedly na přehled.
function buildQuery(current, overrides, base = "/") {
  const merged = { ...current, ...overrides };
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(merged)) {
    if (v) params.set(k, v);
  }
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

// Výchozí řazení ve čtyřech skupinách za sebou:
//   1. novinka + TOP  2. novinka  3. TOP  4. ostatní
// "Novinka" = byt, u kterého se v posledních FRESH_LISTING_DAYS dnech něco
// stalo: appka ho objevila, nebo u něj zaznamenala skutečnou změnu (viz
// group.js latestChange) — obojí shrnuje entry.activityAt (novější z obou).
// Uvnitř skupiny se řadí právě podle `activityAt`. Tohle pořadí platí jen
// pro "newest" (výchozí) řazení; u řazení podle ceny by míchání
// novinek/TOP dovnitř popřelo smysl "seřaď čistě podle ceny", který si
// uživatel explicitně zvolil.
//
// Stáří MUSÍ rozhodovat i u změny. Dřív stačilo, že byt KDYKOLIV měl nějakou
// změnu, a TOP byty s třeba tři týdny starou změnou tak zůstávaly napořád
// nahoře, zatímco čerstvě objevené byty ležely pod nimi (reálně zažito: nový
// byt z dnešního rána až na 9. místě pod sedmi staršími TOP byty).
// Čerstvě přidaný inzerát má navíc jen událost "created", kterou
// latestChange záměrně nepočítá (není to změna, je to začátek historie),
// proto se bere i čas objevení.
const FRESH_LISTING_DAYS = 7;
function hasRecentNews(e) {
  return Date.now() - new Date(e.activityAt).getTime() < FRESH_LISTING_DAYS * 24 * 60 * 60 * 1000;
}
function defaultSortGroup(e) {
  return (hasRecentNews(e) ? 0 : 2) + (e.starred ? 0 : 1);
}
const SORTERS = {
  newest: (a, b) => {
    const groupDiff = defaultSortGroup(a) - defaultSortGroup(b);
    if (groupDiff !== 0) return groupDiff;
    return a.activityAt < b.activityAt ? 1 : a.activityAt > b.activityAt ? -1 : 0;
  },
  price_asc: (a, b) => (a.price ?? Infinity) - (b.price ?? Infinity),
  price_desc: (a, b) => (b.price ?? -Infinity) - (a.price ?? -Infinity),
};
const SORT_LABELS = [
  ["newest", "Nejnovější"],
  ["price_asc", "Cena ↑"],
  ["price_desc", "Cena ↓"],
];

// Odvozené údaje spočítané JEDNOU za skupinu, sdílené mezi přehledem
// (renderTable) a srovnávací tabulkou (renderComparisonTable) — obě jen
// čtou, žádné opakované JSON.parse/reduce nad stejnou skupinou vícekrát na
// dvou různých stránkách.
function computeEntries(db) {
  const allListings = db.prepare("SELECT * FROM listings").all();
  // Skupiny (ne syrové řádky) — stejná nemovitost napříč portály se ukáže
  // jen jednou, viz group.js.
  const allGroups = groupListings(allListings);
  // Kde plomby hlídá API katastru (kn-scan.js), ruční kontrola podle rozvrhu
  // se nepřipomíná — bez skenů (bez klíče) vrací null a rozvrh platí celý.
  const watchFor = createWatchResolver(db, allListings, allGroups);

  // Jedna náhledová fotka na inzerát (ta s nejnižším id = první stažená),
  // jedním dotazem pro všechny skupiny najednou — ne N samostatných.
  const firstPhotoByListing = new Map(
    db
      .prepare(`SELECT listing_id, local_path FROM photos WHERE id IN (SELECT MIN(id) FROM photos GROUP BY listing_id)`)
      .all()
      .map((r) => [r.listing_id, r.local_path])
  );
  function groupThumbnail(members) {
    for (const m of members) {
      const p = firstPhotoByListing.get(m.id);
      if (p) return p;
    }
    return null;
  }

  // Všechny eventy jedním dotazem, seskupené podle inzerátu — latestChange
  // (group.js) si z nich pro danou skupinu vybere nejnovější SKUTEČNOU
  // změnu (viz komentář tam, proč ne portálové "naposledy upraveno").
  const eventsByListing = new Map();
  for (const e of db.prepare("SELECT listing_id, event_type, old_price_czk, new_price_czk, occurred_at FROM events").all()) {
    if (!eventsByListing.has(e.listing_id)) eventsByListing.set(e.listing_id, []);
    eventsByListing.get(e.listing_id).push(e);
  }
  function groupEvents(members) {
    return members.flatMap((m) => eventsByListing.get(m.id) || []);
  }

  const entries = allGroups.map((g) => {
    // "Přidáno" ukazuje NEJSTARŠÍ ZNÁMÉ datum (portálovo vlastní "Vloženo",
    // viz earliestListedAt v group.js) — appka nemá jak potvrdit den
    // přesně, ale je to výrazně blíž realitě než kdy si toho appka poprvé
    // všimla, hlavně u bytů zaevidovaných dávno po jejich zveřejnění.
    const firstSeenAt = earliestListedAt(g.members);
    const events = groupEvents(g.members);
    const change = latestChange(events);
    const rep = primaryListing(g.members);
    // Kdy appka byt (kteroukoli jeho nabídku) poprvé zaevidovala — na rozdíl
    // od `firstSeenAt` výš (datum zveřejnění podle portálu, může být týdny
    // staré u bytu, který appka objevila až dnes) je to okamžik, kdy se
    // byt stal novinkou PRO UŽIVATELE, tedy to, podle čeho řadit "Nejnovější".
    const discoveredAt = g.members.reduce((min, m) => (m.first_seen_at < min ? m.first_seen_at : min), g.members[0].first_seen_at);
    const price = bestPrice(g.members);
    const status = mergedStatus(g.members);
    const removedAt = status === "removed" || status === "sold" ? latestRemovedAt(g.members) : null;
    const { dropCount, originalPrice } = priceDropSummary(events);
    const verdict = saleVerdict(g.members);
    // Fáze prodeje po rezervaci a rozvrh kontrol v katastru (kn-schedule.js);
    // `null`, když byt nemá platnou rezervaci nebo je pořád v nabídce.
    const track = buildSaleTrack(g.members, events, Date.now(), watchFor(g));
    // Zmizelý byt BEZ rezervace hlídá API katastru stejně jako rezervované
    // (kn-scan.js, unreservedTrack): místo začátku rezervace se bere zmizení
    // inzerátu. `needsConfirm` = po zmizení se objevila plomba, kterou appka
    // nedokázala sama přiřadit.
    const unreservedWatch = !track && status === "removed" && !verdict && removedAt ? watchFor(g)?.(removedAt) ?? null : null;
    const triage = status === "removed" ? assessSale(g.members, events) : null;
    // "Doba v nabídce" počítá do DNEŠKA u živých/rezervovaných nabídek,
    // u zmizelých do data zmizení — obojí je "jak dlouho byl byt na trhu",
    // jen s jiným koncovým bodem. `removedAt` je `null` u živých/
    // rezervovaných, `?? nowIso()` proto pokryje obojí jedním výrazem.
    const daysOnMarket = Math.round((new Date(removedAt ?? nowIso()) - new Date(firstSeenAt)) / (24 * 60 * 60 * 1000));
    return {
      g,
      rep,
      params: mergeParams(g.members),
      address: bestAddress(g.members),
      price,
      priceLabel: priceLabel(g.members),
      // Cena za m² — appka ji nikde nezíská hotovou, dopočítá se z ceny a
      // plochy primárního záznamu (stejný zdroj plochy jako titulek řádku).
      pricePerM2: price != null && rep.area_m2 ? Math.round(price / rep.area_m2) : null,
      status,
      firstSeenAt,
      removedAt,
      daysOnMarket,
      priceDropCount: dropCount,
      // Sleva celkem od prvně zaznamenané ceny do AKTUÁLNÍ (ne do poslední
      // eventu) — u živé nabídky je "aktuální" = `price` teď, u zmizelé je
      // to poslední cena, kterou appka viděla těsně před zmizením.
      totalDiscountCzk: originalPrice != null && price != null ? originalPrice - price : null,
      change,
      changeWhere: changeSources(g.members, events, change),
      discoveredAt,
      // Výsledek ruční kontroly v katastru (viz saleVerdict v group.js) a
      // odhad, jak pravděpodobně se zmizelý byt prodal (jen pro řazení
      // fronty /kontrola, viz sale-triage.js).
      addressInfo: addressInfo(g.members),
      track,
      unreservedWatch,
      // Čas se podívat do katastru: nastal kontrolní bod rozvrhu a po něm se
      // ještě nekontrolovalo (viz kn-schedule.js).
      saleCandidate: Boolean(track?.due),
      knFiledAt: pickOwnValue(g.members, "kn_filed_at"),
      plombaEnd: pickOwnValue(g.members, "kn_plomba_end"),
      knAutoUnit: pickOwnValue(g.members, "kn_auto_unit"),
      lvNumber: pickOwnValue(g.members, "lv_number"),
      saleVerdict: verdict,
      knCheckedAt: g.members.reduce((max, m) => (m.kn_checked_at && m.kn_checked_at > max ? m.kn_checked_at : max), "") || null,
      triage,
      // Neověřitelný byt (družstevní / dům bez jednotek) a téměř jistě prodaný
      // (prodaný, nebo po rezervaci zmizel) — viz sale-record.js. Obojí řídí, jak
      // se byt počítá ve statistikách.
      unverifiable: Boolean(track?.unverifiable || unreservedWatch?.unverifiable),
      almostSold: isAlmostSold({ status, verdict, wasReserved: Boolean(track) || Boolean(triage?.wasReserved) }),
      // "Aktivita" pro výchozí řazení = novější z (kdy appka byt objevila,
      // poslední skutečná změna) — čerstvě přidaný byt i dávno zaevidovaný
      // byt s dnešní změnou ceny mají oba vyjít jako "nahoře".
      activityAt: change && change.occurred_at > discoveredAt ? change.occurred_at : discoveredAt,
      starred: isStarred(g.members),
      hidden: isHidden(g.members),
      thumb: groupThumbnail(g.members),
      // Vlastní hodnocení uživatele (viz OWN_FIELDS v params.js) — appka se
      // pokusí odhadnout z textu (viz detect-own-fields.js, track.js), ale
      // nikdy nepřepíše, co appka/uživatel už jednou nastavili.
      ownCondition: pickOwnValue(g.members, "own_condition"),
      ownConstruction: pickOwnValue(g.members, "own_construction"),
      ownRevitalized: pickOwnValue(g.members, "own_revitalized"),
      statsInclude: pickOwnValue(g.members, "stats_include"),
      notes: pickOwnValue(g.members, "notes"),
      sellerMotivation: pickOwnValue(g.members, "seller_motivation"),
      verifiedSalePrice: pickOwnValue(g.members, "verified_sale_price_czk"),
      verifiedSaleDate: pickOwnValue(g.members, "verified_sale_date"),
    };
  });
  for (const e of entries) e.city = extractCity(e.address, BYTY_WATCH);
  return entries;
}

function renderTable(db, filters) {
  const { status: statusFilter, sort = "newest", city: cityFilter, ownership: ownershipFilter, top: topFilter, hidden: hiddenView, adresa: addressFilter } = filters;
  const showHidden = hiddenView === "show";
  const entries = computeEntries(db);
  const allGroups = entries.map((e) => e.g);

  // Volby pro "Město"/"Vlastnictví" — jen hodnoty, co se v datech opravdu
  // vyskytují (ze SEBE, ne z hardcoded seznamu, ať appka nenabízí volbu,
  // po které nic nenajde). Z CELÉ sady, ne z už filtrované — jinak by
  // volby při kombinaci filtrů mizely a přehled by nedával smysl.
  const cityOptions = [...new Set(entries.map((e) => e.city).filter(Boolean))].sort((a, b) => a.localeCompare(b, "cs"));
  const ownershipOptions = [...new Set(entries.map((e) => e.params.ownership).filter(Boolean))].sort((a, b) => a.localeCompare(b, "cs"));
  const hiddenCount = entries.filter((e) => e.hidden).length;

  // Skryté (křížkem vyřazené) položky se z běžného přehledu vylučují —
  // dokud si je uživatel výslovně nevyžádá přes "Skryté" (?hidden=show).
  // V tom pohledu naopak ukazujeme JEN skryté (kvůli případnému obnovení)
  // a stavový filtr se ignoruje. JEDINÁ VÝJIMKA: rezervovaný byt se ukáže
  // v pohledu "Rezervováno" i když je skrytý — rezervace je důležitá
  // informace o trhu, kterou uživatel chce vidět bez ohledu na to, že byt
  // dřív vyřadil (řádek je označený "skryto" a jde vrátit tlačítkem ↺).
  let filtered = entries;
  if (showHidden) {
    filtered = filtered.filter((e) => e.hidden);
  } else {
    filtered = filtered.filter((e) => !e.hidden || (statusFilter === "reserved" && e.status === "reserved"));
    if (statusFilter) filtered = filtered.filter((e) => matchesStatusFilter(e, statusFilter));
  }
  if (cityFilter) filtered = filtered.filter((e) => e.city === cityFilter);
  if (ownershipFilter) filtered = filtered.filter((e) => e.params.ownership === ownershipFilter);
  if (topFilter) filtered = filtered.filter((e) => e.starred);
  // "Bez adresy" = nabídky, které ještě mají šanci (v nabídce / rezervované)
  // a u kterých uživatel přesnou adresu nezapsal ani neoznačil za neznámou.
  const needsAddress = (e) => e.addressInfo.state === "missing" && (e.status === "active" || e.status === "reserved");
  const needsAddressCount = entries.filter((e) => !e.hidden && needsAddress(e)).length;
  if (addressFilter) filtered = filtered.filter(needsAddress);
  filtered = [...filtered].sort(SORTERS[sort] || SORTERS.newest);

  const current = { status: statusFilter, sort, city: cityFilter, ownership: ownershipFilter, top: topFilter, hidden: hiddenView, adresa: addressFilter };

  const filterLinks = STATUS_FILTERS
    .map((s) => {
      const label = statusFilterLabel(s);
      const active = !showHidden && (statusFilter === s || (!statusFilter && !s)) ? "active" : "";
      // Klik na stavový filtr vždy opustí pohled "Skryté" — kombinace by
      // neměla smysl (skryté položky appka stavem netřídí).
      return `<a class="filter ${active}" href="${buildQuery(current, { status: s, hidden: null })}">${esc(label)}</a>`;
    })
    .join("");

  const topLink = `<a class="filter ${topFilter ? "active" : ""}" href="${buildQuery(current, { top: topFilter ? null : "1" })}">⭐ TOP</a>`;
  const hiddenLink = `<a class="filter ${showHidden ? "active" : ""}" href="${buildQuery(current, { hidden: showHidden ? null : "show", status: null })}">🚫 Skryté (${hiddenCount})</a>`;
  const addressLink = `<a class="filter ${addressFilter ? "active" : ""}" href="${buildQuery(current, { adresa: addressFilter ? null : "chybi" })}">📍 Bez adresy (${needsAddressCount})</a>`;

  const sortLinks = SORT_LABELS.map(
    ([key, label]) => `<a class="filter ${sort === key ? "active" : ""}" href="${buildQuery(current, { sort: key })}">${esc(label)}</a>`
  ).join("");

  const cityOptionsHtml = [`<option value="">Všechna města</option>`]
    .concat(cityOptions.map((c) => `<option value="${esc(c)}" ${cityFilter === c ? "selected" : ""}>${esc(c)}</option>`))
    .join("");
  const ownershipOptionsHtml = [`<option value="">Vlastnictví (vše)</option>`]
    .concat(ownershipOptions.map((o) => `<option value="${esc(o)}" ${ownershipFilter === o ? "selected" : ""}>${esc(o)}</option>`))
    .join("");

  const rows = filtered
    .map((entry) => {
      const { g, rep, params, address, priceLabel: priceText_, status, saleVerdict: verdict, triage, track, addressInfo: ai, saleCandidate, firstSeenAt, change, changeWhere, starred, hidden, thumb } = entry;
      const saleInfo = saleInfoLine(entry);
      const saleChip = saleInfo ? ` <span class="sale-chip" title="Cena prodeje a stav v katastru (záložka Katastr)">💰 ${esc(saleInfo)}</span>` : "";
      // Přesná adresa (viz addressInfo): zapsaná se ukáže, nevyplněná u
      // nabídky, která ještě má šanci, upozorní, "neznámá" jen připomene,
      // že se na ni už koukalo. U zmizelých bytů bez adresy se nic neukazuje —
      // doplnit už ji nejde (řeší fronta /kontrola).
      const addressChip = addressChipHtml(ai, status);
      // Rezervovaný byt s adresou, u kterého už je čas dohledat prodej v katastru.
      const candidateChip =
        saleCandidate && ai.state === "known"
          ? `<a href="/kontrola" class="addr-chip addr-chip--candidate" title="${esc(track.reason)} (záložka Katastr)">🔎 zkontrolovat v katastru</a>`
          : "";
      const st = statusLabelFor(status, verdict, triage);
      const { live, gone, reserved } = sourcesByAvailability(g.members);
      // Když byt někde zmizel a jinde je, ukáže se to hned v řádku — "zmizelo
      // z nabídky" na jednom portálu není zmizení z trhu. Stejně tak kde je
      // rezervovaný (jiný portál ho může dál nabízet jako volný).
      const sourceLabel = live.length ? live.join(" + ") : gone.join(" + ");
      // Jen když rezervace není všude — jinak by to opakovalo odznak "Rezervováno".
      const reservedNote = reserved.length && reserved.length < live.length ? ` <span class="reserved-note">· rezervováno: ${esc(reserved.join(" + "))}</span>` : "";
      const goneNote = live.length && gone.length ? ` <span class="gone-note">· zmizelo: ${esc(gone.join(" + "))}</span>` : "";
      // Skrytý byt se v přehledu objeví jen v pohledu "Rezervováno" (viz výš) —
      // tam ať je jasné, proč tu je, i když ho uživatel dřív vyřadil.
      const hiddenNote = hidden && !showHidden ? ` <span class="hidden-note">· skryto (↺ vrátí do přehledu)</span>` : "";
      const linkBadge = g.merged ? ` <span class="link-badge" title="Stejná nemovitost nalezená na víc portálech">🔗</span>` : "";
      const photo = thumb
        ? `<img src="/photos/${encodeURIComponent(thumb.replace(/^photos[\\/]/, ""))}" loading="lazy" alt="">`
        : `<div class="row-photo-empty">Bez fotky</div>`;

      const paramsLine = paramsSummaryLine(params);
      const descriptionSource = pickDescription(g.members);
      const snippet = descriptionSource ? truncate(descriptionSource.description, 220) : "";
      const updates = updatesChips(firstSeenAt, change, changeWhere);

      return `<div class="row${starred ? " row--starred" : ""}${hidden && !showHidden ? " row--hidden" : ""}">
        <div class="row-actions">${rowActionButtons(rep.id, starred, hidden)}</div>
        <a class="row-link" href="/byt/${encodeURIComponent(rep.id)}">
          <div class="row-photo">${photo}</div>
          <div class="row-body">
            <div class="row-title">${starred ? "⭐ " : ""}${esc(cardTitle(rep, address, priceText_))}</div>
            ${paramsLine ? `<div class="row-params">${esc(paramsLine)}</div>` : ""}
            ${snippet ? `<div class="row-snippet">${esc(snippet)}</div>` : ""}
            <div class="row-updates">${updates}</div>
            <div class="row-meta">
              <span class="badge" style="background:${st.color}">${esc(st.text)}</span>${saleChip}
              <span class="muted">${esc(sourceLabel)}${linkBadge}${reservedNote}${goneNote}${hiddenNote}</span>
              ${addressChip}${candidateChip}
            </div>
          </div>
        </a>
      </div>`;
    })
    .join("");

  return `
    <h1>Byty (${filtered.length})</h1>
    <div class="filters">${filterLinks}${topLink}${addressLink}${hiddenLink}</div>
    <div class="toolbar">
      <div class="filters">${sortLinks}</div>
      <form method="get" action="/" class="select-filters">
        <input type="hidden" name="status" value="${esc(statusFilter || "")}">
        <input type="hidden" name="sort" value="${esc(sort)}">
        <input type="hidden" name="top" value="${esc(topFilter || "")}">
        <input type="hidden" name="hidden" value="${esc(hiddenView || "")}">
        <input type="hidden" name="adresa" value="${esc(addressFilter || "")}">
        <select name="city" onchange="this.form.submit()">${cityOptionsHtml}</select>
        <select name="ownership" onchange="this.form.submit()">${ownershipOptionsHtml}</select>
      </form>
    </div>
    <div class="rows">${
      rows ||
      `<p class="empty">${
        showHidden
          ? "Žádné byty nejsou skryté."
          : allGroups.length === 0
          ? `Zatím žádná data — spusť <code>npm run track-sales</code>.`
          : "Nic nenalezeno pro zvolené filtry."
      }</p>`
    }</div>`;
}

// Sloupce tabulky srovnání, u kterých jde kliknutím na hlavičku přepínat
// řazení. Klíč je hodnota `sort` v URL, `dir` výchozí směr PRVNÍHO kliknutí
// (další klik na tentýž sloupec vždy přepne opačně) — u čísel/data "nejdřív
// nejvíc/nejnovější" je užitečnější výchozí pohled než vzestupně od nuly.
const COMPARE_SORT_COLUMNS = {
  added: { get: (e) => e.firstSeenAt, label: "Přidáno", firstDir: "desc" },
  price: { get: (e) => e.price, label: "Cena", firstDir: "desc" },
  price_m2: { get: (e) => e.pricePerM2, label: "Cena/m²", firstDir: "asc" },
  area: { get: (e) => e.rep.area_m2, label: "Plocha", firstDir: "desc" },
  // Sleva sestupně = nejvyjednatelnější případy nahoře ("kolik už dolů
  // šel"). Doba v nabídce sestupně = nejdéle ležící nahoře — obojí přesně
  // ty signály z návodu ("leží 2 měsíce a zlevnil dvakrát").
  discount: { get: (e) => e.totalDiscountCzk, label: "Sleva", firstDir: "desc" },
  days: { get: (e) => e.daysOnMarket, label: "Doba v nabídce", firstDir: "desc" },
};

// `current` = všechny aktivní filtry tabulky (status, město, sloupce, řazení) —
// klik na hlavičku přepíše jen řazení, ostatní filtry zůstanou.
function compareSortHeader(current, key, label) {
  const col = COMPARE_SORT_COLUMNS[key];
  const [curKey, curDir] = (current.sort || "").split("_dir_");
  const isActive = curKey === key;
  // První klik na sloupec jede ve `firstDir`u, druhý klik na TENTÝŽ sloupec
  // směr otočí — třetí zase zpátky atd.
  const nextDir = isActive ? (curDir === "asc" ? "desc" : "asc") : col.firstDir;
  const arrow = isActive ? (curDir === "asc" ? " ↑" : " ↓") : "";
  return `<a class="compare-sort${isActive ? " active" : ""}" href="${buildQuery(current, { sort: `${key}_dir_${nextDir}` }, "/tabulka")}">${esc(label)}${arrow}</a>`;
}

/**
 * Tabulka srovnání — jeden byt = jeden řádek, VŠECHNY sledované údaje jako
 * sloupce vedle sebe (na rozdíl od `renderTable`, který je pro procházení s
 * fotkou a úryvkem popisu). K rychlému porovnání víc bytů najednou a k
 * zapsání vlastního hodnocení (stav/konstrukce/revitalizace/poznámka) bez
 * proklikávání do detailu — každá editovatelná buňka je vlastní malý
 * formulář s auto-submitem při změně (žádný klientský JS mimo
 * `this.form.submit()`, stejný vzorec jako filtr Město/Vlastnictví na "/").
 */
function renderComparisonTable(db, filters) {
  const { status: statusFilter, city: cityFilter, sort: sortParam, cols: colsParam } = filters;
  // Výchozí tabulka drží jen to, podle čeho se byty porovnávají; sloupce, které
  // appka vyplňuje sama nebo se do nich sahá zřídka, jsou za "Víc sloupců"
  // (a všechny jsou i v detailu bytu).
  const showAll = colsParam === "all";
  const entries = computeEntries(db);

  const cityOptions = [...new Set(entries.map((e) => e.city).filter(Boolean))].sort((a, b) => a.localeCompare(b, "cs"));

  // Skryté (křížkem vyřazené) se z tabulky srovnání vylučují stejně jako z
  // hlavního přehledu — je to uživatelovo "tohle mě nezajímá".
  let filtered = entries.filter((e) => !e.hidden);
  if (statusFilter) filtered = filtered.filter((e) => matchesStatusFilter(e, statusFilter));
  if (cityFilter) filtered = filtered.filter((e) => e.city === cityFilter);

  const [sortKey, sortDir] = (sortParam || "added_dir_desc").split("_dir_");
  const sortCol = COMPARE_SORT_COLUMNS[sortKey] || COMPARE_SORT_COLUMNS.added;
  const dir = sortDir === "asc" ? "asc" : "desc";
  filtered = [...filtered].sort((a, b) => {
    const va = sortCol.get(a);
    const vb = sortCol.get(b);
    if (va == null && vb == null) return 0;
    if (va == null) return 1; // chybějící hodnota vždy na konec, bez ohledu na směr
    if (vb == null) return -1;
    const cmp = va < vb ? -1 : va > vb ? 1 : 0;
    return dir === "asc" ? cmp : -cmp;
  });

  const current = { status: statusFilter, city: cityFilter, sort: sortParam, cols: colsParam };
  const filterLinks = STATUS_FILTERS
    .map((s) => {
      const label = statusFilterLabel(s);
      const active = statusFilter === s || (!statusFilter && !s) ? "active" : "";
      return `<a class="filter ${active}" href="${buildQuery(current, { status: s }, "/tabulka")}">${esc(label)}</a>`;
    })
    .join("");
  const cityOptionsHtml = [`<option value="">Všechna města</option>`]
    .concat(cityOptions.map((c) => `<option value="${esc(c)}" ${cityFilter === c ? "selected" : ""}>${esc(c)}</option>`))
    .join("");

  // Sloupce na jednom místě — hlavička i buňky z téhož seznamu, takže se
  // nemůžou rozejít při přidání/skrytí sloupce. `ext` = jen ve "Víc sloupců".
  // column = sloupec v DB ("own_condition"...), value = odpovídající
  // předpočítaná hodnota entry (e.ownCondition...) — přímé mapování, ne
  // odvozování jednoho jména z druhého.
  const noteInput = (encId, name, value, placeholder, type = "text", extra = "") =>
    `<form class="cell-form" method="post" action="/byt/${encId}/notes"><input type="${type}" name="${name}" value="${esc(value)}" placeholder="${placeholder}"${extra} onchange="this.form.requestSubmit()"></form>`;
  const ownSelect = (encId, column, value) =>
    `<form class="cell-form" method="post" action="/byt/${encId}/notes">${ownFieldSelectHtml(column, value, { autoSubmit: true })}</form>`;
  // Stejný vzorec jako ownSelect, jen jiný cíl (/params) a jiný generátor
  // pole (text i select, viz PARAM_OVERRIDE_FIELDS).
  const paramField = (encId, e, column) =>
    `<form class="cell-form" method="post" action="/byt/${encId}/params">${paramOverrideFieldHtml(column, e.params[column], { autoSubmit: true })}</form>`;

  const COLUMNS = [
    {
      head: "Nabídka",
      cell: (e) => {
        const st = statusLabelFor(e.status, e.saleVerdict, e.triage);
        return `<td><span class="badge small" style="background:${st.color}">${esc(st.text)}</span></td>`;
      },
    },
    {
      head: "Adresa / lokalita",
      cell: (e, encId) => {
        // Přesná adresa pod přibližnou — to, podle čeho se byt hledá v katastru.
        const chip = addressChipHtml(e.addressInfo, e.status, `/byt/${encId}#adresa`);
        return `<td>${noteInput(encId, "address", e.address || e.city, "adresa…")}${chip ? `<div class="cell-addr">${chip}</div>` : ""}</td>`;
      },
    },
    { head: "Dispozice", cell: (e, encId) => `<td>${noteInput(encId, "disposition", e.rep.disposition, "—")}</td>` },
    { head: "Plocha", cell: (e, encId) => `<td>${noteInput(encId, "area_m2", e.rep.area_m2 ?? "", "m²", "number", ' step="0.1"')}</td>` },
    { head: "Patro", cell: (e, encId) => `<td class="col-floor">${paramField(encId, e, "floorInfo")}</td>` },
    { head: "Výtah", cell: (e, encId) => `<td>${paramField(encId, e, "elevator")}</td>` },
    { head: "Balkón", cell: (e, encId) => `<td>${paramField(encId, e, "balcony")}</td>` },
    { head: "Sklep", cell: (e, encId) => `<td>${paramField(encId, e, "cellar")}</td>` },
    { head: "Vlastnictví", cell: (e, encId) => `<td>${paramField(encId, e, "ownership")}</td>` },
    { head: "Stav", ext: true, cell: (e, encId) => `<td>${ownSelect(encId, "own_condition", e.ownCondition)}</td>` },
    { head: "Konstrukce", ext: true, cell: (e, encId) => `<td>${ownSelect(encId, "own_construction", e.ownConstruction)}</td>` },
    { head: "Revitalizace", ext: true, cell: (e, encId) => `<td>${ownSelect(encId, "own_revitalized", e.ownRevitalized)}</td>` },
    { head: "Ve statistice", ext: true, cell: (e, encId) => `<td>${ownSelect(encId, "stats_include", e.statsInclude)}</td>` },
    { head: "Cena", sort: "price", cell: (e) => `<td>${esc(e.priceLabel)}</td>` },
    // Prodejní cena a stav vkladu u prodaných a téměř jistě prodaných bytů; u
    // filtrů Prodáno / Možný prodej je rovnou vidět, jinak za "Víc sloupců".
    { head: "Cena prodeje", ext: !(statusFilter === "sold" || statusFilter === "possible"), cell: (e) => `<td>${esc(saleInfoLine(e) ?? "—")}</td>` },
    { head: "Cena/m²", sort: "price_m2", cell: (e) => `<td>${esc(formatPricePerM2(e.pricePerM2))}</td>` },
    { head: "Sleva", sort: "discount", cell: (e) => `<td>${esc(priceDropLabel(e))}</td>` },
    { head: "Přidáno", sort: "added", cell: (e) => `<td>${esc(formatDateOnly(e.firstSeenAt))}</td>` },
    { head: "Doba v nabídce", sort: "days", cell: (e) => `<td>${esc(daysOnMarketLabel(e))}</td>` },
    {
      head: "Ověřená cena",
      ext: true,
      cell: (e, encId) => `<td><form class="cell-form cell-form--stack" method="post" action="/byt/${encId}/notes">
          <input type="number" name="verified_sale_price_czk" value="${e.verifiedSalePrice ?? ""}" placeholder="Kč" onchange="this.form.requestSubmit()">
          <input type="date" name="verified_sale_date" value="${e.verifiedSaleDate ?? ""}" onchange="this.form.requestSubmit()">
        </form></td>`,
    },
    {
      head: "Odkaz",
      cell: (e, encId) =>
        `<td class="compare-links"><a href="/byt/${encId}">Detail</a> · <a href="${esc(e.rep.url)}" target="_blank" rel="noopener">Inzerát ↗</a> · <a href="/byt/${encId}/kalkulacka">Kalkulačka</a></td>`,
    },
    { head: "Poznámka", ext: true, cell: (e, encId) => `<td>${noteInput(encId, "notes", e.notes, "poznámka…")}</td>` },
    { head: "Motivace prodávajícího", ext: true, cell: (e, encId) => `<td>${noteInput(encId, "seller_motivation", e.sellerMotivation, "motivace…")}</td>` },
  ];
  const visibleColumns = COLUMNS.filter((c) => showAll || !c.ext);
  const extraColumnCount = COLUMNS.filter((c) => c.ext).length;

  const rows = filtered
    .map((e) => {
      const encId = encodeURIComponent(e.rep.id);
      return `<tr class="${e.hidden ? "row--hidden" : ""}">
        ${visibleColumns.map((c) => c.cell(e, encId)).join("\n        ")}
      </tr>`;
    })
    .join("");

  const headerCells = visibleColumns
    .map((c) => (c.sort ? `<th>${compareSortHeader(current, c.sort, c.head)}</th>` : `<th>${esc(c.head)}</th>`))
    .join("");
  const colsLink = `<a class="filter" href="${buildQuery(current, { cols: showAll ? null : "all" }, "/tabulka")}">${
    showAll ? "Méně sloupců" : `Víc sloupců (+${extraColumnCount})`
  }</a>`;

  return `
    <h1>Srovnání bytů (${filtered.length})</h1>
    <div class="filters">${filterLinks}</div>
    <div class="toolbar">
      <form method="get" action="/tabulka" class="select-filters">
        <input type="hidden" name="status" value="${esc(statusFilter || "")}">
        <input type="hidden" name="sort" value="${esc(sortParam || "")}">
        <input type="hidden" name="cols" value="${esc(colsParam || "")}">
        <select name="city" onchange="this.form.submit()">${cityOptionsHtml}</select>
      </form>
      ${colsLink}
    </div>
    <div class="compare-wrap">
      <table class="compare">
        <thead><tr>${headerCells}</tr></thead>
        <tbody>${rows || `<tr><td colspan="${visibleColumns.length}" class="empty">Nic nenalezeno pro zvolené filtry.</td></tr>`}</tbody>
      </table>
    </div>`;
}

function renderDetail(db, id) {
  const allListings = db.prepare("SELECT * FROM listings").all();
  const group = findGroupForListing(allListings, id);
  if (!group) return null;

  const members = group.members;
  const rep = primaryListing(members); // nese notes/verified_sale_* — jeden sdílený záznam za skupinu
  const status = mergedStatus(members);
  const starred = isStarred(members);
  const hidden = isHidden(members);
  const sourceById = Object.fromEntries(members.map((m) => [m.id, m.source]));

  const memberIds = members.map((m) => m.id);
  const placeholders = memberIds.map(() => "?").join(",");
  const photos = db.prepare(`SELECT * FROM photos WHERE listing_id IN (${placeholders}) ORDER BY listing_id, id`).all(...memberIds);
  const events = db.prepare(`SELECT * FROM events WHERE listing_id IN (${placeholders}) ORDER BY occurred_at ASC`).all(...memberIds);
  // Štítek stavu (u zmizelého bytu po rezervaci "Možný prodej") — odhad
  // z historie se počítá jen pro zmizelé, stejně jako v computeEntries.
  const verdict = saleVerdict(members);
  const st = statusLabelFor(status, verdict, status === "removed" ? assessSale(members, events) : null);

  // Fotky se sčítají napříč VŠEMI členy skupiny — když je jeden zdroj
  // (typicky Sreality, jejíž CDN fotky odmítá stahovat, viz photos.js)
  // bez fotek, ale jiný portál se stejnou nemovitostí je má, appka je
  // ukáže odtud. Přesně tohle uživatel chtěl.
  const gallery = photos
    .map((p) => {
      const src = `/photos/${encodeURIComponent(p.local_path.replace(/^photos[\\/]/, ""))}`;
      const label = SOURCE_LABELS[sourceById[p.listing_id]] || sourceById[p.listing_id];
      return `<img src="${src}" loading="lazy" title="${esc(label)}">`;
    })
    .join("");

  const sourceLinks = byPriority(members)
    .map((m) => {
      const mst = STATUS_LABELS[m.status] || { text: m.status, color: "#000" };
      return `<li><a href="${esc(m.url)}" target="_blank" rel="noopener">${esc(SOURCE_LABELS[m.source] || m.source)} ↗</a> <span class="badge small" style="background:${mst.color}">${esc(mst.text)}</span></li>`;
    })
    .join("");

  // Jen JEDEN popis za skupinu (uživatel ho vícekrát nepotřebuje) — ten
  // nejdelší, viz group.js.
  const descriptionSource = pickDescription(members);
  const descriptionHtml = descriptionSource
    ? `<div class="description">${group.merged ? `<p class="description-source">${esc(SOURCE_LABELS[descriptionSource.source] || descriptionSource.source)}</p>` : ""}<p>${esc(descriptionSource.description)}</p></div>`
    : "";

  // Strukturované parametry (vlastnictví, stav, podlaží...) sloučené napříč
  // skupinou — podobně jako je Sreality/Bazoš ukazují u vlastní nabídky.
  const params = mergeParams(members);
  const paramRows = PARAM_FIELDS.filter(([key]) => params[key] != null)
    .map(([key, label]) => `<tr><th>${esc(label)}</th><td>${esc(params[key])}</td></tr>`)
    .join("");

  const timeline = events
    .map((e) => {
      const detail = eventDetail(e);
      const srcLabel = group.merged ? ` <span class="muted">(${esc(SOURCE_LABELS[sourceById[e.listing_id]] || sourceById[e.listing_id])})</span>` : "";
      return `<li><strong>${formatDate(e.occurred_at)}</strong> — ${esc(EVENT_LABELS[e.event_type] || e.event_type)}${srcLabel} ${detail}</li>`;
    })
    .join("");

  const address = bestAddress(members) || "";
  const ai = addressInfo(members);
  // Vyhodnocení polohy (viz geo-suggest.js) — ukazuje se vždy, aby bylo
  // vidět, odkud se automatická adresa vzala, nebo proč se nepřiřadila.
  const actx = buildAddressContext(db, allListings);
  const agroup = actx.groups.find((g) => g.members.some((m) => m.id === id));
  const resolution = resolveForGroup(actx, agroup);
  // Katastrální údaje z RÚIAN (k.ú. + dům) — to, co je v katastru potřeba
  // vedle čísla popisného.
  const kn = knInfoForGroup(actx, agroup, resolution);
  const knHtml = kn
    ? `<p class="muted"><strong>Katastr:</strong> ${esc(describeKn(kn))}${kn.via === "bod" && ai.state !== "known" ? " <span>(podle bodu z inzerátu, adresa není potvrzená)</span>" : ""}</p>`
    : "";
  const addressStatusText =
    ai.state === "known"
      ? ai.auto
        ? "✓ Doplněno automaticky — zkontroluj to a doplň jednotku."
        : "✓ Vyplněno."
      : ai.state === "unknown"
      ? "Označeno jako neznámá."
      : "⚠ Zatím nevyplněno.";
  // Odkazy na bod z portálu na mapě — k ručnímu ověření (okno, fasáda…).
  const mapLinks = members
    .filter((m) => typeof m.lat === "number" && typeof m.lon === "number")
    .map((m) => `<a href="https://mapy.cz/zakladni?x=${m.lon}&y=${m.lat}&z=19" target="_blank" rel="noopener">${esc(SOURCE_LABELS[m.source] || m.source)} ↗</a>`)
    .join(" · ");
  const encId = encodeURIComponent(rep.id);
  const suggestionHtml =
    ai.state === "missing" && resolution.level === "medium"
      ? `<div class="address-hint"><strong>Návrh:</strong> ${esc(resolution.text)} <span class="muted">(${esc(describeEvidence(resolution))} — nedostatečně jisté, aby se doplnilo samo)</span>
          <form class="ajax-form address-suggest" method="post" action="/byt/${encId}/adresa">
            <input type="hidden" name="exact_address" value="${esc(resolution.text)}"><input type="hidden" name="unit_number" value="${esc(ai.unit || "")}">
            <button type="submit" name="mode" value="save">Použít návrh</button>
          </form></div>`
      : "";
  const evidenceHtml =
    ai.auto && resolution.level === "high"
      ? `<p class="muted">Důvod: ${esc(describeEvidence(resolution))}.</p>`
      : ai.state === "missing" && resolution.reasons.length
      ? `<p class="muted">Automaticky nepřiřazeno: ${resolution.reasons.map(esc).join(" ")}</p>`
      : "";
  const retryHtml =
    ai.state === "unknown" || ai.autoOff
      ? `<form class="ajax-form address-retry" method="post" action="/byt/${encId}/adresa"><button type="submit" name="mode" value="auto" class="btn-secondary">🔄 Zkusit znovu automaticky</button></form>`
      : "";
  const latest = latestChange(events);
  const updates = updatesChips(earliestListedAt(members), latest, changeSources(members, events, latest));
  // Prodej a katastr: tytéž údaje a stejné hlídání plomb jako ve frontě Katastr.
  const watchFor = createWatchResolver(db, allListings, actx.groups, Date.now(), actx);
  const saleTrack = buildSaleTrack(members, events, Date.now(), watchFor(agroup));
  // Zmizelý byt bez rezervace nemá rozvrh, ale jde u něj poznat, že se v katastru ověřit nedá.
  const goneRemovedAt = !saleTrack && status === "removed" && !verdict ? latestRemovedAt(members) : null;
  const goneWatch = goneRemovedAt ? watchFor(agroup)(goneRemovedAt) : null;
  const saleSectionHtml = renderSaleSection({
    unverifiable: Boolean(saleTrack?.unverifiable || goneWatch?.unverifiable),
    rep,
    members,
    status,
    verdict,
    track: saleTrack,
    addressInfo: ai,
    scan: saleTrack && kn?.building?.isknId ? loadKnScans(db).get(kn.building.isknId) : null,
  });

  return `
    <p><a href="/">← Zpět na seznam</a></p>
    <div class="detail-heading">
      <h1>${starred ? "⭐ " : ""}${esc(rep.disposition || "")} ${rep.area_m2 ? `${rep.area_m2} m²` : ""}</h1>
      <div class="row-actions row-actions--detail">${rowActionButtons(rep.id, starred, hidden)}</div>
    </div>
    <p>
      <span class="badge" style="background:${st.color}">${esc(st.text)}</span>
      ${group.merged ? `· nalezeno na ${new Set(members.map((m) => m.source)).size} portálech` : ""}
    </p>
    <ul class="source-links">${sourceLinks}</ul>
    <p><a href="/byt/${encodeURIComponent(rep.id)}/kalkulacka">🧮 Kalkulačka marže re-flipu</a></p>
    <p>${esc(rep.disposition || "—")} · ${rep.area_m2 ? `${rep.area_m2} m²` : "—"} · ${esc(priceLabel(members))}</p>
    <p>${esc(address)}</p>
    <h2 id="adresa">📍 Přesná adresa</h2>
    <p class="muted">
      Adresa výš je jen přibližná, odhadnutá z inzerátu. Tady si zapiš přesnou adresu a ideálně i jednotku — až inzerát
      zmizí, bude se podle toho byt hledat v katastru. <strong>${esc(addressStatusText)}</strong>
    </p>
    <form class="ajax-form address-form" method="post" action="/byt/${encodeURIComponent(rep.id)}/adresa">
      <label>Adresa (ulice, č.p. / č.o., obec)<input type="text" name="exact_address" value="${esc(ai.exact)}" placeholder="např. Lukesova 1234, Ústí nad Orlicí" maxlength="200"></label>
      <label>Jednotka (číslo jednotky nebo bytu)<input type="text" name="unit_number" value="${esc(ai.unit)}" placeholder="např. 1234/12" maxlength="60"></label>
      <div class="address-actions">
        <button type="submit" name="mode" value="save">Uložit adresu</button>
        <button type="submit" name="mode" value="unknown" class="btn-secondary">Adresa neznámá</button>
      </div>
    </form>
    ${suggestionHtml}
    ${evidenceHtml}
    ${knHtml}
    ${retryHtml}
    ${mapLinks ? `<p class="muted">Bod z portálu na mapě: ${mapLinks}</p>` : ""}
    ${saleSectionHtml}
    <div class="row-updates">${updates}</div>
    ${gallery ? `<div class="gallery">${gallery}</div>` : ""}
    ${paramRows ? `<h2>Parametry</h2><table class="params">${paramRows}</table>` : ""}
    ${descriptionHtml ? `<h2>Popis</h2>${descriptionHtml}` : ""}

    <h2>Časová osa</h2>
    <ul class="timeline">${timeline}</ul>

    <h2>Doplnit parametry</h2>
    <form method="post" action="/byt/${encodeURIComponent(rep.id)}/params">
      ${PARAM_OVERRIDE_FIELDS.map(({ column, label }) => `<label>${esc(label)}${paramOverrideFieldHtml(column, params[column])}</label>`).join("")}
      <button type="submit">Uložit</button>
    </form>

    <h2>Vlastní hodnocení a poznámky</h2>
    <form method="post" action="/byt/${encodeURIComponent(rep.id)}/notes">
      <label>Adresa / lokalita<input type="text" name="address" value="${esc(address)}"></label>
      <label>Plocha (m²)<input type="number" name="area_m2" value="${rep.area_m2 ?? ""}" step="0.1"></label>
      ${OWN_FIELDS.map(
        ({ column, label }) => `<label>${esc(label)}${ownFieldSelectHtml(column, pickOwnValue(members, column))}</label>`
      ).join("")}
      <label>Motivace prodávajícího<input type="text" name="seller_motivation" value="${esc(pickOwnValue(members, "seller_motivation"))}" placeholder="dědictví, rozvod, stěhování…"></label>
      <label>Poznámka<textarea name="notes" rows="3">${esc(pickOwnValue(members, "notes"))}</textarea></label>
      <button type="submit">Uložit</button>
    </form>`;
}

// Query string → vstupy kalkulačky (viz flip-calculator.js). `f=1` (skryté
// pole formuláře) rozlišuje "čerstvě otevřená stránka" (žádné parametry v
// URL — vezmi rozumné výchozí hodnoty + cenu/plochu bytu) od "formulář byl
// odeslaný" (i kdyby uživatel nastavil hodnoty shodou okolností stejné jako
// výchozí, nebo odškrtl checkbox — nezaškrtnuté <input type="checkbox">
// se v query stringu vůbec neobjeví, takže "chybí" NENÍ totéž co "ještě
// nikdy neodesláno").
function parseFlipQuery(searchParams, rep) {
  const submitted = searchParams.get("f") === "1";
  const num = (key, fallback) => {
    if (!submitted) return fallback;
    const raw = searchParams.get(key);
    if (raw == null || raw === "") return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  };
  return {
    salePriceCzk: num("salePriceCzk", null),
    currentAskingPriceCzk: submitted ? num("currentAskingPriceCzk", null) : rep.price_czk ?? null,
    areaM2: submitted ? num("areaM2", null) : rep.area_m2 ?? null,
    renoRatePerM2Czk: num("renoRatePerM2Czk", DEFAULT_FLIP_INPUTS.renoRatePerM2Czk),
    kitchenCostCzk: num("kitchenCostCzk", DEFAULT_FLIP_INPUTS.kitchenCostCzk),
    clearingCostCzk: num("clearingCostCzk", DEFAULT_FLIP_INPUTS.clearingCostCzk),
    photographerCostCzk: num("photographerCostCzk", DEFAULT_FLIP_INPUTS.photographerCostCzk),
    lawyerCostCzk: num("lawyerCostCzk", DEFAULT_FLIP_INPUTS.lawyerCostCzk),
    sellViaAgent: submitted ? searchParams.get("sellViaAgent") === "on" : true,
    agentCommissionPct: num("agentCommissionPct", DEFAULT_FLIP_INPUTS.agentCommissionPct),
    vatPct: num("vatPct", DEFAULT_FLIP_INPUTS.vatPct),
    carryMonthlyCostCzk: num("carryMonthlyCostCzk", DEFAULT_FLIP_INPUTS.carryMonthlyCostCzk),
    carryMonths: num("carryMonths", DEFAULT_FLIP_INPUTS.carryMonths),
    targetMarginPct: num("targetMarginPct", DEFAULT_FLIP_INPUTS.targetMarginPct),
  };
}

function formatSignedCzk(n) {
  if (n == null) return "—";
  // Zaokrouhlení nesmí chybět — vstup bývá výsledek procentního počtu
  // (provize RK apod.), takže skoro nikdy není celé číslo; bez zaokrouhlení
  // by `toLocaleString` ukázalo i haléře desetinných míst ("−1 071 327,662 Kč").
  const rounded = Math.round(Math.abs(n));
  const sign = n > 0 ? "+" : n < 0 ? "−" : "";
  return `${sign}${formatCzk(rounded)}`;
}

/**
 * Kalkulačka marže re-flipu (`/byt/:id/kalkulacka`) — implementuje
 * uživatelovu vlastní metodiku (viz flip-calculator.js): zadá se odhad
 * prodejní ceny po reku (appka ho sama neodhaduje — návod cílí na
 * srovnatelné byty ze statistik, viz /stats), appka dopočítá náklady a
 * maximální nákupní cenu pro zvolenou cílovou marži. Klasický GET formulář
 * s tlačítkem "Přepočítat" (ne auto-submit jako v tabulce srovnání) — na
 * rozdíl od jednopolíčkových buněk tabulky tu uživatel typicky ladí víc
 * polí najednou, než chce nový výpočet.
 */
function renderFlipCalculator(rep, inputs, result) {
  const encId = encodeURIComponent(rep.id);
  const fmt = (n) => formatCzk(n != null ? Math.round(n) : null);
  // Barevné pásmo patří VÝHRADNĚ ke kontrolnímu srovnání s dnešní
  // inzerovanou cenou — maximální nákupní cena zůstává neutrální (černá),
  // je to jen dopočítané číslo, ne hodnocení "dobrý/špatný deal". Tři
  // pásma podle SKUTEČNÉ marže, prahy přesně z návodu: pod 10 % oranžová,
  // 10–20 % tmavší žlutá, nad 20 % zelená.
  const marginTierClass = (m) => (m == null ? "" : m >= 20 ? "margin-good" : m >= 10 ? "margin-mid" : "margin-low");

  return `
    <p><a href="/byt/${encId}">← Zpět na byt</a></p>
    <h1>Kalkulačka marže re-flipu</h1>
    <p class="muted">
      ${esc(rep.disposition || "")} ${rep.area_m2 ? `${rep.area_m2} m²` : ""} — inzerováno za ${esc(priceLabel([rep]))}.
      Odhad prodejní ceny po reku si udělej ze srovnatelných bytů na <a href="/stats">statistikách</a>,
      appka dopočítá náklady a maximální nákupní cenu pro tvou cílovou marži.
    </p>

    <form method="get" action="/byt/${encId}/kalkulacka">
      <input type="hidden" name="f" value="1">
      <label>Odhad prodejní ceny po reku (Kč)<input type="number" name="salePriceCzk" value="${inputs.salePriceCzk ?? ""}" required></label>
      <label>Dnešní inzerovaná cena (Kč) — jen pro kontrolní srovnání<input type="number" name="currentAskingPriceCzk" value="${inputs.currentAskingPriceCzk ?? ""}"></label>
      <label>Plocha (m²)<input type="number" name="areaM2" value="${inputs.areaM2 ?? ""}" step="0.1"></label>
      <label>Sazba rekonstrukce (Kč/m²)<input type="number" name="renoRatePerM2Czk" value="${inputs.renoRatePerM2Czk}"></label>
      <label>Kuchyň a spotřebiče (Kč)<input type="number" name="kitchenCostCzk" value="${inputs.kitchenCostCzk}"></label>
      <label>Vyklizení (Kč)<input type="number" name="clearingCostCzk" value="${inputs.clearingCostCzk}"></label>
      <label>Fotograf (Kč)<input type="number" name="photographerCostCzk" value="${inputs.photographerCostCzk}"></label>
      <label>Advokát na kupní smlouvu (Kč)<input type="number" name="lawyerCostCzk" value="${inputs.lawyerCostCzk}"></label>
      <label class="checkbox-label"><input type="checkbox" name="sellViaAgent" ${inputs.sellViaAgent ? "checked" : ""}> Prodávat přes realitní kancelář</label>
      <label>Provize RK (%)<input type="number" name="agentCommissionPct" value="${inputs.agentCommissionPct}" step="0.1"></label>
      <label>DPH na provizi (%)<input type="number" name="vatPct" value="${inputs.vatPct}" step="0.1"></label>
      <label>Carry náklady měsíčně (Kč)<input type="number" name="carryMonthlyCostCzk" value="${inputs.carryMonthlyCostCzk}"></label>
      <label>Předpokládaná doba realizace (měsíců)<input type="number" name="carryMonths" value="${inputs.carryMonths}"></label>
      <label>Cílová čistá marže (%)<input type="number" name="targetMarginPct" value="${inputs.targetMarginPct}" step="0.1"></label>
      <button type="submit">Přepočítat</button>
    </form>

    <h2>Náklady</h2>
    <table class="params">
      <tr><th>Rekonstrukce + vybavení celkem</th><td>${fmt(result.totalRenoCost)}</td></tr>
      <tr><th>Provize RK (vč. DPH)</th><td>${fmt(result.agentCommission)}</td></tr>
      <tr><th>Carry náklady celkem</th><td>${fmt(result.carryCost)}</td></tr>
      <tr><th>Náklady celkem (bez nákupní ceny)</th><td>${fmt(result.costsWithoutBuy)}</td></tr>
    </table>

    <h2>Výsledek</h2>
    <div class="flip-result">
      <div class="flip-result-headline">Maximální nákupní cena pro ${esc(String(inputs.targetMarginPct))} % marži</div>
      <div class="flip-result-value">${fmt(result.maxBuyPrice)}</div>
      <div class="flip-result-margin">Zisk při cílové marži: ${formatSignedCzk(result.profitAtMaxBuy)} (pevné % z prodejní ceny — vyšší náklady se projeví v nižší nákupní ceně výš, ne v tomhle čísle)</div>
    </div>
    ${
      inputs.currentAskingPriceCzk != null && result.marginAtAsking != null
        ? `<div class="flip-result flip-result--secondary ${marginTierClass(result.marginAtAsking)}">
            <div class="flip-result-headline">Při dnešní inzerované ceně (${fmt(inputs.currentAskingPriceCzk)})</div>
            <div class="flip-result-value">${formatSignedCzk(result.profitAtAsking)} <span class="flip-result-margin">(${result.marginAtAsking.toFixed(1)} % marže)</span></div>
          </div>`
        : ""
    }
    <p class="muted">Marže = čistý zisk ÷ celkové náklady (vč. nákupní ceny) × 100. Cíl 20–30 % je kvalitní deal, 10–20 % okrajové, pod 10 % nedoporučeno.</p>`;
}

const NOTIFICATION_TYPES = {
  reserved: { icon: "🔒", label: "Rezervace", empty: "Zatím žádná rezervace nebyla zaznamenána." },
  price: { icon: "💰", label: "Změny cen", empty: "Zatím žádná změna ceny nebyla zaznamenána." },
  new: { icon: "🆕", label: "Nové nabídky", empty: "Zatím žádná nová nabídka (sledují se od zapnutí upozornění)." },
};

// Věta o tom, co se stalo (druhá řádka upozornění).
function notificationHeadline(n) {
  if (n.type === "price") {
    const { oldPrice, newPrice } = n.detail;
    const diff =
      oldPrice != null && newPrice != null
        ? ` (${newPrice < oldPrice ? "−" : "+"}${formatCzk(Math.abs(newPrice - oldPrice))})`
        : "";
    return `Změna ceny: ${priceText(oldPrice)} → ${priceText(newPrice)}${diff}`;
  }
  return n.type === "reserved" ? "Rezervováno" : "Nová nabídka";
}

// Stránka zvonečku: rezervace, změny cen a nové nabídky, nepřečtená
// zvýrazněná. Zobrazení stránky je NEoznačí jako přečtená — to dělá až
// tlačítko, ať upozornění nezmizí jen proto, že se stránka omylem otevřela.
function renderNotifications(db, typeFilter) {
  const all = getNotifications(db);
  const seenAt = getNotificationsSeenAt(db);
  const unread = countUnread(all, seenAt);
  const notifications = typeFilter && NOTIFICATION_TYPES[typeFilter] ? all.filter((n) => n.type === typeFilter) : all;

  const items = notifications
    .map((n) => {
      const members = n.group.members;
      const rep = primaryListing(members);
      const title = cardTitle(rep, bestAddress(members), priceLabel(members));
      const status = mergedStatus(members);
      const sources = [...n.sources].map((s) => SOURCE_LABELS[s] || s).join(" + ");
      // Rezervace mohla mezitím skončit (zrušená, byt prodán/stažen) — ať to
      // upozornění neklame.
      const now = n.type === "reserved" && status !== "reserved" ? ` · <em>nyní: ${esc((STATUS_LABELS[status] || { text: status }).text)}</em>` : "";
      return `<a class="notif${n.occurredAt > seenAt ? " notif--new" : ""}" href="/byt/${encodeURIComponent(rep.id)}">
        <span class="notif-title">${NOTIFICATION_TYPES[n.type].icon} ${esc(title)}</span>
        <span class="notif-meta">${esc(notificationHeadline(n))} · ${esc(formatDate(n.occurredAt))} · ${esc(sources)}${now}</span>
      </a>`;
    })
    .join("");

  const pills = [["", "Vše"], ...Object.entries(NOTIFICATION_TYPES).map(([key, t]) => [key, t.label])]
    .map(([key, label]) => {
      const count = key ? all.filter((n) => n.type === key).length : all.length;
      return `<a class="filter ${(typeFilter || "") === key ? "active" : ""}" href="/upozorneni${key ? `?typ=${key}` : ""}">${esc(label)} (${count})</a>`;
    })
    .join("");

  const empty = typeFilter && NOTIFICATION_TYPES[typeFilter] ? NOTIFICATION_TYPES[typeFilter].empty : "Zatím žádná upozornění.";
  return `
    <h1>Upozornění</h1>
    <div class="filters">${pills}</div>
    ${
      unread
        ? `<form method="post" action="/upozorneni/precteno" class="mark-read-form"><button type="submit">Označit vše jako přečtené (${unread})</button></form>`
        : ""
    }
    <div class="notifs">${items || `<p class="empty">${esc(empty)}</p>`}</div>`;
}

// Byt patří do statistiky "ceny po rekonstrukci", pokud to uživatel vědomě
// nepřehlasoval (`statsInclude`, viz OWN_FIELDS "Ve statistice") — jinak
// auto-kritérium: zmizel z nabídky (= pravděpodobně prodáno/rezervováno
// jinde) nebo ho portál označil jako prodaný, A appka/uživatel ho označili
// jako "Po rekonstrukci". Novostavba se SCHVÁLNĚ nepočítá do stejného koše
// (jiný cenový segment), kdo ji chce zahrnout, přehlasuje ručně přes
// "Zahrnout".
function isEligibleForRenoStats(e) {
  if (e.statsInclude === "exclude") return false;
  if (e.statsInclude === "include") return true;
  // Zmizelý byt, o kterém uživatel v katastru ověřil, že se neprodal, není
  // doklad o ceně, za kterou se prodávají byty.
  if (e.saleVerdict === "withdrawn") return false;
  return (e.status === "removed" || e.status === "sold") && e.ownCondition === "renovated";
}

// Ověřená prodejní cena (uživatel si ji dohledal v katastru) má vždy
// přednost — je to REÁLNÁ transakce. Bez ní appka bere poslední evidovanou
// (inzerovanou) cenu těsně před zmizením — návod výslovně upozorňuje, že to
// NENÍ prodejní cena (typicky o pár % výš), proto se u takových řádků
// značí "odhad" a počet ověřených/odhadnutých se ukazuje zvlášť. To platí i
// pro byt, který portál označil jako PRODÁNO: je to fakt o prodeji, ale cena
// u inzerátu je jen poslední inzerovaná, ne kupní — jde do fronty Katastr
// ověřit. Výjimka: družstevní byt (v katastru se ověřit nedá) — tam je byt
// hotový a bere se poslední cena z portálu, ale SNÍŽENÁ o ASSUMED_PRICE_DISCOUNT
// (kupní cena bývá nižší než inzerovaná) a ve statistikách je označená jako
// odhad (`statsSalePrice`, sale-record.js).
function effectivePriceForStats(e) {
  // Poslední cena snížená o koeficient: portálem prodaný byt, který jde ověřit
  // jen těžko (priceAssumed), i každý prodaný/zmizelý byt, který se v katastru
  // ověřit nedá — jinak by o jeho ceně nebylo vůbec nic, a přitom jde o téměř
  // jistý prodej.
  const assumed = Boolean(e.track?.priceAssumed) || (e.unverifiable && (e.status === "removed" || e.status === "sold" || e.status === "reserved"));
  return statsSalePrice({ verified: e.verifiedSalePrice, price: e.price, assumed });
}

// Souhrn "cena/m² u prodaných bytů po rekonstrukci" — PRIMÁRNĚ podle
// města, uvnitř každého města rozpad podle dispozice (přesně v tomhle
// pořadí chtěl uživatel, ne dvě oddělené tabulky vedle sebe). Vrací i
// `count` u každého řádku, ať je i při řídkých datech vidět velikost
// vzorku — appka si nic nevymýšlí za nedostatek dat, jen ho ukáže.
function renovatedSaleStats(entries) {
  return soldSaleStats(entries, isEligibleForRenoStats);
}

// Prodané a téměř jistě prodané byty bez ohledu na stav bytu: to, o co v
// appce hlavně jde. Ruční "Ve statistice: vyřadit" platí i tady.
function almostSoldSaleStats(entries) {
  return soldSaleStats(entries, (e) => e.almostSold && e.statsInclude !== "exclude");
}

function soldSaleStats(entries, isEligible) {
  const eligible = entries
    .filter(isEligible)
    .map((e) => ({
      pricePerM2: (() => {
        const { price } = effectivePriceForStats(e);
        return price != null && e.rep.area_m2 ? price / e.rep.area_m2 : null;
      })(),
      disposition: e.rep.disposition || "—",
      city: e.city || "—",
      basis: effectivePriceForStats(e).basis, // verified | assumed | asking
      // Pro rozklikávací seznam bytů za průměrem (viz renderCityStatsTable)
      // — appka jinak ukazovala jen holé číslo bez možnosti ověřit, ze
      // kterých konkrétních bytů vzniklo.
      id: e.rep.id,
      address: e.address || e.city,
      areaM2: e.rep.area_m2,
      evidence: saleEvidence(e.status),
    }))
    .filter((r) => r.pricePerM2 != null);

  function summarize(rows) {
    const values = rows.map((r) => r.pricePerM2);
    return {
      count: rows.length,
      verifiedCount: rows.filter((r) => r.basis === "verified").length,
      assumedCount: rows.filter((r) => r.basis === "assumed").length,
      pendingCount: rows.filter((r) => r.basis === "pending").length,
      avg: Math.round(values.reduce((s, v) => s + v, 0) / values.length),
      min: Math.round(Math.min(...values)),
      max: Math.round(Math.max(...values)),
      // Od nejlevnějšího po nejdražší — stejné pořadí, v jakém appka jinak
      // ukazuje rozsah (min–max).
      items: rows.slice().sort((a, b) => a.pricePerM2 - b.pricePerM2),
    };
  }

  const byCity = new Map();
  for (const r of eligible) {
    if (!byCity.has(r.city)) byCity.set(r.city, new Map());
    const byDisposition = byCity.get(r.city);
    if (!byDisposition.has(r.disposition)) byDisposition.set(r.disposition, []);
    byDisposition.get(r.disposition).push(r);
  }

  const cities = [...byCity.entries()]
    .map(([city, byDisposition]) => {
      const dispositions = [...byDisposition.entries()]
        .map(([disposition, rows]) => ({ disposition, ...summarize(rows) }))
        .sort((a, b) => b.count - a.count);
      const totalCount = dispositions.reduce((sum, d) => sum + d.count, 0);
      return { city, dispositions, totalCount };
    })
    .sort((a, b) => b.totalCount - a.totalCount);

  return { cities, totalEligible: eligible.length };
}

// Seznam bytů za jedním průměrem — rozklikávací `<details>` uvnitř buňky
// (žádný JS potřeba), ať jde ověřit, ze kterých konkrétních nabídek číslo
// vzniklo, místo slepé důvěry holému průměru.
function renderStatsItemsList(items) {
  const rows = items
    .map((it) => {
      const verifiedBadge =
        it.basis === "verified"
          ? ` <span class="muted">(ověřeno)</span>`
          : it.basis === "assumed"
          ? ` <span class="muted">(nejde ověřit — poslední cena −${Math.round(ASSUMED_PRICE_DISCOUNT * 100)} %)</span>`
          : it.basis === "pending"
          ? ` <span class="muted">(čeká na ověření v katastru — poslední cena −${Math.round(ASSUMED_PRICE_DISCOUNT * 100)} %)</span>`
          : "";
      const areaLabel = it.areaM2 ? `, ${it.areaM2} m²` : "";
      const evidenceLabel = { sold: "prodáno", gone: "zmizelo po rezervaci", reserved: "rezervováno" }[it.evidence];
      return `<li><a href="/byt/${encodeURIComponent(it.id)}">${esc(it.address)}${areaLabel}</a> — ${formatCzk(Math.round(it.pricePerM2))}/m²${verifiedBadge}${evidenceLabel ? ` <span class="muted">· ${evidenceLabel}</span>` : ""}</li>`;
    })
    .join("");
  return `<details class="stats-items"><summary>${items.length} bytů</summary><ul>${rows}</ul></details>`;
}

function renderCityStatsTable(cityStats) {
  const body = cityStats.dispositions
    .map(
      (d) => `<tr>
        <td>${esc(d.disposition)}</td>
        <td>${renderStatsItemsList(d.items)}${d.verifiedCount ? ` <span class="muted">(${d.verifiedCount}× ověřeno)</span>` : ""}${d.assumedCount ? ` <span class="muted">(${d.assumedCount}× nejde ověřit −${Math.round(ASSUMED_PRICE_DISCOUNT * 100)} %)</span>` : ""}${d.pendingCount ? ` <span class="muted">(${d.pendingCount}× čeká na ověření −${Math.round(ASSUMED_PRICE_DISCOUNT * 100)} %)</span>` : ""}</td>
        <td>${formatCzk(d.avg)}/m²</td>
        <td class="muted">${formatCzk(d.min)}–${formatCzk(d.max)}/m²</td>
      </tr>`
    )
    .join("");
  return `<h3>${esc(cityStats.city)} <span class="muted">(${cityStats.totalCount})</span></h3>
    <table class="stats-table">
      <thead><tr><th>Dispozice</th><th>Počet</th><th>Průměr</th><th>Rozsah</th></tr></thead>
      <tbody>${body}</tbody>
    </table>`;
}

function renderStats(db) {
  // Skryté (křížkem vyřazené) položky se do statistik nepočítají — hidden
  // je uživatelovo "tohle mě nezajímá", stejná úvaha jako v přehledu.
  const entries = computeEntries(db).filter((e) => !e.hidden);

  // Počítáno na SKUPINY (skutečné nemovitosti), ne syrové řádky — jinak by
  // stejný byt nalezený na 2 portálech vyšel v součtu jako 2 byty.
  const counts = { active: 0, reserved: 0, sold: 0, removed: 0 };
  for (const e of entries) counts[e.status]++;
  const soldVerified = entries.filter((e) => e.status === "sold" && e.verifiedSalePrice != null).length;
  const soldAssumed = entries.filter((e) => e.status === "sold" && effectivePriceForStats(e).basis === "assumed").length;
  const soldPending = entries.filter((e) => e.status === "sold" && effectivePriceForStats(e).basis === "pending").length;
  const countRows = Object.entries(counts)
    .map(
      ([k, n]) =>
        `<li>${esc(STATUS_LABELS[k].text)}: <strong>${n}</strong>${
          k === "sold" && n ? ` <span class="muted">(ověřená cena ${soldVerified}; odhad −${Math.round(ASSUMED_PRICE_DISCOUNT * 100)} % z poslední ceny: čeká na ověření ${soldPending}, nejde ověřit ${soldAssumed})</span>` : ""
        }</li>`
    )
    .join("");
  const mergedCount = entries.filter((e) => e.g.merged).length;

  const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
  const removedRecentWithData = entries.filter(
    (e) =>
      (e.status === "removed" || e.status === "sold") &&
      e.saleVerdict !== "withdrawn" &&
      e.removedAt &&
      new Date(e.removedAt).getTime() >= cutoff &&
      e.price != null &&
      e.rep.area_m2 != null
  );
  const avgPerM2 = removedRecentWithData.length
    ? Math.round(removedRecentWithData.reduce((sum, e) => sum + e.price / e.rep.area_m2, 0) / removedRecentWithData.length)
    : null;

  const renoStats = renovatedSaleStats(entries);
  const soldStats = almostSoldSaleStats(entries);
  const goneAfterReservation = entries.filter((e) => e.almostSold && e.status === "removed").length;
  const justReserved = entries.filter((e) => e.almostSold && e.status === "reserved").length;

  return `
    <p><a href="/">← Zpět na seznam</a></p>
    <h1>Statistiky</h1>
    <ul>${countRows}</ul>
    <p class="muted">Z toho ${mergedCount} nemovitostí nalezeno na víc portálech zároveň.</p>
    <h2>Zmizelé z nabídky za posledních 90 dní</h2>
    <p>${
      removedRecentWithData.length
        ? `${removedRecentWithData.length} bytů, průměr ${formatCzk(avgPerM2)}/m² (z poslední evidované ceny, ne nutně skutečná prodejní cena)`
        : "Zatím žádná data."
    }</p>

    <h2>Prodané a téměř jistě prodané byty</h2>
    <p class="muted">
      Byty, které jsou aspoň částečně prodané: prodané (podle katastru, nebo podle portálu), po rezervaci zmizelé z nabídky
      (${goneAfterReservation}× — téměř jistý prodej) a zatím jen rezervované (${justReserved}× — kupec už je, rezervace ale ještě může
      padnout; pak byt z přehledu sám zmizí). U každého bytu je vidět, na čem prodej stojí. Bez ohledu na stav bytu. Cena: ověřená
      z katastru (nebo zadaná ručně); dokud není, počítá se poslední inzerovaná cena snížená o ${Math.round(ASSUMED_PRICE_DISCOUNT * 100)} % (kupní cena
      bývá nižší než inzerovaná) — „čeká na ověření v katastru“, a u bytů, které se v katastru ověřit nedají (družstevní, dům bez
      jednotek), „nejde ověřit“. Jakmile cenu ověříš, nahradí odhad. Zmizelé byty bez rezervace sem
      nepatří, to je jen možný prodej. Skutečnou cenu můžeš zadat u bytu (Katastr → Vyřízené → Znám cenu, nebo v detailu).
      Celkem ${soldStats.totalEligible} bytů se známou cenou/m².
    </p>
    ${soldStats.cities.length ? soldStats.cities.map(renderCityStatsTable).join("") : `<p class="muted">Zatím žádná data.</p>`}

    <h2>Ceny po rekonstrukci (prodané byty)</h2>
    <p class="muted">
      Byty zmizelé z nabídky nebo označené jako prodané, se stavem „Po rekonstrukci", případně ručně
      přehlasované přes sloupec „Ve statistice" v tabulce srovnání. Cena je ověřená prodejní, pokud ji máš dohledanou
      v katastru (nebo zadanou ručně). Jinak je to poslední inzerovaná cena před zmizením nebo u prodaného bytu snížená o
      ${Math.round(ASSUMED_PRICE_DISCOUNT * 100)} % (kupní cena bývá nižší než inzerovaná), označená „čeká na ověření v katastru“, případně „nejde ověřit“
      u družstevních bytů a domů bez jednotek. Celkem ${renoStats.totalEligible} bytů se známou cenou/m².
    </p>
    ${renoStats.cities.length ? renoStats.cities.map(renderCityStatsTable).join("") : `<p class="muted">Zatím žádná data.</p>`}`;
}

// Formulář a tlačítko fronty Katastr — sdílí je karty ve frontě i sekce
// "Prodej a katastr" v detailu bytu (jeden zápis: POST /byt/:id/kn).
function knActionForm(encId, inner) {
  return `<form class="ajax-form kn-form" method="post" action="/byt/${encId}/kn">${inner}</form>`;
}
function knBtn(action, label, cls, confirmText = null) {
  const confirm = confirmText ? ` onclick="return confirm('${confirmText}')"` : "";
  return `<button type="submit" name="action" value="${action}" class="kn-btn ${cls}"${confirm}>${label}</button>`;
}
// Vrácení bytu mezi nerozhodnuté smaže i cenu a datum prodeje (sale-record.js) —
// když nějaké jsou, tlačítko se nejdřív zeptá.
const RESET_CONFIRM = "Vrátit byt mezi nerozhodnuté? Smaže se i zadaná cena a datum prodeje.";

// Co o domě ví API katastru (kn-scan.js): plomby po rezervaci. U bytu se
// zapsanou jednotkou je to přímý údaj, jinak jen nápověda — v domě se
// prodává víc bytů a plomba nemusí patřit tomuhle, rozhodne tlačítko.
function renderPlombaBlock(e, scan) {
  if (!scan) return "";
  const encId = encodeURIComponent(e.rep.id);
  // Jednotka zapsaná ručně má přednost; jinak ta, kterou appka odhadla podle
  // jediné plomby v domě (kn-scan.js) — u té se píše, že je to odhad.
  const manualUnit = parseUnitNumber(e.addressInfo.unit);
  const guessedUnit = manualUnit == null ? parseUnitNumber(e.knAutoUnit) : null;
  const a = analyzePlombas(scan, { reservedAt: e.track.reservedAt, unitNumber: manualUnit ?? guessedUnit });
  // Zmizelý byt bez rezervace: počátek je zmizení inzerátu (kn-scan.js, unreservedTrack).
  const since = e.track.unreserved ? "po zmizení inzerátu" : "po rezervaci";
  const stamp = `<span class="muted"> (API katastru, ${esc(formatKnDay(scan.scannedAt))})</span>`;
  const stavy = (c) => c.proceedings.map((r) => `${esc(formatKnDay(r.datumPrijeti))}${r.stav ? ` — ${esc(r.stav)}` : ""}`).join("; ");
  const closedText = (c) =>
    `řízení V-${esc(c.proceeding.cislo)}/${esc(c.proceeding.rok)} u č. ${esc(c.label)} skončilo${c.proceeding.stav ? ` (${esc(c.proceeding.stav)})` : ""} — zjisti cenu`;
  const lines = [];
  if (a.mode === "unit") {
    if (a.unit.missing) lines.push(`⚠ Jednotka ${esc(a.unit.label)} v domě neexistuje — zkontroluj číslo v detailu bytu.`);
    else if (a.candidates.length)
      a.candidates.forEach((c) =>
        lines.push(
          `🔖 <strong>Jednotka ${esc(c.label)}${c.lv ? ` (LV ${esc(c.lv)})` : ""}: vklad podán</strong>${guessedUnit != null ? ` <em>(odhad — v domě je ${since} jediná plomba a tenhle byt je v domě jediný sledovaný; není-li to on, zruš vklad)</em>` : ""} — ${stavy(c)}`
        )
      );
    else lines.push(`Jednotka ${esc(a.unit.label)}: ${since} žádná plomba.`);
  } else if (a.unitCount === 0) {
    lines.push("Dům nemá v katastru vymezené jednotky (typicky družstevní byty) — vklad tu nevznikne, prodej v katastru nepůjde sledovat.");
  } else if (a.incomplete) {
    return "";
  } else if (a.candidates.length) {
    lines.push(`🔎 V domě je podaný vklad — je to tenhle byt?`);
    for (const c of a.candidates) {
      const confirm = knActionForm(
        encId,
        `<input type="hidden" name="unit_number" value="${esc(c.label)}"><input type="hidden" name="kn_filed_at" value="${esc(c.filedAt)}"><input type="hidden" name="lv_number" value="${esc(c.lv ?? "")}">${knBtn("unit", "To je ten byt", "kn-btn--sold")}`
      );
      lines.push(`<div class="kn-plomba-row">č. <strong>${esc(c.label)}</strong>${c.lv ? ` (LV ${esc(c.lv)})` : ""}${c.share ? ` · podíl ${esc(c.share)}` : ""} — podáno ${stavy(c)} ${confirm}</div>`);
    }
  } else {
    lines.push(`V domě (${a.unitCount} jednotek) ${since} nikdo nepodal vklad. Zapíšeš-li jednotku bytu v detailu, appka ji pak sleduje sama.`);
  }
  for (const c of a.closed) lines.push(closedText(c));
  return `<div class="kn-plomba">${lines.map((l) => (l.startsWith("<div") ? l : `<div>${l}</div>`)).join("")}${stamp}</div>`;
}

// Stav prodeje jednou větou — v detailu bytu. Čte stejné údaje jako fronta
// Katastr a statistiky (sale-record.js), takže se nemůžou rozejít.
function saleStageText({ verdict, track, price, saleDate, filed, portalSold = false, lastPrice = null, unverifiable = false, countsInStats = false }) {
  if (verdict === "withdrawn") return "Neprodáno — ověřeno v katastru";
  if (price != null) return `Prodáno za ${formatCzk(price)}${saleDate ? ` (${formatDateOnly(saleDate)})` : ""}`;
  if (track?.priceAssumed) return `Prodáno podle portálu — poslední cena ${formatCzk(lastPrice)}, v katastru ji nejde ověřit; do statistik se počítá snížená o ${Math.round(ASSUMED_PRICE_DISCOUNT * 100)} % (${formatCzk(assumedSalePrice(lastPrice))})`;
  if (unverifiable && !verdict) {
    const counted = countsInStats && lastPrice != null ? `; ve statistikách se počítá poslední cena −${Math.round(ASSUMED_PRICE_DISCOUNT * 100)} % (${formatCzk(assumedSalePrice(lastPrice))}), skutečnou cenu můžeš zadat níže` : "";
    return `Nejde ověřit v katastru (družstevní byt, nebo dům bez vymezených jednotek) — appka ho nehlídá${counted}`;
  }
  if (portalSold && !filed && lastPrice != null) return `Prodáno podle portálu — cena z inzerátu ${formatCzk(lastPrice)} zatím není ověřená v katastru`;
  if (verdict === "sold" || portalSold) return filed ? `Prodáno — vklad podán ${formatDateOnly(filed)}, cena se dohledá po rozhodnutí o vkladu` : "Prodáno — cena zatím neznámá";
  if (track) {
    if (track.expired) return "Vklad se nenašel — nezjištěno";
    if (track.watched) return track.unverifiable ? "Čeká na vklad — v katastru ho nejde ověřit" : "Čeká na vklad — plomby hlídá appka přes API katastru";
    return track.due ? `K vyřízení — ${track.reason}` : "Čeká na vklad";
  }
  return "zatím bez údajů o prodeji";
}

// Sekce "Prodej a katastr" v detailu bytu: stav, údaje z API katastru a
// formulář se všemi údaji o prodeji. Zapisuje přes stejný endpoint jako fronta
// Katastr (action "record"), takže cokoli se tu doplní, je hned vidět tam i ve
// statistikách — a naopak.
function renderSaleSection({ rep, members, status, verdict, track, addressInfo: ai, scan, unverifiable = false }) {
  const price = pickOwnValue(members, "verified_sale_price_czk");
  const saleDate = pickOwnValue(members, "verified_sale_date");
  const filed = pickOwnValue(members, "kn_filed_at");
  const plombaEnd = pickOwnValue(members, "kn_plomba_end");
  const lv = pickOwnValue(members, "lv_number");
  const autoUnit = pickOwnValue(members, "kn_auto_unit");
  const encId = encodeURIComponent(rep.id);
  const hasData = Boolean(verdict || price != null || saleDate || filed || lv || track || unverifiable || members.some((m) => m.status === "sold"));
  const soldListing = members.find((m) => m.status === "sold");
  const stage = saleStageText({ verdict, track, price, saleDate, filed, portalSold: Boolean(soldListing), lastPrice: soldListing?.price_czk ?? bestPrice(members) ?? null, unverifiable, countsInStats: isAlmostSold({ status, verdict, wasReserved: Boolean(track) }) });
  const unitLine = ai.unit
    ? `Jednotka: <strong>${esc(ai.unit)}</strong> (mění se výš v „Přesná adresa“).`
    : autoUnit
    ? `Jednotka (odhad appky podle plomby): <strong>${esc(autoUnit)}</strong>. Zapsat ji napevno jde výš v „Přesná adresa“.`
    : "Jednotka: nezapsaná — zapíšeš ji výš v „Přesná adresa“, appka pak sama sleduje plombu na ní.";
  const plomba = track ? renderPlombaBlock({ rep, track, addressInfo: ai, knAutoUnit: autoUnit }, scan) : "";
  const form = knActionForm(
    encId,
    `<label class="kn-date">vklad podán <input type="date" name="kn_filed_at" value="${esc(filed ?? "")}" title="Den, kdy byl v katastru podán návrh na vklad (plomba)"></label>
      <label class="kn-date">konec plomby <input type="date" name="kn_plomba_end" value="${esc(plombaEnd ?? "")}" title="Kdy plomba (řízení o vkladu) končí nebo skončila — po něm jde v katastru zjistit kupní cenu. Můžeš zadat i budoucí termín; prázdné pole ho smaže."></label>
      <input type="text" name="lv_number" value="${esc(lv ?? "")}" placeholder="LV č." class="kn-lv" maxlength="20" title="Číslo listu vlastnictví">
      <input type="number" name="verified_sale_price_czk" min="0" step="1" value="${price ?? ""}" placeholder="kupní cena v Kč">
      <label class="kn-date">datum prodeje <input type="date" name="verified_sale_date" value="${esc(saleDate ?? "")}" title="Datum podpisu smlouvy nebo vkladu do katastru"></label>
      ${knBtn("record", "Uložit", "kn-btn--sold")}${verdict ? knBtn("reset", "Vrátit mezi nerozhodnuté", "kn-btn--later", price != null || saleDate ? RESET_CONFIRM : null) : ""}`
  );
  return `<details class="sale-section" id="prodej"${status !== "active" || hasData ? " open" : ""}>
      <summary><strong>🏛️ Prodej a katastr</strong> <span class="muted">— ${esc(stage)}</span></summary>
      <p class="muted">Cena, datum prodeje i podaný vklad znamenají, že je byt prodaný — appka ho tak označí všude (fronta Katastr, přehled, statistiky). Prázdné pole údaj smaže.</p>
      ${plomba}
      <p class="muted">${unitLine}</p>
      ${form}
    </details>`;
}

// Fronta "Kontrola v katastru" — zmizelé byty, u kterých appka neví, jestli
// se prodaly. Portály o tom po zmizení inzerátu nic neřeknou (viz
// sale-triage.js), jediná jistota je katastr; appka proto jen předřadí
// byty, u kterých je prodej nejpravděpodobnější, připraví údaje potřebné k
// nalezení bytu v katastru a zapíše výsledek ruční kontroly.
const KN_URL = "https://nahlizenidokn.cuzk.cz/";
const KN_RECHECK_DAYS = 7;

function renderKnQueue(db) {
  const entries = computeEntries(db).filter((e) => !e.hidden);
  const knActx = buildAddressContext(db, db.prepare("SELECT * FROM listings").all());
  const knScans = loadKnScans(db);
  const DAY = 24 * 60 * 60 * 1000;
  const checkedRecently = (e) => e.knCheckedAt && Date.now() - new Date(e.knCheckedAt).getTime() < KN_RECHECK_DAYS * DAY;
  const known = (e) => e.addressInfo.state === "known";
  const actionForm = knActionForm;
  const btn = knBtn;
  // Dnešní datum (místní) jako výchozí den podání vkladu.
  const todayLocal = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  // Co chceme z katastru zjistit: za kolik a kdy se byt prodal. Obojí
  // nepovinné — i samotné "Prodáno" je užitečné (viz POST /byt/:id/kn).
  // Předvyplněné tím, co už je zapsané (třeba v detailu bytu) — formuláře tu a
  // v detailu jsou dva pohledy na tytéž údaje.
  const saleFields = (e) =>
    `<input type="number" name="verified_sale_price_czk" min="0" step="1" value="${e.verifiedSalePrice ?? ""}" placeholder="kupní cena v Kč (nepovinné)"><label class="kn-date">datum prodeje <input type="date" name="verified_sale_date" value="${esc(e.verifiedSaleDate ?? "")}" title="Datum podpisu smlouvy nebo vkladu do katastru (nepovinné)"></label>`;
  const unitInput = (e) =>
    `<input type="text" name="unit_number" value="${esc(e.addressInfo.unit)}" placeholder="jednotka" class="kn-lv" maxlength="60" title="Číslo jednotky ve tvaru č.p./číslo, např. 412/12 — appka pak sama sleduje plombu na ní (nepovinné; je to totéž pole jako v detailu bytu)">`;
  const lvInput = (e) =>
    `<input type="text" name="lv_number" value="${esc(e.lvNumber)}" placeholder="LV č." class="kn-lv" maxlength="20" title="Číslo listu vlastnictví — příště stačí k.ú. + LV, bez dohledávání podle adresy (nepovinné)">`;

  // Fáze a rozvrh kontrol po rezervaci (viz kn-schedule.js): byt je ve frontě,
  // dokud není známá cena (nebo "neprodáno"). K vyřízení je, když nastal
  // kontrolní bod a po něm ještě nikdo nekontroloval.
  const inPipeline = entries.filter((e) => e.track && (e.track.stage === "filing" || e.track.stage === "price"));
  const dueNow = inPipeline.filter((e) => e.track.due && known(e)).sort((a, b) => a.track.dueAt - b.track.dueAt);
  const waiting = inPipeline.filter((e) => !e.track.due && !e.track.watched && !e.track.expired && known(e)).sort((a, b) => a.track.nextAt - b.track.nextAt);
  // Plomby hlídá API katastru — ruční kontrola nic nepřinese, ozve se samo.
  // Čerstvě zmizelý byt (do týdne) je nahoře a skupina je kvůli němu rozbalená:
  // zrovna o něm mohla přijít zpráva "možný prodej" a uživatel ho v Katastru hledá.
  const freshlyGone = (e) => Boolean(e.removedAt) && Date.now() - Date.parse(e.removedAt) < 7 * DAY;
  const watched = inPipeline
    .filter((e) => e.track.watched && !e.track.expired && known(e))
    .sort((a, b) => Number(freshlyGone(b)) - Number(freshlyGone(a)) || a.track.reservedAt.localeCompare(b.track.reservedAt));
  // Bez přesné adresy se byt v katastru dohledat nedá — takové byty jen
  // připomínáme, ať se adresa doplní, dokud je inzerát online.
  const noAddress = inPipeline.filter((e) => !e.track.expired && !known(e)).sort((a, b) => a.track.reservedAt.localeCompare(b.track.reservedAt));
  const expired = inPipeline.filter((e) => e.track.expired).sort((a, b) => b.track.reservedAt.localeCompare(a.track.reservedAt));
  // Zmizelé byty BEZ rezervace — o prodeji nic nenaznačuje, řadí je odhad
  // pravděpodobnosti (sale-triage.js). Do rozvrhu nepatří.
  const otherRemoved = entries
    .filter((e) => e.status === "removed" && !e.saleVerdict && !e.track)
    .sort(
      (a, b) =>
        (checkedRecently(a) ? 1 : 0) - (checkedRecently(b) ? 1 : 0) ||
        b.triage.score - a.triage.score ||
        (b.removedAt || "").localeCompare(a.removedAt || "")
    );
  // Plomba po zmizení bytu, kterou appka sama nepřiřadila (viz apiWatch) — k
  // potvrzení; "Zatím nic" ji odloží, dokud nepřijde novější.
  const confirmNeeded = (e) =>
    Boolean(e.unreservedWatch?.needsConfirm) && !(e.knCheckedAt && e.unreservedWatch.confirmAt <= Date.parse(e.knCheckedAt));
  // Dům se hlídá a nic se nenašlo: ruční kontrola nic nepřinese. Dům bez
  // jednotek (družstevní) hlídat nejde, ten zůstává mezi ručními.
  const otherWatched = otherRemoved.filter((e) => e.unreservedWatch && !e.unreservedWatch.unverifiable && !confirmNeeded(e));
  const otherManual = otherRemoved.filter((e) => !otherWatched.includes(e) && !e.unreservedWatch?.unverifiable).sort((a, b) => Number(confirmNeeded(b)) - Number(confirmNeeded(a)));
  // Jen výsledky zapsané touhle frontou — "Prodáno" z Telegramu se tu
  // zobrazovat nemá. Byt ve fázi "cena" (vklad podán) ještě hotový není.
  // Byt, který v katastru nejde ověřit (družstevní, nebo dům bez vymezených
  // jednotek): vklad tu nevznikne, nic se nedá dohledat, takže nemá smysl ho
  // hlídat ani připomínat — je vyřízený.
  const notVerifiable = (e) => Boolean(e.track?.stage === "done" && e.track.unverifiable && !e.track.priceAssumed) || Boolean(e.unreservedWatch?.unverifiable);
  const done = entries
    .filter((e) => notVerifiable(e) || e.track?.priceAssumed || (e.saleVerdict && e.g.members.some((m) => m.sale_verdict) && e.track?.stage !== "price"))
    .sort((a, b) => (b.knCheckedAt || "").localeCompare(a.knCheckedAt || ""));

  // Údaje, podle kterých se byt v katastru hledá: přesná adresa zapsaná
  // uživatelem (vč. jednotky) má přednost před přibližným místem z inzerátu;
  // bez ní appka řekne, že hledat bude muset jen podle odhadu. K tomu
  // katastrální území (a údaje o domě) z RÚIAN — v katastru se byt hledá
  // podle k.ú. + čísla popisného, ne podle názvu města — a číslo LV, když ho
  // uživatel při první kontrole zapsal.
  const lookupFor = (e) => {
    const specs = [e.rep.disposition, e.rep.area_m2 ? `${e.rep.area_m2} m²` : null, e.params.floorInfo].filter(Boolean).join(" · ");
    const ai = e.addressInfo;
    const place =
      ai.state === "known"
        ? [ai.exact, ai.unit ? `jednotka ${ai.unit}` : null].filter(Boolean).join(", ")
        : `${e.address || e.city || ""} (${ai.state === "unknown" ? "přesná adresa neznámá" : "jen přibližně — přesná adresa nebyla zapsána"})`;
    const ag = knActx.groups.find((g) => g.members.some((m) => m.id === e.rep.id));
    const kn = ag ? knInfoForGroup(knActx, ag, resolveForGroup(knActx, ag)) : null;
    const lookup = [place, kn ? `k.ú. ${kn.ku.nazev} [${kn.ku.kod}]` : null, e.lvNumber ? `LV ${e.lvNumber}` : null, specs].filter(Boolean).join(" — ");
    const houseFacts = kn?.building
      ? ` <span class="muted">(dům: č.p. ${esc(kn.building.cp.join(", "))}${kn.building.floors ? `, ${kn.building.floors} podlaží` : ""}${kn.building.flats ? `, ${kn.building.flats} bytů` : ""})</span>`
      : "";
    return { lookup, houseFacts, buildingId: kn?.building?.isknId ?? null };
  };

  // Časová osa bytu v jedné větě: co se kdy stalo.
  const timeline = (e) => {
    const t = e.track;
    const parts = [t.unreserved ? "Bez rezervace" : `Rezervováno od ${formatDateOnly(t.reservedAt)} (${t.ageDays} dní)`];
    if (e.removedAt) parts.push(`inzerát zmizel ${formatDateOnly(e.removedAt)}`);
    if (e.knFiledAt) parts.push(`vklad podán ${formatDateOnly(e.knFiledAt)}`);
    if (e.plombaEnd) parts.push(`plomba ${Date.parse(e.plombaEnd) <= Date.now() ? "skončila" : "do"} ${formatDateOnly(e.plombaEnd)}`);
    if (e.knCheckedAt) parts.push(`naposledy zkontrolováno ${formatDateOnly(e.knCheckedAt)}`);
    return esc(parts.join(" · "));
  };

  // Co o domě ví API katastru (kn-scan.js) — viz renderPlombaBlock.
  const plombaBlock = (e, buildingId) => renderPlombaBlock(e, buildingId ? knScans.get(buildingId) : null);

  // Tělo karty: kde hledat + formulář podle fáze. Ve fázi "filing" se zapisuje
  // buď podaný vklad (prodej potvrzený, cena později), nebo rovnou cena.
  const cardBody = (e) => {
    const encId = encodeURIComponent(e.rep.id);
    const t = e.track;
    const { lookup, houseFacts, buildingId } = lookupFor(e);
    const forms =
      t.stage === "price"
        ? actionForm(encId, `${lvInput(e)}${unitInput(e)}<label class="kn-date">vklad podán <input type="date" name="kn_filed_at" value="${esc(e.knFiledAt ?? "")}" title="Den podání vkladu — jde opravit"></label><label class="kn-date">konec plomby <input type="date" name="kn_plomba_end" value="${esc(e.plombaEnd ?? "")}" title="Kdy plomba (řízení o vkladu) končí nebo skončila — po něm jde v katastru zjistit kupní cenu. Můžeš zadat i budoucí termín; prázdné pole ho smaže."></label>${btn("plomba", "Uložit konec plomby", "kn-btn--later")}${saleFields(e)}${btn("sold", "Cena zjištěna", "kn-btn--sold")}${btn("check", "Zatím nic", "kn-btn--later")}${btn("reset", "Zrušit „vklad podán“", "kn-btn--later")}`)
        : actionForm(
            encId,
            `${lvInput(e)}${unitInput(e)}<label class="kn-date">vklad podán <input type="date" name="kn_filed_at" value="${todayLocal}" title="Den, kdy byl v katastru podán návrh na vklad — plomba (nepovinné, výchozí dnes)"></label>${btn("filed", "Vklad podán", "kn-btn--sold")}${btn("check", "Zatím nic", "kn-btn--later")}${btn("withdrawn", "Neprodáno", "")}`
          ) +
          `<details class="kn-direct"><summary>Znám rovnou cenu</summary>${actionForm(encId, `${saleFields(e)}${btn("sold", "Prodáno", "kn-btn--sold")}`)}</details>`;
    return `<div class="kn-lookup"><strong>Do katastru:</strong> ${esc(lookup)}${houseFacts}</div>
        <div class="muted">${timeline(e)}</div>
        ${plombaBlock(e, buildingId)}
        ${forms}`;
  };

  const dueCard = (e) => {
    const encId = encodeURIComponent(e.rep.id);
    return `<div class="kn-item">
        <div class="kn-head">
          <a href="/byt/${encId}">${esc(cardTitle(e.rep, e.address, e.priceLabel))}</a>
          <span class="kn-level kn-level--${e.track.stage === "price" ? "likely" : "possible"}">${esc(e.track.reason)}</span>
        </div>
        ${cardBody(e)}
      </div>`;
  };

  const waitingItem = (e) => {
    const encId = encodeURIComponent(e.rep.id);
    const stage = e.track.stage === "price" ? `vklad podán, čeká na cenu${e.plombaEnd ? `; plomba ${Date.parse(e.plombaEnd) <= Date.now() ? "skončila" : "do"} ${formatDateOnly(e.plombaEnd)}` : ""}` : "čeká na vklad";
    return `<details class="kn-wait">
        <summary><a href="/byt/${encId}">${esc(cardTitle(e.rep, e.address, e.priceLabel))}</a> <span class="muted">— ${stage}; další kontrola ${esc(formatDateOnly(new Date(e.track.nextAt).toISOString()))}</span></summary>
        <div class="kn-item kn-item--wait">${cardBody(e)}</div>
      </details>`;
  };

  const watchedItem = (e) => {
    const encId = encodeURIComponent(e.rep.id);
    const scan = lookupFor(e).buildingId ? knScans.get(lookupFor(e).buildingId) : null;
    const note = e.track.unverifiable
      ? "dům nemá v katastru jednotky (družstevní?) — nejde ověřit"
      : `${e.removedAt ? `inzerát zmizel ${formatDateOnly(e.removedAt)}; ` : ""}čeká na plombu; API katastru naposledy ${scan ? formatKnDay(scan.scannedAt) : "—"}`;
    return `<details class="kn-wait">
        <summary><a href="/byt/${encId}">${esc(cardTitle(e.rep, e.address, e.priceLabel))}</a> <span class="muted">— ${esc(note)}</span></summary>
        <div class="kn-item kn-item--wait">${cardBody(e)}</div>
      </details>`;
  };

  const noAddressRows = noAddress
    .map(
      (e) =>
        `<li><a href="/byt/${encodeURIComponent(e.rep.id)}">${esc(cardTitle(e.rep, e.address, e.priceLabel))}</a> <span class="muted">— ${
          e.track.stage === "price"
            ? "prodáno, cenu jde v katastru ověřit až s přesnou adresou (doplň ji v detailu)"
            : `rezervováno ${e.track.ageDays} dní${e.status === "removed" ? ", inzerát už zmizel (adresu jde doplnit jen ručně v detailu)" : ", doplň přesnou adresu"}`
        }</span></li>`
    )
    .join("");

  const expiredRows = expired
    .map((e) => {
      const encId = encodeURIComponent(e.rep.id);
      return `<li><a href="/byt/${encId}">${esc(cardTitle(e.rep, e.address, e.priceLabel))}</a> <span class="muted">— ${
        e.track.stage === "price" ? "vklad podán, cena nezjištěna" : "vklad se nenašel"
      } (rezervováno ${esc(formatDateOnly(e.track.reservedAt))})</span> ${actionForm(encId, btn("reset", "Vrátit do fronty", "kn-btn--later"))}</li>`;
    })
    .join("");

  const otherCard = (e) => {
      const encId = encodeURIComponent(e.rep.id);
      const { lookup, houseFacts, buildingId } = lookupFor(e);
      const t = e.triage;
      const scan = e.unreservedWatch && buildingId ? knScans.get(buildingId) : null;
      const plomba = scan ? renderPlombaBlock({ ...e, track: { reservedAt: e.removedAt, unreserved: true } }, scan) : "";
      const checked = e.knCheckedAt ? ` · naposledy zkontrolováno ${esc(formatDateOnly(e.knCheckedAt))}` : "";
      return `<div class="kn-item${checkedRecently(e) ? " kn-item--checked" : ""}">
        <div class="kn-head">
          <a href="/byt/${encId}">${esc(cardTitle(e.rep, e.address, e.priceLabel))}</a>
          <span class="kn-level kn-level--${t.level}">${esc(SALE_LEVEL_LABELS[t.level])}</span>
        </div>
        <div class="kn-lookup"><strong>Do katastru:</strong> ${esc(lookup)}${houseFacts}</div>
        <div class="muted">Zmizel ${esc(formatDateOnly(e.removedAt))} · ${esc(t.reasons.join(" · ") || "bez zvláštního signálu")}${checked}</div>
        ${plomba}
        ${actionForm(encId, `${saleFields(e)}${btn("sold", "Prodáno", "kn-btn--sold")}${btn("withdrawn", "Neprodáno", "")}${btn("check", "Zatím nic", "kn-btn--later")}`)}
      </div>`;
  };
  const otherItems = otherManual.map(otherCard).join("");
  const otherWatchedItems = otherWatched
    .map((e) => {
      const scan = lookupFor(e).buildingId ? knScans.get(lookupFor(e).buildingId) : null;
      return `<details class="kn-wait">
        <summary><a href="/byt/${encodeURIComponent(e.rep.id)}">${esc(cardTitle(e.rep, e.address, e.priceLabel))}</a> <span class="muted">— zmizel ${esc(formatDateOnly(e.removedAt))}; API katastru naposledy ${scan ? formatKnDay(scan.scannedAt) : "—"}, plomba zatím není</span></summary>
        ${otherCard(e)}
      </details>`;
    })
    .join("");

  const doneRows = done
    .map((e) => {
      const encId = encodeURIComponent(e.rep.id);
      const unverifiableOnly = notVerifiable(e);
      const verdictText = unverifiableOnly ? "Nejde ověřit v katastru" : e.saleVerdict === "withdrawn" ? "Neprodáno" : "Prodáno";
      const facts = unverifiableOnly
        ? [
            e.removedAt ? `inzerát zmizel ${formatDateOnly(e.removedAt)}` : e.status === "reserved" ? "rezervováno" : null,
            "dům nemá v katastru jednotky nebo je byt družstevní — prodej ani cenu z katastru nezjistíme",
            e.price != null && e.almostSold
              ? `ve statistikách se počítá poslední cena ${formatCzk(e.price)} −${Math.round(ASSUMED_PRICE_DISCOUNT * 100)} % (${formatCzk(assumedSalePrice(e.price))})`
              : null,
          ].filter(Boolean)
        : [
        e.verifiedSalePrice != null ? formatCzk(e.verifiedSalePrice) : null,
        e.track?.priceAssumed && e.verifiedSalePrice == null ? `poslední cena z portálu ${formatCzk(e.price)}, v katastru nejde ověřit — ve statistikách −${Math.round(ASSUMED_PRICE_DISCOUNT * 100)} % (${formatCzk(assumedSalePrice(e.price))})` : null,
        e.verifiedSaleDate ? `prodáno ${formatDateOnly(e.verifiedSaleDate)}` : null,
        e.knFiledAt ? `vklad podán ${formatDateOnly(e.knFiledAt)}` : null,
        e.lvNumber ? `LV ${e.lvNumber}` : null,
        e.knCheckedAt ? `zkontrolováno ${formatDateOnly(e.knCheckedAt)}` : null,
      ].filter(Boolean);
      return `<li><a href="/byt/${encId}">${esc(cardTitle(e.rep, e.address, e.priceLabel))}</a> — ${esc(verdictText)}${
        facts.length ? ` <span class="muted">(${esc(facts.join(" · "))})</span>` : ""
      } ${
        e.track?.priceAssumed || unverifiableOnly
          ? `<details class="kn-direct"><summary>Znám skutečnou cenu</summary>${actionForm(encId, `${saleFields(e)}${btn("sold", "Zadat cenu", "kn-btn--sold")}`)}</details>`
          : actionForm(encId, btn("reset", "Vrátit do fronty", "kn-btn--later", e.verifiedSalePrice != null || e.verifiedSaleDate ? RESET_CONFIRM : null))
      }</li>`;
    })
    .join("");

  // Jak to u tebe obvykle trvá — z vlastních dat, ať jde rozvrh časem doladit.
  const lags = entries.map((e) => (e.track && e.knFiledAt ? filingLagDays(e.track.reservedAt, e.knFiledAt) : null)).filter((v) => v != null);
  const lagNote = lags.length
    ? `<p class="muted">Z tvých dat: od rezervace k podání vkladu medián ${median(lags)} dní (${lags.length} ${lags.length === 1 ? "byt" : lags.length < 5 ? "byty" : "bytů"}, ${Math.min(...lags)}–${Math.max(...lags)} dní). Rozvrh výš je zatím nastavený odhadem — z těchhle čísel půjde doladit.</p>`
    : "";
  const nextUp = waiting[0];

  return `
    <h1>Kontrola v katastru</h1>
    <p class="muted">
      Po rezervaci trvá, než se prodej v <a href="${KN_URL}" target="_blank" rel="noopener">katastru nemovitostí</a> vůbec
      ukáže — kupec s hotovostí podá návrh na vklad za 1–3 týdny, s hypotékou za 6–12 týdnů. Appka proto připomíná kontrolu
      jen ve chvílích, kdy má smysl, a ne po pevných týdnech.
    </p>
    <details class="kn-done"><summary>Jak appka plánuje kontroly</summary>
      <ul>
        <li><strong>Hlídá API katastru:</strong> u domů, které appka sama prochází přes API, se ruční kontrola nepřipomíná — ozve se, až najde plombu (a buď ji sama přiřadí k bytu, nebo tě požádá o potvrzení). Rozvrh níž platí jen tam, kam API nedosáhne: dům ještě bez kontroly, data starší než 8 dní, nebo byt bez přesné adresy.</li>
        <li><strong>Hotovostní kupec:</strong> 14. a 28. den od rezervace.</li>
        <li><strong>Hypotéka:</strong> od 45. do 100. dne jednou týdně, potom jednou měsíčně do půl roku — pak „nezjištěno“.</li>
        <li><strong>Inzerát zmizel:</strong> kontrola za 3 a za 10 dní (inzerát se stahuje často kolem podpisu smlouvy).</li>
        <li><strong>Vklad podán (plomba):</strong> prodej je potvrzený; cena se hledá od 25. dne po podání (rozhodnutí o vkladu bývá do měsíce), pak týdně.</li>
      </ul>
    </details>

    <h2 id="kontrola">Zkontrolovat teď (${dueNow.length})</h2>
    <div class="kn-list">${
      dueNow.map(dueCard).join("") ||
      `<p class="empty">Nic ke kontrole.${watched.length ? " Plomby hlídá appka sama přes API katastru (viz níž)." : ""}${nextUp ? ` Další kontrola: ${esc(formatDateOnly(new Date(nextUp.track.nextAt).toISOString()))} — ${esc(cardTitle(nextUp.rep, nextUp.address, nextUp.priceLabel))}.` : ""}</p>`
    }</div>
    ${watched.length ? `<details class="kn-done"${watched.some(freshlyGone) ? " open" : ""}><summary>Hlídá appka přes API katastru (${watched.length})</summary>${watched.map(watchedItem).join("")}</details>` : ""}
    ${waiting.length ? `<details class="kn-done"${waiting.some((e) => e.track.stage === "price") ? " open" : ""}><summary>Čeká na další kontrolu (${waiting.length})</summary>${waiting.map(waitingItem).join("")}</details>` : ""}
    ${
      noAddressRows
        ? `<details class="kn-done" open><summary>Bez přesné adresy (${noAddress.length})</summary><p class="muted">Bez adresy je v katastru nejde dohledat — doplň ji, dokud je inzerát online.</p><ul>${noAddressRows}</ul></details>`
        : ""
    }
    ${expiredRows ? `<details class="kn-done"><summary>Nezjištěno (${expired.length})</summary><ul>${expiredRows}</ul></details>` : ""}
    ${lagNote}

    <h2>Zmizelé byty bez rezervace (${otherManual.length})</h2>
    <p class="muted">
      Zmizely z nabídky a nic nenasvědčuje prodeji — portály o tom po zmizení inzerátu nic neříkají, jistota je jen
      katastr. Nahoře jsou ty, u kterých je prodej nejpravděpodobnější (odhad podle historie bytu, ne jistota); do rozvrhu
      kontrol nepatří. U bytů s přesnou adresou je prochází i API katastru (${UNRESERVED_HORIZON_DAYS} dní po zmizení): plomba se
      ukáže na kartě, a kde ji API nenašlo, byt leží ve sbalené skupině níž.
    </p>
    <div class="kn-list">${otherItems || `<p class="empty">Nic ke kontrole.</p>`}</div>
    ${otherWatchedItems ? `<details class="kn-done"><summary>Zmizelé byty, které hlídá API katastru (${otherWatched.length})</summary>${otherWatchedItems}</details>` : ""}
    ${doneRows ? `<details class="kn-done"><summary>Vyřízené (${done.length})</summary><ul>${doneRows}</ul></details>` : ""}`;
}

function serveStatic(res, filePath, contentType) {
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  // Bez tohohle prohlížeč klidně nechá starý app.js/style.css ležet v cache
  // napříč dny (appka se mění průběžně, žádné cache-busting jméno souboru
  // ani verzování) — reálně zažito: fix skoku nahoru stránky fungoval na
  // serveru, ale v prohlížeči doběhl jen po tvrdém refreshi, protože si
  // prohlížeč držel předchozí verzi app.js. `no-cache` (ne `no-store`)
  // ať se dá ještě validovat přes podmíněný request, místo úplného zákazu.
  res.writeHead(200, { "Content-Type": contentType, "Cache-Control": "no-cache" });
  createReadStream(filePath).pipe(res);
}

function parseBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      const params = new URLSearchParams(data);
      resolve(Object.fromEntries(params));
    });
  });
}

// Appka se mění průběžně (data i kód) a stránky jsou vždy čerstvě
// vyrenderované z aktuální DB — bez `no-store` by si prohlížeč klidně
// mohl ponechat včerejší snímek tabulky/statistik v cache a nikdy ho
// neobnovit, i když DB mezitím dostala nové inzeráty (reálně zažito:
// nahlášený "chybějící" byt appka evidovala v pořádku, jen ho prohlížeč
// ukazoval ze staré verze stránky).
function sendHtml(res, status, html) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(html);
}

const db = openDb();

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === "/style.css") {
    return serveStatic(res, path.join(import.meta.dirname, "public", "style.css"), "text/css");
  }
  if (url.pathname === "/app.js") {
    return serveStatic(res, path.join(import.meta.dirname, "public", "app.js"), "text/javascript");
  }
  if (url.pathname.startsWith("/photos/")) {
    const rel = decodeURIComponent(url.pathname.replace("/photos/", ""));
    const filePath = path.join(DATA_DIR, "photos", rel);
    if (!filePath.startsWith(path.join(DATA_DIR, "photos"))) {
      res.writeHead(400);
      return res.end("Bad path");
    }
    const ext = path.extname(filePath).toLowerCase();
    const type = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
    return serveStatic(res, filePath, type);
  }

  if (url.pathname === "/" && req.method === "GET") {
    const filters = {
      status: url.searchParams.get("status") || null,
      sort: url.searchParams.get("sort") || "newest",
      city: url.searchParams.get("city") || null,
      ownership: url.searchParams.get("ownership") || null,
      top: url.searchParams.get("top") || null,
      hidden: url.searchParams.get("hidden") || null,
      adresa: url.searchParams.get("adresa") || null,
    };
    return sendHtml(res, 200, layout("Trh bytů", renderTable(db, filters)));
  }

  if (url.pathname === "/tabulka" && req.method === "GET") {
    const filters = {
      status: url.searchParams.get("status") || null,
      city: url.searchParams.get("city") || null,
      sort: url.searchParams.get("sort") || null,
      cols: url.searchParams.get("cols") === "all" ? "all" : null,
    };
    return sendHtml(res, 200, layout("Srovnání — Trh bytů", renderComparisonTable(db, filters), { wide: true }));
  }

  if (url.pathname === "/upozorneni" && req.method === "GET") {
    return sendHtml(res, 200, layout("Upozornění — Trh bytů", renderNotifications(db, url.searchParams.get("typ"))));
  }

  if (url.pathname === "/upozorneni/precteno" && req.method === "POST") {
    markNotificationsSeen(db);
    res.writeHead(302, { Location: "/upozorneni" });
    return res.end();
  }

  if (url.pathname === "/kontrola" && req.method === "GET") {
    return sendHtml(res, 200, layout("Kontrola v katastru — Trh bytů", renderKnQueue(db)));
  }

  // Přesná adresa bytu (viz db.js exact_address, detail bytu). `save` zapíše
  // adresu a jednotku (prázdné obojí = vymazat i příznak "neznámá"),
  // `unknown` označí, že uživatel nabídku prošel a adresu nezjistil —
  // vymaže případný rozepsaný text, ať stav "neznámá" nemůže být s adresou
  // současně. Zapisuje se na VŠECHNY členy skupiny (stejná úvaha jako u
  // /notes).
  const adresaMatch = url.pathname.match(/^\/byt\/([^/]+)\/adresa$/);
  if (adresaMatch && req.method === "POST") {
    const id = decodeURIComponent(adresaMatch[1]);
    const fields = await parseBody(req);
    const mode = fields.mode;
    const group = mode === "save" || mode === "unknown" || mode === "auto" ? findGroupForListing(db.prepare("SELECT * FROM listings").all(), id) : null;
    if (group) {
      const clean = (v, max) => (v || "").replace(/\s+/g, " ").trim().slice(0, max) || null;
      const wasAuto = group.members.some((m) => m.address_auto === 1);
      let updates;
      if (mode === "unknown") {
        updates = { exact_address: null, unit_number: null, address_unknown: 1, address_auto: 0 };
      } else if (mode === "auto") {
        // "Zkusit znovu automaticky" — zruší ruční stav (neznámá / smazáno) a
        // nechá automat adresu znovu vyhodnotit.
        updates = { exact_address: null, address_unknown: null, address_auto: null };
      } else {
        const exact = clean(fields.exact_address, 200);
        const unit = clean(fields.unit_number, 60);
        // Ruční uložení vždy bere adresu z rukou automatu (address_auto = 0).
        // Smazání adresy, kterou doplnil automat, ho navíc vypne (-1) —
        // jinak by ji při příštím běhu doplnil znovu.
        updates = { exact_address: exact, unit_number: unit, address_unknown: 0, address_auto: !exact && !unit && wasAuto ? -1 : 0 };
      }
      for (const m of group.members) updateListingFields(db, m.id, updates);
      if (mode === "auto") applyAutoAddresses(db, () => {});
      // Právě zapsanou adresu hned ověřit v RÚIAN (k.ú. + dům), ať se údaje
      // v detailu ukážou ihned; při výpadku služby je doplní příští sběr.
      if (mode === "save" && updates.exact_address) {
        const parsed = parseExactAddress(updates.exact_address);
        if (parsed) {
          const key = addressKey(parsed.street, parsed.number, parsed.city);
          if (!db.prepare("SELECT 1 FROM ruian_cache WHERE key = ?").get(key)) {
            try {
              saveRuian(db, key, await ruianLookupAddress(parsed.street, parsed.number, parsed.city));
            } catch {
              // Služba nedostupná — doplní se při příštím sběru (ruianPending).
            }
          }
        }
        // Dům nově zapsané adresy hned projít přes API katastru (viz výš).
        // Čeká se nejvýš pár vteřin, ať stránka po přesměrování rovnou ukáže
        // výsledek; delší kontrola doběhne na pozadí.
        await Promise.race([refreshKnScansNow(db), new Promise((resolve) => setTimeout(resolve, 8000))]);
      }
    }
    res.writeHead(302, { Location: req.headers.referer || `/byt/${encodeURIComponent(id)}` });
    return res.end();
  }

  // Výsledek ruční kontroly bytu v katastru (viz renderKnQueue). `sold` /
  // `withdrawn` zapíšou verdikt, `check` jen odsune byt ve frontě dolů,
  // `reset` verdikt zruší. Zapisuje se na VŠECHNY členy skupiny (stejná
  // úvaha jako u /notes).
  const knMatch = url.pathname.match(/^\/byt\/([^/]+)\/kn$/);
  if (knMatch && req.method === "POST") {
    const id = decodeURIComponent(knMatch[1]);
    const fields = await parseBody(req);
    const action = fields.action;
    const group = ["filed", "unit", "sold", "withdrawn", "check", "reset", "record", "plomba"].includes(action) ? findGroupForListing(db.prepare("SELECT * FROM listings").all(), id) : null;
    if (group) {
      const now = nowIso();
      const today = now.slice(0, 10);
      const isDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || "") && !Number.isNaN(Date.parse(v));
      // Fronta Katastr: prázdné pole = beze změny (nic se jím nemaže). Detail
      // bytu (action "record") je naopak editor všech údajů: prázdné pole
      // údaj smaže. Samotná pravidla jsou v sale-record.js.
      const given = (v) => (v == null || String(v).trim() === "" ? undefined : v);
      const current = currentSaleState(group.members);
      let input = null;
      if (action === "reset") {
        input = { reset: true };
      } else if (action === "plomba") {
        // Jen konec plomby (řízení o vkladu): prázdné pole ho smaže.
        input = { plombaEnd: fields.kn_plomba_end ?? "" };
      } else if (action === "check") {
        input = { checked: true, lv: given(fields.lv_number), unit: given(fields.unit_number) };
      } else if (action === "withdrawn") {
        input = { verdict: "withdrawn", lv: given(fields.lv_number), unit: given(fields.unit_number) };
      } else if (action === "filed") {
        // Podaný návrh na vklad (plomba): prodej je potvrzený, cena se zjistí
        // až po rozhodnutí o vkladu (viz kn-schedule.js, fáze "price"). Den
        // podání nesmí být v budoucnu — výchozí je dnešek.
        input = { verdict: "sold", filedAt: isDay(fields.kn_filed_at) ? fields.kn_filed_at : today, lv: given(fields.lv_number), unit: given(fields.unit_number) };
      } else if (action === "unit") {
        // "To je ten byt" z nápovědy API katastru: zapíše jednotku (od teď ji
        // appka sleduje sama) a vklad podán. Už zapsaný den podání nepřepíše.
        const unitNumber = parseUnitNumber(fields.unit_number);
        if (unitNumber != null) {
          input = {
            verdict: "sold",
            unit: formatUnitNumber(unitNumber),
            filedAt: current.filedAt ? undefined : isDay(fields.kn_filed_at) ? fields.kn_filed_at : today,
            lv: given(fields.lv_number),
          };
        }
      } else if (action === "sold") {
        input = {
          verdict: "sold",
          price: given(fields.verified_sale_price_czk),
          saleDate: given(fields.verified_sale_date),
          filedAt: given(fields.kn_filed_at),
          lv: given(fields.lv_number),
          unit: given(fields.unit_number),
        };
      } else {
        input = { filedAt: fields.kn_filed_at, plombaEnd: fields.kn_plomba_end, lv: fields.lv_number, price: fields.verified_sale_price_czk, saleDate: fields.verified_sale_date };
      }
      const updates = input ? buildSaleRecordUpdates({ input, current, now }) : {};
      if (Object.keys(updates).length) for (const m of group.members) updateListingFields(db, m.id, updates);
    }
    res.writeHead(302, { Location: req.headers.referer || "/kontrola" });
    return res.end();
  }

  if (url.pathname === "/stats" && req.method === "GET") {
    return sendHtml(res, 200, layout("Statistiky — Trh bytů", renderStats(db)));
  }

  const detailMatch = url.pathname.match(/^\/byt\/([^/]+)$/);
  if (detailMatch && req.method === "GET") {
    const id = decodeURIComponent(detailMatch[1]);
    const body = renderDetail(db, id);
    if (!body) {
      return sendHtml(res, 404, layout("Nenalezeno", "<p>Byt nenalezen.</p>"));
    }
    return sendHtml(res, 200, layout("Byt — Trh bytů", body));
  }

  const calcMatch = url.pathname.match(/^\/byt\/([^/]+)\/kalkulacka$/);
  if (calcMatch && req.method === "GET") {
    const id = decodeURIComponent(calcMatch[1]);
    const allListings = db.prepare("SELECT * FROM listings").all();
    const group = findGroupForListing(allListings, id);
    if (!group) {
      return sendHtml(res, 404, layout("Nenalezeno", "<p>Byt nenalezen.</p>"));
    }
    const rep = primaryListing(group.members);
    const inputs = parseFlipQuery(url.searchParams, rep);
    const result = calculateFlip(inputs);
    return sendHtml(res, 200, layout("Kalkulačka marže — Trh bytů", renderFlipCalculator(rep, inputs, result)));
  }

  // TOP (hvězdička) a Skrýt (křížek) jsou prosté toggly — přečti si
  // aktuální hodnotu a přehoď ji. Uloženo na LISTING, do kterého ukazuje
  // ID v URL (tj. primaryListing skupiny v okamžiku vykreslení stránky,
  // ze které se kliklo) — čtení je pak robustnější přes isStarred/isHidden
  // nad celou skupinou (viz group.js), takže se příznak "neztratí", i
  // kdyby se mezitím přerovnalo pořadí SOURCE_PRIORITY pro tu nemovitost.
  const starMatch = url.pathname.match(/^\/byt\/([^/]+)\/star$/);
  if (starMatch && req.method === "POST") {
    const id = decodeURIComponent(starMatch[1]);
    const row = db.prepare("SELECT starred FROM listings WHERE id = ?").get(id);
    if (row) db.prepare("UPDATE listings SET starred = ? WHERE id = ?").run(row.starred ? 0 : 1, id);
    res.writeHead(302, { Location: req.headers.referer || "/" });
    return res.end();
  }

  const hideMatch = url.pathname.match(/^\/byt\/([^/]+)\/hide$/);
  if (hideMatch && req.method === "POST") {
    const id = decodeURIComponent(hideMatch[1]);
    const row = db.prepare("SELECT hidden FROM listings WHERE id = ?").get(id);
    if (row) db.prepare("UPDATE listings SET hidden = ? WHERE id = ?").run(row.hidden ? 0 : 1, id);
    res.writeHead(302, { Location: req.headers.referer || "/" });
    return res.end();
  }

  // Vlastní poznámky a hodnocení (notes, ověřená prodejní cena/datum, viz
  // detail; own_condition/own_construction/own_revitalized, viz tabulka
  // srovnání) — JEDEN endpoint pro obě stránky, PARTIAL update: aktualizuje
  // se jen to pole, které tělo požadavku opravdu nese (detail posílá
  // všechno najednou z jednoho <form>, tabulka posílá jedno pole na
  // auto-submit <select>/<input>) — chybějící pole se NEpřepisuje na NULL,
  // jinak by uložení jednoho pole z tabulky smazalo zbytek. Zapisuje se na
  // VŠECHNY členy skupiny (ne jen na ID v URL), stejná úvaha jako u
  // isStarred/isHidden — přežije to i budoucí přerovnání SOURCE_PRIORITY.
  const notesMatch = url.pathname.match(/^\/byt\/([^/]+)\/notes$/);
  if (notesMatch && req.method === "POST") {
    const id = decodeURIComponent(notesMatch[1]);
    const fields = await parseBody(req);
    const allListings = db.prepare("SELECT * FROM listings").all();
    const group = findGroupForListing(allListings, id);
    if (group) {
      const updates = {};
      if ("notes" in fields) updates.notes = fields.notes || null;
      if ("seller_motivation" in fields) updates.seller_motivation = fields.seller_motivation || null;
      // Plocha, adresa a dispozice jsou normálně auto-parsované (viz
      // parse.js/track.js), ale appka je odjinud nedopočítá vždy — ruční
      // doplnění se zapisuje přímo do stejných sloupců, na VŠECHNY členy
      // skupiny (stejně jako ostatní pole tady), aby to viděl každý čtenář
      // dat bez ohledu na to, kdo je zrovna primaryListing.
      if ("area_m2" in fields) updates.area_m2 = fields.area_m2 ? Number(fields.area_m2) : null;
      if ("address" in fields) updates.address = fields.address || null;
      if ("disposition" in fields) updates.disposition = fields.disposition || null;
      // Cena a datum prodeje: stejná pravidla jako ve frontě Katastr (sale-record.js)
      // — zadaná cena znamená prodáno, takže zapíše i verdikt.
      if ("verified_sale_price_czk" in fields || "verified_sale_date" in fields) {
        Object.assign(
          updates,
          buildSaleRecordUpdates({
            input: { price: fields.verified_sale_price_czk, saleDate: fields.verified_sale_date },
            current: currentSaleState(group.members),
            now: nowIso(),
          })
        );
      }
      for (const { column, options } of OWN_FIELDS) {
        if (!(column in fields)) continue;
        // Neplatná hodnota (ručně upravené URL apod.) se bere jako "vymazat",
        // ne jako by nedorazila — appka si žádnou cizí hodnotu nevymýšlí.
        updates[column] = options.some(([v]) => v === fields[column]) ? fields[column] : null;
      }
      for (const m of group.members) updateListingFields(db, m.id, updates);
    }
    res.writeHead(302, { Location: req.headers.referer || `/byt/${encodeURIComponent(id)}` });
    return res.end();
  }

  // Ruční doplnění/oprava PARAM_FIELDS (viz PARAM_OVERRIDE_FIELDS) — na
  // rozdíl od /notes to NEJSOU sloupce tabulky, ale klíče v JEDNOM JSON
  // sloupci (params_override_json), takže partial update znamená
  // READ→MERGE→WRITE: přečíst existující override (z primárního záznamu
  // skupiny — appka ho vždy zapisuje shodně na všechny členy, viz níž),
  // domíchat jen pole, která tenhle request opravdu nese, prázdnou hodnotou
  // smazat jen TEN klíč (ne celý override), a zapsat na VŠECHNY členy
  // skupiny (stejná úvaha jako u /notes).
  const paramsMatch = url.pathname.match(/^\/byt\/([^/]+)\/params$/);
  if (paramsMatch && req.method === "POST") {
    const id = decodeURIComponent(paramsMatch[1]);
    const fields = await parseBody(req);
    const allListings = db.prepare("SELECT * FROM listings").all();
    const group = findGroupForListing(allListings, id);
    if (group) {
      const rep = primaryListing(group.members);
      let override = {};
      try {
        override = rep.params_override_json ? JSON.parse(rep.params_override_json) : {};
      } catch {
        override = {};
      }
      // Hodnota shodná s tím, co říká portál / text inzerátu, přepsání není —
      // formulář v detailu posílá VŠECHNA pole předvyplněná zobrazenou
      // hodnotou, takže jinak by každé uložení zmrazilo i to, co uživatel
      // nezměnil, a pozdější opravy čtení inzerátů (nebo změna na portálu) by
      // se k bytu už nikdy nedostaly.
      const portal = mergePortalParams(group.members);
      for (const field of PARAM_OVERRIDE_FIELDS) {
        if (!(field.column in fields)) continue;
        const raw = fields[field.column]?.trim();
        const valid = field.type === "select" ? field.options.some(([v]) => v === raw) : Boolean(raw);
        if (valid && raw !== portal[field.column]) override[field.column] = raw;
        else delete override[field.column];
      }
      const json = Object.keys(override).length ? JSON.stringify(override) : null;
      for (const m of group.members) updateListingFields(db, m.id, { params_override_json: json });
    }
    res.writeHead(302, { Location: req.headers.referer || `/byt/${encodeURIComponent(id)}` });
    return res.end();
  }

  sendHtml(res, 404, layout("Nenalezeno", "<p>Stránka nenalezena.</p>"));
});

server.listen(PORT, () => {
  console.log(`Trh bytů běží na http://localhost:${PORT}`);
});
