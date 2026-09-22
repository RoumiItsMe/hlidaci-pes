// Lokální prohlížecí appka — holý Node `http` server, žádná nová
// závislost (drží se filozofie repa). Server-rendered HTML, žádný build
// krok, žádný klientský framework. Spouští se ručně (`npm run sales-app`),
// na rozdíl od track.js NEBĚŽÍ na pozadí.

import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";
import { openDb, DATA_DIR } from "./db.js";
import { groupListings, primaryListing, mergedStatus, earliestFirstSeen, findGroupForListing, pickDescription, mergeParams, bestAddress, latestChange, isStarred, isHidden } from "./group.js";
import { PARAM_FIELDS } from "./params.js";
import { extractCity } from "./parse.js";
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
  removed: "Zmizelo z nabídky",
  reactivated: "Znovu v nabídce",
};

// Pro řádek v přehledu se z plné sady parametrů (viz params.js) skládá
// jen kompaktní shrnutí — popisné hodnoty (vlastnictví, stav, typ budovy,
// podlaží, energ. třída) rovnou, ano/ne vybavení (balkón, sklep...) jen
// když je "Ano" (ne "Balkón: Ne" — to jen zabírá místo bez užitku).
const PARAM_LABEL_BY_KEY = Object.fromEntries(PARAM_FIELDS);
const AMENITY_KEYS = ["balcony", "loggia", "terrace", "cellar", "parking", "garage"];
const DESCRIPTIVE_KEYS = ["ownership", "condition", "buildingType", "floorInfo", "energyRating"];

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
function updatesChips(firstSeenAt, change) {
  const since = `<span class="update-chip update-chip--since">📅 V nabídce od ${esc(formatDateOnly(firstSeenAt))}</span>`;
  const changeChip = change
    ? `<span class="update-chip update-chip--change">🔄 Poslední změna ${esc(formatDateOnly(change.occurred_at))} · ${esc(EVENT_LABELS[change.event_type] || change.event_type)}</span>`
    : `<span class="update-chip update-chip--none">Zatím beze změny</span>`;
  return `${since}${changeChip}`;
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

function layout(title, body) {
  return `<!doctype html>
<html lang="cs">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="stylesheet" href="/style.css">
</head>
<body>
<header><a href="/" class="brand">🏠 Trh bytů</a> <a href="/stats">Statistiky</a></header>
<main>${body}</main>
</body>
</html>`;
}

// Titulek řádku — "Byt 2+1, 55 m², Letohrad, ul. U dvora — 3 750 000 Kč".
// Adresa (viz group.js bestAddress) je u většiny portálů už "ulice, město"
// (nebo jen "město", když ulici portál/appka nezná — fail-soft, žádná
// nabídka kvůli chybějící adrese nezmizí, jen bude titulek o kousek kratší.
function cardTitle(rep, address) {
  const specs = [rep.disposition, rep.area_m2 ? `${rep.area_m2} m²` : null].filter(Boolean).join(", ");
  const head = specs ? `Byt ${specs}` : "Byt";
  const addressPart = address ? `, ${address}` : "";
  return `${head}${addressPart} — ${formatCzk(rep.price_czk)}`;
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

// Výchozí řazení: TOP (hvězdička) vždy nahoře, uvnitř toho podle
// "aktivity" — novější z (kdy zaevidováno, kdy poslední skutečná změna) —
// viz entry.activityAt níž. TOP-pinning platí jen pro "newest" (výchozí)
// řazení; u řazení podle ceny by míchání TOP dovnitř popřelo smysl "seřaď
// čistě podle ceny", který si uživatel explicitně zvolil.
const SORTERS = {
  newest: (a, b) => {
    if (a.starred !== b.starred) return a.starred ? -1 : 1;
    return b.activityAt < a.activityAt ? -1 : 1;
  },
  price_asc: (a, b) => (a.rep.price_czk ?? Infinity) - (b.rep.price_czk ?? Infinity),
  price_desc: (a, b) => (b.rep.price_czk ?? -Infinity) - (a.rep.price_czk ?? -Infinity),
};
const SORT_LABELS = [
  ["newest", "Nejnovější"],
  ["price_asc", "Cena ↑"],
  ["price_desc", "Cena ↓"],
];

function renderTable(db, filters) {
  const { status: statusFilter, sort = "newest", city: cityFilter, ownership: ownershipFilter, top: topFilter, hidden: hiddenView } = filters;
  const showHidden = hiddenView === "show";
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
  for (const e of db.prepare("SELECT listing_id, event_type, occurred_at FROM events").all()) {
    if (!eventsByListing.has(e.listing_id)) eventsByListing.set(e.listing_id, []);
    eventsByListing.get(e.listing_id).push(e);
  }
  function groupEvents(members) {
    return members.flatMap((m) => eventsByListing.get(m.id) || []);
  }

  // Odvozené údaje spočítané JEDNOU za skupinu — filtr, řazení i
  // vykreslení pak jen čtou, žádné opakované JSON.parse/reduce nad
  // stejnou skupinou vícekrát.
  const entries = allGroups.map((g) => {
    const firstSeenAt = earliestFirstSeen(g.members);
    const change = latestChange(groupEvents(g.members));
    return {
      g,
      rep: primaryListing(g.members),
      params: mergeParams(g.members),
      address: bestAddress(g.members),
      status: mergedStatus(g.members),
      firstSeenAt,
      change,
      // "Aktivita" pro výchozí řazení = novější z (zaevidováno, poslední
      // skutečná změna) — čerstvě přidaný byt i dávno zaevidovaný byt s
      // dnešní změnou ceny mají oba vyjít jako "nahoře".
      activityAt: change && change.occurred_at > firstSeenAt ? change.occurred_at : firstSeenAt,
      starred: isStarred(g.members),
      hidden: isHidden(g.members),
    };
  });
  for (const e of entries) e.city = extractCity(e.address, BYTY_WATCH);

  // Volby pro "Město"/"Vlastnictví" — jen hodnoty, co se v datech opravdu
  // vyskytují (ze SEBE, ne z hardcoded seznamu, ať appka nenabízí volbu,
  // po které nic nenajde). Z CELÉ sady, ne z už filtrované — jinak by
  // volby při kombinaci filtrů mizely a přehled by nedával smysl.
  const cityOptions = [...new Set(entries.map((e) => e.city).filter(Boolean))].sort((a, b) => a.localeCompare(b, "cs"));
  const ownershipOptions = [...new Set(entries.map((e) => e.params.ownership).filter(Boolean))].sort((a, b) => a.localeCompare(b, "cs"));
  const hiddenCount = entries.filter((e) => e.hidden).length;

  // Skryté (křížkem vyřazené) položky se z běžného přehledu vylučují VŽDY
  // — dokud si je uživatel výslovně nevyžádá přes "Skryté" (?hidden=show).
  // V tom pohledu naopak ukazujeme JEN skryté (kvůli případnému obnovení)
  // a stavový filtr se ignoruje — "V nabídce"/"Rezervováno"/... nedává u
  // skrytých položek smysl kombinovat.
  let filtered = entries;
  if (showHidden) {
    filtered = filtered.filter((e) => e.hidden);
  } else {
    filtered = filtered.filter((e) => !e.hidden);
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
    .map(({ g, rep, params, address, status, firstSeenAt, change, starred, hidden }) => {
      const st = STATUS_LABELS[status] || { text: status, color: "#000" };
      const sourceLabel = g.members.map((m) => SOURCE_LABELS[m.source] || m.source).join(" + ");
      const linkBadge = g.merged ? ` <span class="link-badge" title="Stejná nemovitost nalezená na víc portálech">🔗</span>` : "";
      const thumb = groupThumbnail(g.members);
      const photo = thumb
        ? `<img src="/photos/${encodeURIComponent(thumb.replace(/^photos[\\/]/, ""))}" loading="lazy" alt="">`
        : `<div class="row-photo-empty">Bez fotky</div>`;

      const paramsLine = paramsSummaryLine(params);
      const descriptionSource = pickDescription(g.members);
      const snippet = descriptionSource ? truncate(descriptionSource.description, 220) : "";
      const updates = updatesChips(firstSeenAt, change);

      return `<div class="row${starred ? " row--starred" : ""}">
        <div class="row-actions">${rowActionButtons(rep.id, starred, hidden)}</div>
        <a class="row-link" href="/byt/${encodeURIComponent(rep.id)}">
          <div class="row-photo">${photo}</div>
          <div class="row-body">
            <div class="row-title">${starred ? "⭐ " : ""}${esc(cardTitle(rep, address))}</div>
            ${paramsLine ? `<div class="row-params">${esc(paramsLine)}</div>` : ""}
            ${snippet ? `<div class="row-snippet">${esc(snippet)}</div>` : ""}
            <div class="row-updates">${updates}</div>
            <div class="row-meta">
              <span class="badge" style="background:${st.color}">${esc(st.text)}</span>
              <span class="muted">${esc(sourceLabel)}${linkBadge}</span>
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

  const sourceLinks = members
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
      let detail = "";
      if (e.event_type === "price_change") detail = `${formatCzk(e.old_price_czk)} → ${formatCzk(e.new_price_czk)}`;
      const srcLabel = group.merged ? ` <span class="muted">(${esc(SOURCE_LABELS[sourceById[e.listing_id]] || sourceById[e.listing_id])})</span>` : "";
      return `<li><strong>${formatDate(e.occurred_at)}</strong> — ${esc(EVENT_LABELS[e.event_type] || e.event_type)}${srcLabel} ${detail}</li>`;
    })
    .join("");

  const address = bestAddress(members) || "";
  const updates = updatesChips(earliestFirstSeen(members), latestChange(events));

  return `
    <p><a href="/">← Zpět na seznam</a></p>
    <div class="detail-heading">
      <h1>${starred ? "⭐ " : ""}${esc(rep.disposition || "")} ${rep.area_m2 ? `${rep.area_m2} m²` : ""}</h1>
      <div class="row-actions row-actions--detail">${rowActionButtons(rep.id, starred, hidden)}</div>
    </div>
    <p>
      <span class="badge" style="background:${st.color}">${esc(st.text)}</span>
      ${group.merged ? `· nalezeno na ${members.length} portálech` : ""}
    </p>
    <ul class="source-links">${sourceLinks}</ul>
    <p>${esc(rep.disposition || "—")} · ${rep.area_m2 ? `${rep.area_m2} m²` : "—"} · ${formatCzk(rep.price_czk)}</p>
    <p>${esc(address)}</p>
    <div class="row-updates">${updates}</div>
    ${gallery ? `<div class="gallery">${gallery}</div>` : ""}
    ${paramRows ? `<h2>Parametry</h2><table class="params">${paramRows}</table>` : ""}
    ${descriptionHtml ? `<h2>Popis</h2>${descriptionHtml}` : ""}

    <h2>Časová osa</h2>
    <ul class="timeline">${timeline}</ul>

    <h2>Vlastní poznámky</h2>
    <form method="post" action="/byt/${encodeURIComponent(rep.id)}/notes">
      <label>Ověřená prodejní cena (Kč)<input type="number" name="verified_sale_price_czk" value="${rep.verified_sale_price_czk ?? ""}"></label>
      <label>Datum prodeje<input type="date" name="verified_sale_date" value="${rep.verified_sale_date ?? ""}"></label>
      <label>Poznámka<textarea name="notes" rows="3">${esc(rep.notes)}</textarea></label>
      <button type="submit">Uložit</button>
    </form>`;
}

function renderStats(db) {
  const allListings = db.prepare("SELECT * FROM listings").all();
  // Skryté (křížkem vyřazené) položky se do statistik nepočítají — hidden
  // je uživatelovo "tohle mě nezajímá", stejná úvaha jako v přehledu.
  const groups = groupListings(allListings).filter((g) => !isHidden(g.members));

  // Počítáno na SKUPINY (skutečné nemovitosti), ne syrové řádky — jinak by
  // stejný byt nalezený na 2 portálech vyšel v součtu jako 2 byty.
  const counts = { active: 0, reserved: 0, removed: 0 };
  for (const g of groups) counts[mergedStatus(g.members)]++;
  const countRows = Object.entries(counts)
    .map(([k, n]) => `<li>${esc(STATUS_LABELS[k].text)}: <strong>${n}</strong></li>`)
    .join("");
  const mergedCount = groups.filter((g) => g.merged).length;

  const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
  const removedRecentWithData = groups
    .filter((g) => mergedStatus(g.members) === "removed")
    .filter((g) => {
      // Skupina "zmizela" datem POSLEDNÍHO zmizení mezi jejími členy —
      // dokud byla vidět aspoň na jednom portálu, pořád byla na trhu.
      const latest = g.members.reduce((max, m) => (m.removed_at && m.removed_at > max ? m.removed_at : max), "");
      return latest && new Date(latest).getTime() >= cutoff;
    })
    .map((g) => primaryListing(g.members))
    .filter((r) => r.price_czk != null && r.area_m2 != null);

  const avgPerM2 = removedRecentWithData.length
    ? Math.round(removedRecentWithData.reduce((sum, r) => sum + r.price_czk / r.area_m2, 0) / removedRecentWithData.length)
    : null;

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
    }</p>`;
}

function serveStatic(res, filePath, contentType) {
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  res.writeHead(200, { "Content-Type": contentType });
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

const db = openDb();

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === "/style.css") {
    return serveStatic(res, path.join(import.meta.dirname, "public", "style.css"), "text/css");
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
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(layout("Trh bytů", renderTable(db, filters)));
  }

  if (url.pathname === "/stats" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(layout("Statistiky — Trh bytů", renderStats(db)));
  }

  const detailMatch = url.pathname.match(/^\/byt\/([^/]+)$/);
  if (detailMatch && req.method === "GET") {
    const id = decodeURIComponent(detailMatch[1]);
    const body = renderDetail(db, id);
    if (!body) {
      res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(layout("Nenalezeno", "<p>Byt nenalezen.</p>"));
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(layout("Byt — Trh bytů", body));
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

  const notesMatch = url.pathname.match(/^\/byt\/([^/]+)\/notes$/);
  if (notesMatch && req.method === "POST") {
    const id = decodeURIComponent(notesMatch[1]);
    const fields = await parseBody(req);
    db.prepare(
      "UPDATE listings SET notes = ?, verified_sale_price_czk = ?, verified_sale_date = ? WHERE id = ?"
    ).run(
      fields.notes || null,
      fields.verified_sale_price_czk ? Number(fields.verified_sale_price_czk) : null,
      fields.verified_sale_date || null,
      id
    );
    res.writeHead(302, { Location: `/byt/${encodeURIComponent(id)}` });
    return res.end();
  }

  res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
  res.end(layout("Nenalezeno", "<p>Stránka nenalezena.</p>"));
});

server.listen(PORT, () => {
  console.log(`Trh bytů běží na http://localhost:${PORT}`);
});
