// Lokální prohlížecí appka — holý Node `http` server, žádná nová
// závislost (drží se filozofie repa). Server-rendered HTML, žádný build
// krok, žádný klientský framework. Spouští se ručně (`npm run sales-app`),
// na rozdíl od track.js NEBĚŽÍ na pozadí.

import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";
import { openDb, DATA_DIR } from "./db.js";

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

function renderTable(db, statusFilter) {
  let query = "SELECT * FROM listings";
  const params = [];
  if (statusFilter) {
    query += " WHERE status = ?";
    params.push(statusFilter);
  }
  query += " ORDER BY first_seen_at DESC";
  const rows = db.prepare(query).all(...params);

  const filterLinks = ["", "active", "reserved", "removed"]
    .map((s) => {
      const label = s ? STATUS_LABELS[s].text : "Vše";
      const active = statusFilter === s || (!statusFilter && !s) ? "active" : "";
      return `<a class="filter ${active}" href="/?status=${s}">${esc(label)}</a>`;
    })
    .join("");

  const tableRows = rows
    .map((r) => {
      const st = STATUS_LABELS[r.status] || { text: r.status, color: "#000" };
      return `<tr onclick="location.href='/byt/${encodeURIComponent(r.id)}'">
        <td>${esc(r.disposition || "—")}</td>
        <td>${r.area_m2 ? `${r.area_m2} m²` : "—"}</td>
        <td>${formatCzk(r.price_czk)}</td>
        <td><span class="badge" style="background:${st.color}">${esc(st.text)}</span></td>
        <td>${esc(SOURCE_LABELS[r.source] || r.source)}</td>
        <td>${formatDate(r.first_seen_at)}</td>
      </tr>`;
    })
    .join("");

  return `
    <h1>Byty (${rows.length})</h1>
    <div class="filters">${filterLinks}</div>
    <table>
      <thead><tr><th>Dispozice</th><th>Plocha</th><th>Cena</th><th>Stav</th><th>Portál</th><th>Přidáno</th></tr></thead>
      <tbody>${tableRows || `<tr><td colspan="6" class="empty">Zatím žádná data — spusť <code>npm run track-sales</code>.</td></tr>`}</tbody>
    </table>`;
}

function renderDetail(db, id) {
  const listing = db.prepare("SELECT * FROM listings WHERE id = ?").get(id);
  if (!listing) return null;

  const events = db.prepare("SELECT * FROM events WHERE listing_id = ? ORDER BY occurred_at ASC").all(id);
  const photos = db.prepare("SELECT * FROM photos WHERE listing_id = ? ORDER BY id ASC").all(id);
  const st = STATUS_LABELS[listing.status] || { text: listing.status, color: "#000" };

  const gallery = photos.map((p) => `<img src="/photos/${encodeURIComponent(p.local_path.replace(/^photos[\\/]/, ""))}" loading="lazy">`).join("");

  const timeline = events
    .map((e) => {
      let detail = "";
      if (e.event_type === "price_change") detail = `${formatCzk(e.old_price_czk)} → ${formatCzk(e.new_price_czk)}`;
      return `<li><strong>${formatDate(e.occurred_at)}</strong> — ${esc(EVENT_LABELS[e.event_type] || e.event_type)} ${detail}</li>`;
    })
    .join("");

  return `
    <p><a href="/">← Zpět na seznam</a></p>
    <h1>${esc(listing.title || listing.disposition || listing.id)}</h1>
    <p>
      <span class="badge" style="background:${st.color}">${esc(st.text)}</span>
      · ${esc(SOURCE_LABELS[listing.source] || listing.source)}
      · <a href="${esc(listing.url)}" target="_blank" rel="noopener">otevřít inzerát ↗</a>
    </p>
    <p>${esc(listing.disposition || "—")} · ${listing.area_m2 ? `${listing.area_m2} m²` : "—"} · ${formatCzk(listing.price_czk)}</p>
    <p>${esc(listing.address || "")}</p>
    ${gallery ? `<div class="gallery">${gallery}</div>` : ""}
    ${listing.description ? `<h2>Popis</h2><p class="description">${esc(listing.description)}</p>` : ""}

    <h2>Časová osa</h2>
    <ul class="timeline">${timeline}</ul>

    <h2>Vlastní poznámky</h2>
    <form method="post" action="/byt/${encodeURIComponent(listing.id)}/notes">
      <label>Ověřená prodejní cena (Kč)<input type="number" name="verified_sale_price_czk" value="${listing.verified_sale_price_czk ?? ""}"></label>
      <label>Datum prodeje<input type="date" name="verified_sale_date" value="${listing.verified_sale_date ?? ""}"></label>
      <label>Poznámka<textarea name="notes" rows="3">${esc(listing.notes)}</textarea></label>
      <button type="submit">Uložit</button>
    </form>`;
}

function renderStats(db) {
  const counts = db.prepare("SELECT status, COUNT(*) as n FROM listings GROUP BY status").all();
  const countRows = counts.map((c) => `<li>${esc(STATUS_LABELS[c.status]?.text || c.status)}: <strong>${c.n}</strong></li>`).join("");

  const avg = db
    .prepare(
      `SELECT ROUND(AVG(price_czk * 1.0 / area_m2)) as avg_per_m2, COUNT(*) as n
       FROM listings WHERE status = 'removed' AND price_czk IS NOT NULL AND area_m2 IS NOT NULL
       AND removed_at >= datetime('now', '-90 days')`
    )
    .get();

  return `
    <p><a href="/">← Zpět na seznam</a></p>
    <h1>Statistiky</h1>
    <ul>${countRows}</ul>
    <h2>Zmizelé z nabídky za posledních 90 dní</h2>
    <p>${avg?.n ? `${avg.n} bytů, průměr ${formatCzk(avg.avg_per_m2)}/m² (z poslední evidované ceny, ne nutně skutečná prodejní cena)` : "Zatím žádná data."}</p>`;
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
