// Spojnicový graf pro stránku Vývoj cen (/vyvoj) — SVG skládané na serveru, bez knihovny (appka drží minimum
// závislostí). Osa X = období stejně daleko od sebe, jedna osa Y (nikdy dvě: cena a počet bytů jsou dva grafy).
// Barvy řad jsou CSS proměnné (--series-1…3 v style.css), text vždy barvou textu, ne barvou řady.
// Najetí myší / fokus klávesnicí ukáže všechny hodnoty období (public/app.js, `.chart`) — hodnoty jsou
// zároveň v tabulce pod grafem, takže bez myši se o nic nepřijde.

const W = 720;
const MARGIN = { top: 14, right: 104, bottom: 30, left: 64 };
const END_LABEL_GAP = 14; // menší svislý odstup koncových popisků = popisky by se překrývaly

const escAttr = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const round1 = (v) => Math.round(v * 10) / 10;

/** Pěkné kroky osy: 1, 2, 2,5 nebo 5 × 10^n tak, aby vyšlo zhruba `target` dílků. */
export function niceScale(min, max, { target = 4, zero = false } = {}) {
  let lo = zero ? Math.min(0, min) : min;
  let hi = max;
  if (hi === lo) {
    const pad = Math.abs(hi) * 0.05 || 1;
    lo = zero ? lo : lo - pad;
    hi += pad;
  }
  const raw = (hi - lo) / target;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw);
  const from = Math.floor(lo / step) * step;
  const to = Math.ceil(hi / step) * step;
  const ticks = [];
  for (let v = from; v <= to + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return { min: from, max: to, ticks };
}

/**
 * Graf jako HTML (legenda + SVG). `labels` = popisky období pod osou, `series` = [{ label, color (CSS
 * proměnná), kind: "line" | "dots", values: [číslo | null] }], `tips` = obsah bubliny pro každé období
 * ({ title, rows: [{ label, value, color, kind }] }), `formatTick` / `formatValue` = formát čísel.
 * Legenda se vykreslí jen u víc řad (jedinou řadu pojmenuje nadpis grafu).
 */
export function lineChartHtml({ labels, series, tips, formatTick, formatValue, height = 240, zero = false, ariaLabel }) {
  const n = labels.length;
  const values = series.flatMap((s) => s.values).filter((v) => v != null);
  if (!n || !values.length) return "";
  const plotW = W - MARGIN.left - MARGIN.right;
  const plotH = height - MARGIN.top - MARGIN.bottom;
  const scale = niceScale(Math.min(...values), Math.max(...values), { zero });
  const x = (i) => round1(MARGIN.left + (n === 1 ? plotW / 2 : (i * plotW) / (n - 1)));
  const y = (v) => round1(MARGIN.top + plotH - ((v - scale.min) / (scale.max - scale.min)) * plotH);

  const grid = scale.ticks
    .map((t) => `<line class="chart-grid" x1="${MARGIN.left}" x2="${MARGIN.left + plotW}" y1="${y(t)}" y2="${y(t)}"/><text class="chart-tick" x="${MARGIN.left - 8}" y="${y(t) + 4}" text-anchor="end">${escAttr(formatTick(t))}</text>`)
    .join("");
  // Popisky pod osou: nejvýš ~10, poslední (aktuální období) vždy.
  const every = Math.ceil(n / 10);
  const xLabels = labels
    .map((l, i) => (i % every === 0 || i === n - 1) && !(i !== n - 1 && n - 1 - i < every) ? `<text class="chart-tick" x="${x(i)}" y="${height - 8}" text-anchor="middle">${escAttr(l)}</text>` : "")
    .join("");

  const marks = series
    .map((s, si) => {
      const cls = `chart-series chart-series--${si + 1}`;
      let path = "";
      if (s.kind === "line") {
        let pen = false;
        s.values.forEach((v, i) => {
          if (v == null) return void (pen = false);
          path += `${pen ? "L" : "M"}${x(i)} ${y(v)}`;
          pen = true;
        });
      }
      const dots = s.values.map((v, i) => (v == null ? "" : `<circle class="chart-dot" cx="${x(i)}" cy="${y(v)}" r="${s.kind === "dots" ? 5 : 4}" style="fill:${s.color}"/>`)).join("");
      return `<g class="${cls}">${path ? `<path class="chart-line" d="${path}" style="stroke:${s.color}"/>` : ""}${dots}</g>`;
    })
    .join("");

  // Hodnota na konci řady (jen u řad, které končí v posledním období); když by se dva popisky překrývaly,
  // zůstane jen ten u dřívější řady — zbytek řekne legenda a bublina.
  const ends = series
    .map((s) => ({ s, v: s.values[n - 1] }))
    .filter(({ v }) => v != null)
    .map(({ s, v }) => ({ s, v, yy: y(v) }));
  const kept = [];
  for (const end of ends) if (kept.every((k) => Math.abs(k.yy - end.yy) >= END_LABEL_GAP)) kept.push(end);
  const endLabels = kept.map(({ v, yy }) => `<text class="chart-end" x="${x(n - 1) + 10}" y="${yy + 4}">${escAttr(formatValue(v))}</text>`).join("");

  // Plochy pro najetí myší: celý sloupec období (od poloviny k sousedům), ne jen 8px tečka.
  const half = n === 1 ? plotW / 2 : plotW / (n - 1) / 2;
  const hits = labels
    .map((_, i) => {
      const left = Math.max(MARGIN.left, x(i) - half);
      const right = Math.min(MARGIN.left + plotW, x(i) + half);
      return `<rect class="chart-hit" x="${round1(left - (i === 0 ? 8 : 0))}" y="${MARGIN.top}" width="${round1(right - left + (i === 0 || i === n - 1 ? 8 : 0))}" height="${plotH}" data-i="${i}" data-x="${x(i)}" tabindex="0"/>`;
    })
    .join("");

  const legend =
    series.length > 1
      ? `<div class="chart-legend">${series
          .map((s) => `<span class="chart-key"><span class="chart-key-mark chart-key-mark--${s.kind}" style="--key:${s.color}"></span>${escAttr(s.label)}</span>`)
          .join("")}</div>`
      : "";

  return `${legend}<div class="chart" data-tips="${escAttr(JSON.stringify(tips))}">
  <svg viewBox="0 0 ${W} ${height}" role="img" aria-label="${escAttr(ariaLabel)}">
    ${grid}<line class="chart-axis" x1="${MARGIN.left}" x2="${MARGIN.left + plotW}" y1="${MARGIN.top + plotH}" y2="${MARGIN.top + plotH}"/>
    ${xLabels}
    <line class="chart-cross" x1="0" x2="0" y1="${MARGIN.top}" y2="${MARGIN.top + plotH}"/>
    ${marks}${endLabels}${hits}
  </svg>
  <div class="chart-tip" hidden></div>
</div>`;
}
