// Lokální prohlížecí appka — holý Node `http` server, žádná nová
// závislost (drží se filozofie repa). Server-rendered HTML, žádný build
// krok, žádný klientský framework. Spouští se ručně (`npm run sales-app`),
// na rozdíl od track.js NEBĚŽÍ na pozadí.

import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";
import { openDb, DATA_DIR } from "./db.js";
import { groupListings, primaryListing, mergedStatus, earliestFirstSeen, findGroupForListing, pickDescription, mergeParams, bestAddress } from "./group.js";
import { PARAM_FIELDS } from "./params.js";

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

function renderTable(db, statusFilter) {
  const allListings = db.prepare("SELECT * FROM listings").all();
  // Skupiny (ne syrové řádky) — stejná nemovitost napříč portály se ukáže
  // jen jednou, viz group.js.
  let groups = groupListings(allListings);
  if (statusFilter) groups = groups.filter((g) => mergedStatus(g.members) === statusFilter);
  groups.sort((a, b) => (earliestFirstSeen(b.members) < earliestFirstSeen(a.members) ? -1 : 1));

  // Jedna náhledová fotka na inzerát (ta s nejnižším id = první stažená),
  // jedním dotazem pro všechny skupiny najednou — ne 70 samostatných.
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

  const filterLinks = ["", "active", "reserved", "removed"]
    .map((s) => {
      const label = s ? STATUS_LABELS[s].text : "Vše";
      const active = statusFilter === s || (!statusFilter && !s) ? "active" : "";
      return `<a class="filter ${active}" href="/?status=${s}">${esc(label)}</a>`;
    })
    .join("");

  const rows = groups
    .map((g) => {
      const rep = primaryListing(g.members); // nejdůvěryhodnější zdroj (Sreality/iDNES > Bezrealitky > RealityMIX/Bazoš), viz group.js
      const status = mergedStatus(g.members);
      const st = STATUS_LABELS[status] || { text: status, color: "#000" };
      const sourceLabel = g.members.map((m) => SOURCE_LABELS[m.source] || m.source).join(" + ");
      const linkBadge = g.merged ? ` <span class="link-badge" title="Stejná nemovitost nalezená na víc portálech">🔗</span>` : "";
      const address = bestAddress(g.members);
      const thumb = groupThumbnail(g.members);
      const photo = thumb
        ? `<img src="/photos/${encodeURIComponent(thumb.replace(/^photos[\\/]/, ""))}" loading="lazy" alt="">`
        : `<div class="row-photo-empty">Bez fotky</div>`;

      const paramsLine = paramsSummaryLine(mergeParams(g.members));
      const descriptionSource = pickDescription(g.members);
      const snippet = descriptionSource ? truncate(descriptionSource.description, 220) : "";

      return `<a class="row" href="/byt/${encodeURIComponent(rep.id)}">
        <div class="row-photo">${photo}</div>
        <div class="row-body">
          <div class="row-title">${esc(cardTitle(rep, address))}</div>
          ${paramsLine ? `<div class="row-params">${esc(paramsLine)}</div>` : ""}
          ${snippet ? `<div class="row-snippet">${esc(snippet)}</div>` : ""}
          <div class="row-meta">
            <span class="badge" style="background:${st.color}">${esc(st.text)}</span>
            <span class="muted">${esc(sourceLabel)}${linkBadge}</span>
          </div>
        </div>
      </a>`;
    })
    .join("");

  return `
    <h1>Byty (${groups.length})</h1>
    <div class="filters">${filterLinks}</div>
    <div class="rows">${rows || `<p class="empty">Zatím žádná data — spusť <code>npm run track-sales</code>.</p>`}</div>`;
}

function renderDetail(db, id) {
  const allListings = db.prepare("SELECT * FROM listings").all();
  const group = findGroupForListing(allListings, id);
  if (!group) return null;

  const members = group.members;
  const rep = primaryListing(members); // nese notes/verified_sale_* — jeden sdílený záznam za skupinu
  const status = mergedStatus(members);
  const st = STATUS_LABELS[status] || { text: status, color: "#000" };
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

  const address = members.find((m) => m.address)?.address || "";

  return `
    <p><a href="/">← Zpět na seznam</a></p>
    <h1>${esc(rep.disposition || "")} ${rep.area_m2 ? `${rep.area_m2} m²` : ""}</h1>
    <p>
      <span class="badge" style="background:${st.color}">${esc(st.text)}</span>
      ${group.merged ? `· nalezeno na ${members.length} portálech` : ""}
    </p>
    <ul class="source-links">${sourceLinks}</ul>
    <p>${esc(rep.disposition || "—")} · ${rep.area_m2 ? `${rep.area_m2} m²` : "—"} · ${formatCzk(rep.price_czk)}</p>
    <p>${esc(address)}</p>
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
  const groups = groupListings(allListings);

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
    const status = url.searchParams.get("status") || null;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(layout("Trh bytů", renderTable(db, status)));
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
