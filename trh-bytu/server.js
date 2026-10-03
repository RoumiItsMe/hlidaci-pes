// Lokální prohlížecí appka — holý Node `http` server, žádná nová
// závislost (drží se filozofie repa). Server-rendered HTML, žádný build
// krok, žádný klientský framework. Spouští se ručně (`npm run sales-app`),
// na rozdíl od track.js NEBĚŽÍ na pozadí.

import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";
import { openDb, DATA_DIR, updateListingFields, nowIso } from "./db.js";
import { groupListings, primaryListing, mergedStatus, earliestListedAt, latestRemovedAt, priceDropSummary, findGroupForListing, pickDescription, mergeParams, bestAddress, bestPrice, bestPriceListing, byPriority, latestChange, isStarred, isHidden, pickOwnValue } from "./group.js";
import { PARAM_FIELDS, OWN_FIELDS, PARAM_OVERRIDE_FIELDS } from "./params.js";
import { extractCity, parsePriceNote } from "./parse.js";
import { calculateFlip, DEFAULT_FLIP_INPUTS } from "./flip-calculator.js";
import { getNotifications, getNotificationsSeenAt, markNotificationsSeen, countUnread } from "./notifications.js";
import { watches } from "../config.js";

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
  removed: { text: "Zmizelo z nabídky", color: "#6b7280" },
};
const EVENT_LABELS = {
  created: "Zaevidováno",
  price_change: "Změna ceny",
  reserved: "Označeno jako rezervováno",
  unreserved: "Rezervace zrušena",
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
  return e.status === "removed" && e.removedAt ? `${base} (staženo ${formatDateOnly(e.removedAt)})` : base;
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
    const opts = [`<option value="">—</option>`]
      .concat(field.options.map(([v, label]) => `<option value="${esc(v)}" ${currentValue === v ? "selected" : ""}>${esc(label)}</option>`))
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
<header><a href="/" class="brand">🏠 Trh bytů</a> <a href="/tabulka">🗂️ Srovnání</a> <a href="/stats">Statistiky</a>${bell}</header>
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
function buildQuery(current, overrides) {
  const merged = { ...current, ...overrides };
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(merged)) {
    if (v) params.set(k, v);
  }
  const qs = params.toString();
  return qs ? `/?${qs}` : "/";
}

// Výchozí řazení ve čtyřech skupinách za sebou:
//   1. novinka + TOP  2. novinka  3. TOP  4. ostatní
// ("novinka" = appka u bytu zaznamenala skutečnou událost, viz group.js
// latestChange, NEBO ho teprve nedávno objevila, viz FRESH_LISTING_DAYS).
// Uvnitř skupiny podle "aktivity" — novější z (kdy appka byt objevila,
// kdy poslední změna), viz entry.activityAt níž. Tohle pořadí platí jen
// pro "newest" (výchozí) řazení; u řazení podle ceny by míchání
// novinek/TOP dovnitř popřelo smysl "seřaď čistě podle ceny", který si
// uživatel explicitně zvolil.
//
// Čerstvě přidaný inzerát má jen událost "created", kterou latestChange
// záměrně nepočítá (není to změna, je to začátek historie) — bez téhle
// výjimky by proto spadl do "ostatních" a ležel pod KAŽDÝM bytem, který
// kdy měl nějakou změnu, třeba před měsícem (reálně zažito: nové nabídky
// z předchozího dne byly v přehledu na 27.–35. místě ze 66).
const FRESH_LISTING_DAYS = 7;
function isFreshListing(e) {
  return Date.now() - new Date(e.discoveredAt).getTime() < FRESH_LISTING_DAYS * 24 * 60 * 60 * 1000;
}
function defaultSortGroup(e) {
  return (e.change || isFreshListing(e) ? 0 : 2) + (e.starred ? 0 : 1);
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
    const removedAt = status === "removed" ? latestRemovedAt(g.members) : null;
    const { dropCount, originalPrice } = priceDropSummary(events);
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
  const { status: statusFilter, sort = "newest", city: cityFilter, ownership: ownershipFilter, top: topFilter, hidden: hiddenView } = filters;
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
    if (statusFilter) filtered = filtered.filter((e) => e.status === statusFilter);
  }
  if (cityFilter) filtered = filtered.filter((e) => e.city === cityFilter);
  if (ownershipFilter) filtered = filtered.filter((e) => e.params.ownership === ownershipFilter);
  if (topFilter) filtered = filtered.filter((e) => e.starred);
  filtered = [...filtered].sort(SORTERS[sort] || SORTERS.newest);

  const current = { status: statusFilter, sort, city: cityFilter, ownership: ownershipFilter, top: topFilter, hidden: hiddenView };

  const filterLinks = ["", "active", "reserved", "removed"]
    .map((s) => {
      const label = s ? STATUS_LABELS[s].text : "Vše";
      const active = !showHidden && (statusFilter === s || (!statusFilter && !s)) ? "active" : "";
      // Klik na stavový filtr vždy opustí pohled "Skryté" — kombinace by
      // neměla smysl (skryté položky appka stavem netřídí).
      return `<a class="filter ${active}" href="${buildQuery(current, { status: s, hidden: null })}">${esc(label)}</a>`;
    })
    .join("");

  const topLink = `<a class="filter ${topFilter ? "active" : ""}" href="${buildQuery(current, { top: topFilter ? null : "1" })}">⭐ TOP</a>`;
  const hiddenLink = `<a class="filter ${showHidden ? "active" : ""}" href="${buildQuery(current, { hidden: showHidden ? null : "show", status: null })}">🚫 Skryté (${hiddenCount})</a>`;

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
    .map(({ g, rep, params, address, priceLabel: priceText_, status, firstSeenAt, change, changeWhere, starred, hidden, thumb }) => {
      const st = STATUS_LABELS[status] || { text: status, color: "#000" };
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
              <span class="badge" style="background:${st.color}">${esc(st.text)}</span>
              <span class="muted">${esc(sourceLabel)}${linkBadge}${reservedNote}${goneNote}${hiddenNote}</span>
            </div>
          </div>
        </a>
      </div>`;
    })
    .join("");

  return `
    <h1>Byty (${filtered.length})</h1>
    <div class="filters">${filterLinks}${topLink}${hiddenLink}</div>
    <div class="toolbar">
      <div class="filters">${sortLinks}</div>
      <form method="get" action="/" class="select-filters">
        <input type="hidden" name="status" value="${esc(statusFilter || "")}">
        <input type="hidden" name="sort" value="${esc(sort)}">
        <input type="hidden" name="top" value="${esc(topFilter || "")}">
        <input type="hidden" name="hidden" value="${esc(hiddenView || "")}">
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

function compareSortHeader(current, key, label) {
  const col = COMPARE_SORT_COLUMNS[key];
  const [curKey, curDir] = (current || "").split("_dir_");
  const isActive = curKey === key;
  // První klik na sloupec jede ve `firstDir`u, druhý klik na TENTÝŽ sloupec
  // směr otočí — třetí zase zpátky atd.
  const nextDir = isActive ? (curDir === "asc" ? "desc" : "asc") : col.firstDir;
  const arrow = isActive ? (curDir === "asc" ? " ↑" : " ↓") : "";
  return `<a class="compare-sort${isActive ? " active" : ""}" href="?sort=${key}_dir_${nextDir}">${esc(label)}${arrow}</a>`;
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
  const { status: statusFilter, city: cityFilter, sort: sortParam } = filters;
  const entries = computeEntries(db);

  const cityOptions = [...new Set(entries.map((e) => e.city).filter(Boolean))].sort((a, b) => a.localeCompare(b, "cs"));

  // Skryté (křížkem vyřazené) se z tabulky srovnání vylučují stejně jako z
  // hlavního přehledu — je to uživatelovo "tohle mě nezajímá".
  let filtered = entries.filter((e) => !e.hidden);
  if (statusFilter) filtered = filtered.filter((e) => e.status === statusFilter);
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

  const current = { status: statusFilter, city: cityFilter, sort: sortParam };
  const filterLinks = ["", "active", "reserved", "removed"]
    .map((s) => {
      const label = s ? STATUS_LABELS[s].text : "Vše";
      const active = statusFilter === s || (!statusFilter && !s) ? "active" : "";
      return `<a class="filter ${active}" href="${buildQuery(current, { status: s })}">${esc(label)}</a>`;
    })
    .join("");
  const cityOptionsHtml = [`<option value="">Všechna města</option>`]
    .concat(cityOptions.map((c) => `<option value="${esc(c)}" ${cityFilter === c ? "selected" : ""}>${esc(c)}</option>`))
    .join("");

  const rows = filtered
    .map((e) => {
      const encId = encodeURIComponent(e.rep.id);
      const st = STATUS_LABELS[e.status] || { text: e.status, color: "#000" };
      // column = sloupec v DB ("own_condition"...), value = odpovídající
      // předpočítaná hodnota entry (e.ownCondition...) — přímé mapování, ne
      // odvozování jednoho jména z druhého.
      const ownSelect = (column, value) =>
        `<form class="cell-form" method="post" action="/byt/${encId}/notes">${ownFieldSelectHtml(column, value, { autoSubmit: true })}</form>`;
      // Stejný vzorec jako ownSelect, jen jiný cíl (/params) a jiný
      // generátor pole (text i select, viz PARAM_OVERRIDE_FIELDS).
      const paramField = (column) =>
        `<form class="cell-form" method="post" action="/byt/${encId}/params">${paramOverrideFieldHtml(column, e.params[column], { autoSubmit: true })}</form>`;

      return `<tr class="${e.hidden ? "row--hidden" : ""}">
        <td><span class="badge small" style="background:${st.color}">${esc(st.text)}</span></td>
        <td><form class="cell-form" method="post" action="/byt/${encId}/notes"><input type="text" name="address" value="${esc(e.address || e.city)}" placeholder="adresa…" onchange="this.form.requestSubmit()"></form></td>
        <td><form class="cell-form" method="post" action="/byt/${encId}/notes"><input type="text" name="disposition" value="${esc(e.rep.disposition)}" placeholder="—" onchange="this.form.requestSubmit()"></form></td>
        <td><form class="cell-form" method="post" action="/byt/${encId}/notes"><input type="number" name="area_m2" value="${e.rep.area_m2 ?? ""}" step="0.1" placeholder="m²" onchange="this.form.requestSubmit()"></form></td>
        <td>${paramField("floorInfo")}</td>
        <td>${paramField("elevator")}</td>
        <td>${paramField("balcony")}</td>
        <td>${paramField("cellar")}</td>
        <td>${paramField("ownership")}</td>
        <td>${ownSelect("own_condition", e.ownCondition)}</td>
        <td>${ownSelect("own_construction", e.ownConstruction)}</td>
        <td>${ownSelect("own_revitalized", e.ownRevitalized)}</td>
        <td>${ownSelect("stats_include", e.statsInclude)}</td>
        <td>${esc(e.priceLabel)}</td>
        <td>${esc(formatPricePerM2(e.pricePerM2))}</td>
        <td>${esc(priceDropLabel(e))}</td>
        <td>${esc(formatDateOnly(e.firstSeenAt))}</td>
        <td>${esc(daysOnMarketLabel(e))}</td>
        <td><form class="cell-form cell-form--stack" method="post" action="/byt/${encId}/notes">
          <input type="number" name="verified_sale_price_czk" value="${e.verifiedSalePrice ?? ""}" placeholder="Kč" onchange="this.form.requestSubmit()">
          <input type="date" name="verified_sale_date" value="${e.verifiedSaleDate ?? ""}" onchange="this.form.requestSubmit()">
        </form></td>
        <td class="compare-links"><a href="/byt/${encId}">Detail</a> · <a href="${esc(e.rep.url)}" target="_blank" rel="noopener">Inzerát ↗</a> · <a href="/byt/${encId}/kalkulacka">Kalkulačka</a></td>
        <td><form class="cell-form" method="post" action="/byt/${encId}/notes"><input type="text" name="notes" value="${esc(e.notes)}" placeholder="poznámka…" onchange="this.form.requestSubmit()"></form></td>
        <td><form class="cell-form" method="post" action="/byt/${encId}/notes"><input type="text" name="seller_motivation" value="${esc(e.sellerMotivation)}" placeholder="motivace…" onchange="this.form.requestSubmit()"></form></td>
      </tr>`;
    })
    .join("");

  const headers = [
    "Nabídka", "Adresa / lokalita", "Dispozice", "Plocha",
    "Patro", "Výtah", "Balkón", "Sklep", "Vlastnictví",
    "Stav", "Konstrukce", "Revitalizace", "Ve statistice",
  ];

  return `
    <h1>Srovnání bytů (${filtered.length})</h1>
    <div class="filters">${filterLinks}</div>
    <div class="toolbar">
      <form method="get" action="/tabulka" class="select-filters">
        <input type="hidden" name="status" value="${esc(statusFilter || "")}">
        <input type="hidden" name="sort" value="${esc(sortParam || "")}">
        <select name="city" onchange="this.form.submit()">${cityOptionsHtml}</select>
      </form>
    </div>
    <div class="compare-wrap">
      <table class="compare">
        <thead><tr>
          ${headers.map((h) => `<th>${esc(h)}</th>`).join("")}
          <th>${compareSortHeader(sortParam, "price", "Cena")}</th>
          <th>${compareSortHeader(sortParam, "price_m2", "Cena/m²")}</th>
          <th>${compareSortHeader(sortParam, "discount", "Sleva")}</th>
          <th>${compareSortHeader(sortParam, "added", "Přidáno")}</th>
          <th>${compareSortHeader(sortParam, "days", "Doba v nabídce")}</th>
          <th>Ověřená cena</th>
          <th>Odkaz</th>
          <th>Poznámka</th>
          <th>Motivace prodávajícího</th>
        </tr></thead>
        <tbody>${rows || `<tr><td colspan="${headers.length + 9}" class="empty">Nic nenalezeno pro zvolené filtry.</td></tr>`}</tbody>
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
  const st = STATUS_LABELS[status] || { text: status, color: "#000" };
  const starred = isStarred(members);
  const hidden = isHidden(members);
  const sourceById = Object.fromEntries(members.map((m) => [m.id, m.source]));

  const memberIds = members.map((m) => m.id);
  const placeholders = memberIds.map(() => "?").join(",");
  const photos = db.prepare(`SELECT * FROM photos WHERE listing_id IN (${placeholders}) ORDER BY listing_id, id`).all(...memberIds);
  const events = db.prepare(`SELECT * FROM events WHERE listing_id IN (${placeholders}) ORDER BY occurred_at ASC`).all(...memberIds);

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
  const latest = latestChange(events);
  const updates = updatesChips(earliestListedAt(members), latest, changeSources(members, events, latest));

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
      <label>Ověřená prodejní cena (Kč)<input type="number" name="verified_sale_price_czk" value="${pickOwnValue(members, "verified_sale_price_czk") ?? ""}"></label>
      <label>Datum prodeje<input type="date" name="verified_sale_date" value="${pickOwnValue(members, "verified_sale_date") ?? ""}"></label>
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
// jinde) A appka/uživatel ho označili jako "Po rekonstrukci". Novostavba se
// SCHVÁLNĚ nepočítá do stejného koše (jiný cenový segment), kdo ji chce
// zahrnout, přehlasuje ručně přes "Zahrnout".
function isEligibleForRenoStats(e) {
  if (e.statsInclude === "exclude") return false;
  if (e.statsInclude === "include") return true;
  return e.status === "removed" && e.ownCondition === "renovated";
}

// Ověřená prodejní cena (uživatel si ji dohledal v katastru) má vždy
// přednost — je to REÁLNÁ transakce. Bez ní appka bere poslední evidovanou
// (inzerovanou) cenu těsně před zmizením — návod výslovně upozorňuje, že to
// NENÍ prodejní cena (typicky o pár % výš), proto se u takových řádků
// značí "odhad" a počet ověřených/odhadnutých se ukazuje zvlášť.
function effectivePriceForStats(e) {
  return e.verifiedSalePrice ?? e.price;
}

// Souhrn "cena/m² u prodaných bytů po rekonstrukci" — PRIMÁRNĚ podle
// města, uvnitř každého města rozpad podle dispozice (přesně v tomhle
// pořadí chtěl uživatel, ne dvě oddělené tabulky vedle sebe). Vrací i
// `count` u každého řádku, ať je i při řídkých datech vidět velikost
// vzorku — appka si nic nevymýšlí za nedostatek dat, jen ho ukáže.
function renovatedSaleStats(entries) {
  const eligible = entries
    .filter(isEligibleForRenoStats)
    .map((e) => ({
      pricePerM2: (() => {
        const price = effectivePriceForStats(e);
        return price != null && e.rep.area_m2 ? price / e.rep.area_m2 : null;
      })(),
      disposition: e.rep.disposition || "—",
      city: e.city || "—",
      verified: e.verifiedSalePrice != null,
      // Pro rozklikávací seznam bytů za průměrem (viz renderCityStatsTable)
      // — appka jinak ukazovala jen holé číslo bez možnosti ověřit, ze
      // kterých konkrétních bytů vzniklo.
      id: e.rep.id,
      address: e.address || e.city,
      areaM2: e.rep.area_m2,
    }))
    .filter((r) => r.pricePerM2 != null);

  function summarize(rows) {
    const values = rows.map((r) => r.pricePerM2);
    return {
      count: rows.length,
      verifiedCount: rows.filter((r) => r.verified).length,
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
      const verifiedBadge = it.verified ? ` <span class="muted">(ověřeno)</span>` : "";
      const areaLabel = it.areaM2 ? `, ${it.areaM2} m²` : "";
      return `<li><a href="/byt/${encodeURIComponent(it.id)}">${esc(it.address)}${areaLabel}</a> — ${formatCzk(Math.round(it.pricePerM2))}/m²${verifiedBadge}</li>`;
    })
    .join("");
  return `<details class="stats-items"><summary>${items.length} bytů</summary><ul>${rows}</ul></details>`;
}

function renderCityStatsTable(cityStats) {
  const body = cityStats.dispositions
    .map(
      (d) => `<tr>
        <td>${esc(d.disposition)}</td>
        <td>${renderStatsItemsList(d.items)}${d.verifiedCount ? ` <span class="muted">(${d.verifiedCount}× ověřeno)</span>` : ""}</td>
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
  const counts = { active: 0, reserved: 0, removed: 0 };
  for (const e of entries) counts[e.status]++;
  const countRows = Object.entries(counts)
    .map(([k, n]) => `<li>${esc(STATUS_LABELS[k].text)}: <strong>${n}</strong></li>`)
    .join("");
  const mergedCount = entries.filter((e) => e.g.merged).length;

  const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
  const removedRecentWithData = entries.filter(
    (e) => e.status === "removed" && e.removedAt && new Date(e.removedAt).getTime() >= cutoff && e.price != null && e.rep.area_m2 != null
  );
  const avgPerM2 = removedRecentWithData.length
    ? Math.round(removedRecentWithData.reduce((sum, e) => sum + e.price / e.rep.area_m2, 0) / removedRecentWithData.length)
    : null;

  const renoStats = renovatedSaleStats(entries);

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

    <h2>Ceny po rekonstrukci (prodané byty)</h2>
    <p class="muted">
      Byty zmizelé z nabídky se stavem „Po rekonstrukci", případně ručně
      přehlasované přes sloupec „Ve statistice" v tabulce srovnání. Cena je ověřená prodejní, pokud ji máš dohledanou
      v katastru, jinak poslední inzerovaná cena před zmizením — u ní počítej s návodovým odečtem cca 5 % pro
      konzervativní odhad. Celkem ${renoStats.totalEligible} bytů se známou cenou/m².
    </p>
    ${renoStats.cities.length ? renoStats.cities.map(renderCityStatsTable).join("") : `<p class="muted">Zatím žádná data.</p>`}`;
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
    };
    return sendHtml(res, 200, layout("Trh bytů", renderTable(db, filters)));
  }

  if (url.pathname === "/tabulka" && req.method === "GET") {
    const filters = {
      status: url.searchParams.get("status") || null,
      city: url.searchParams.get("city") || null,
      sort: url.searchParams.get("sort") || null,
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
      if ("verified_sale_price_czk" in fields) {
        updates.verified_sale_price_czk = fields.verified_sale_price_czk ? Number(fields.verified_sale_price_czk) : null;
      }
      if ("verified_sale_date" in fields) updates.verified_sale_date = fields.verified_sale_date || null;
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
      for (const field of PARAM_OVERRIDE_FIELDS) {
        if (!(field.column in fields)) continue;
        const raw = fields[field.column]?.trim();
        const valid = field.type === "select" ? field.options.some(([v]) => v === raw) : Boolean(raw);
        if (valid) override[field.column] = raw;
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
