// Text inzerátu pro vyčítání údajů (stav, konstrukce, parametry, ...).
//
// RealityMIX má popis na stránce, ale do sloupce `description` se záměrně neukládá —
// ten rozhoduje o slučování bytů napříč portály (group.js descriptionsMatch) a cizí text
// by mohl rozbít seskupení (viz detail/realitymix.js). Jeho text proto žije v
// `geo_json.text`. Kdo čte text kvůli údajům o bytě, bere popis, a když ho nemá, ten.

/** Text popisu z `geo_json` (RealityMIX), nebo "". Nečitelný JSON nevadí. */
export function geoTextOf(geoJson) {
  if (!geoJson) return "";
  try {
    const text = typeof geoJson === "string" ? JSON.parse(geoJson).text : geoJson.text;
    return typeof text === "string" ? text : "";
  } catch {
    return "";
  }
}

/** Popis inzerátu pro vyčítání údajů: `description`, jinak text z `geo_json`. */
export function descriptionForDetection({ description, geo_json }) {
  return description || geoTextOf(geo_json) || "";
}

/** Titulek + popis (viz descriptionForDetection) jedním řetězcem. */
export function listingText(row) {
  return [row.title, descriptionForDetection(row)].filter(Boolean).join(" ");
}
