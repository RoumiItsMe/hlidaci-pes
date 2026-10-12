// Vyhodnocení PŘESNÉ ADRESY bytu z toho, co o poloze řekly portály — čistá
// logika bez DB/HTTP (stejná filozofie jako group.js, sale-triage.js).
//
// Adresa se sbírá ze tří druhů důkazů a nikdy se nevěří jedinému bodu:
//
//  1. PORTÁL (silný): strukturovaná adresa. Sreality ji dává u inzerátů s
//     `entityType: "address"` (ulice + číslo popisné); když RK označila jen
//     ulici/část obce/obec, Sreality to říká (`street`/`ward`/`municipality`)
//     a pak číslo domu NENÍ. Bezrealitky dávají ulici a číslo jen občas.
//  2. TEXT (střední): "ulice Kubelkova 1759" v popisu inzerátu.
//  3. BOD (iDNES, RealityMIX, Bezrealitky, Sreality): souřadnice po zpětném
//     geokódování (viz geo.js). Bod ale RK často zadá jen na ulici — pak
//     leží na silnici a může ho sdílet víc bytů — proto se bere jako důkaz
//     jen když ZÁROVEŇ: míří do budovy s číslem domu (bod uvnitř jejího
//     obrysu), NESDÍLÍ ho žádný jiný byt (sdílený bod = ulice nebo stejný
//     dům, což z bodu nepoznáme, takže radši nic) a ulice z bodu se objevuje
//     v inzerátu. Jinak je to jen slabý hint, který nic nepřiřadí.
//
// Výsledek: `high` (adresa se doplní sama, s vysvětlením), `medium` (jen
// návrh k potvrzení), `conflict` (zdroje si odporují — nepřiřazuje se nic),
// `none`. Důvody ("reasons") se ukazují uživateli — appka nic netvrdí bez
// toho, aby řekla proč.

const GENERIC_STREET_WORDS = new Set(["ulice", "nam", "namesti", "trida", "sidliste"]);

export function stripDiacritics(s) {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

/** Slova názvu ulice bez ozdob ("ul.", jednopísmenné zkratky) — pro porovnání. */
export function streetTokens(street) {
  return stripDiacritics(street)
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !GENERIC_STREET_WORDS.has(t));
}

export function sameStreet(a, b) {
  const ta = streetTokens(a);
  const tb = streetTokens(b);
  return ta.length > 0 && ta.length === tb.length && ta.every((t) => tb.includes(t));
}

/** "298" / "298/12" -> { cp: "298", co: "12" | null }; jinak null. */
export function parseHouseNumber(raw) {
  const m = String(raw ?? "").trim().match(/^(\d{1,5})(?:\s*\/\s*(\d{1,3}[a-z]?))?$/i);
  return m ? { cp: m[1], co: m[2] ?? null } : null;
}

// "ulice Kubelkova 1759", "v ulici Dukelská 323", "ul. Quido Kociana 25/3".
// Jen s klíčovým slovem před názvem — holé "Slovo 123" je v textu příliš
// často cena, telefon nebo plocha. Číslo následované jednotkou (m², Kč, %…)
// se zahazuje.
const TEXT_ADDRESS_RE =
  /(?:\bul\.|\bulice\b|\bulici\b|\bulic[íi]\b|\btřída\b|\btřídě\b)\s+((?:[A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ][\wáčďéěíňóřšťúůýž.\-]*\s+){0,3}?[A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ][\wáčďéěíňóřšťúůýž.\-]*)\s+(\d{1,4})(?:\s*\/\s*(\d{1,3}))?(?![\d,]|\s*(?:m\s?[²2]|m\b|kč|%|km|let\b|min\b|tis\b|mil\b))/g;

/** Všechny dvojice (ulice, číslo domu) zmíněné v textu inzerátu. */
export function extractTextAddresses(text) {
  const found = [];
  if (!text) return found;
  for (const m of String(text).matchAll(TEXT_ADDRESS_RE)) {
    const street = m[1].replace(/[.\s]+$/, "").trim();
    if (streetTokens(street).length === 0) continue;
    found.push({ street, number: m[3] ? `${m[2]}/${m[3]}` : m[2] });
  }
  return found;
}

const METERS_PER_DEG_LAT = 111_320;

export function distanceMeters(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * METERS_PER_DEG_LAT;
  const dLon = (lon2 - lon1) * METERS_PER_DEG_LAT * Math.cos(((lat1 + lat2) / 2) * (Math.PI / 180));
  return Math.hypot(dLat, dLon);
}

// Bod leží "v budově", když je uvnitř obrysu nalezeného objektu (s malou
// tolerancí na nepřesnost mapy) — nebo, když objekt obrys nemá (adresní
// bod), do pár metrů od něj. Střed ulice leží na silnici, tedy mimo.
const BBOX_TOLERANCE_DEG = 0.00004; // ~4 m
const POINT_TOLERANCE_M = 12;

export function pinInsideBuilding(lat, lon, osm) {
  const bb = osm?.boundingbox?.map(Number);
  if (bb && bb.length === 4 && bb.every(Number.isFinite)) {
    const [south, north, west, east] = bb;
    const degenerate = north - south < 0.000005 && east - west < 0.000005;
    if (!degenerate) {
      return lat >= south - BBOX_TOLERANCE_DEG && lat <= north + BBOX_TOLERANCE_DEG && lon >= west - BBOX_TOLERANCE_DEG && lon <= east + BBOX_TOLERANCE_DEG;
    }
  }
  const olat = Number(osm?.lat);
  const olon = Number(osm?.lon);
  return Number.isFinite(olat) && Number.isFinite(olon) && distanceMeters(lat, lon, olat, olon) <= POINT_TOLERANCE_M;
}

function parseGeoJson(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function numberKey(number) {
  const p = parseHouseNumber(number);
  return p ? p.cp : String(number ?? "").trim();
}

function displayNumber(a, b) {
  // Při shodě v čísle popisném vyhraje úplnější zápis ("1737/12" nad "1737").
  return String(b).length > String(a).length ? b : a;
}

/**
 * @param members   inzeráty skupiny (řádky `listings`)
 * @param ctx       { city, geocodes(lat, lon) -> osm výsledek | null | undefined,
 *                    pinSharedBy(lat, lon) -> počet JINÝCH bytů s bodem do 8 m }
 */
export function resolveAddress(members, ctx) {
  const evidence = []; // { type, strength, street, number, src, note }
  const reasons = [];
  const streetHints = []; // ulice bez čísla (Bezrealitky, Sreality "street")

  const adHaystack = stripDiacritics(
    members.map((m) => [m.address, m.title, m.description, parseGeoJson(m.geo_json)?.text].filter(Boolean).join(" ")).join(" ")
  );
  const mentionsStreet = (street) => {
    const t = streetTokens(street);
    return t.length > 0 && t.every((w) => adHaystack.includes(w));
  };

  for (const m of members) {
    const geo = parseGeoJson(m.geo_json);
    const srcName = m.source;

    // 1) strukturovaná adresa od portálu
    if (geo) {
      const precision = geo.precision;
      if (geo.street && geo.houseNumber && (precision == null || precision === "address")) {
        const num = geo.streetNumber ? `${geo.houseNumber}/${geo.streetNumber}` : geo.houseNumber;
        evidence.push({ type: "portal", strength: "strong", street: geo.street, number: num, src: srcName, note: `${srcName}: adresa z inzerátu` });
      } else if (srcName === "sreality" && precision && precision !== "address") {
        const what = precision === "street" ? "jen ulici" : precision === "ward" ? "jen část obce" : precision === "municipality" ? "jen obec" : `jen „${precision}“`;
        reasons.push(`Sreality: prodejce označil ${what}, číslo domu tam není.`);
        if (geo.street) streetHints.push({ street: geo.street, src: srcName });
      } else if (srcName === "sreality" && precision === "address" && !geo.houseNumber) {
        reasons.push("Sreality: adresní bod bez čísla domu.");
        if (geo.street) streetHints.push({ street: geo.street, src: srcName });
      } else if (geo.street && !geo.houseNumber) {
        streetHints.push({ street: geo.street, src: srcName });
      }
    }

    // 2) číslo domu v textu inzerátu
    for (const a of [...extractTextAddresses(m.description), ...extractTextAddresses(geo?.text)]) {
      evidence.push({ type: "text", strength: "medium", street: a.street, number: a.number, src: srcName, note: `text inzerátu (${srcName})` });
    }

    // 3) bod po zpětném geokódování
    const hasPin = typeof m.lat === "number" && typeof m.lon === "number";
    const coarseSreality = srcName === "sreality" && geo && geo.precision && geo.precision !== "address";
    if (hasPin && !coarseSreality) {
      const osm = ctx.geocodes(m.lat, m.lon);
      if (osm === undefined) {
        reasons.push(`Bod z ${srcName} se ještě nezpracoval.`);
      } else if (osm === null || !osm.address?.house_number || !osm.address?.road) {
        reasons.push(`Bod z ${srcName} míří na ulici, ne na konkrétní dům.`);
        if (osm?.address?.road) streetHints.push({ street: osm.address.road, src: srcName });
      } else {
        const shared = ctx.pinSharedBy(m.lat, m.lon);
        const inside = pinInsideBuilding(m.lat, m.lon, osm);
        const streetOk = mentionsStreet(osm.address.road);
        const ev = { type: "pin", street: osm.address.road, number: osm.address.house_number, src: srcName };
        if (shared > 0) {
          reasons.push(`Bod z ${srcName} sdílí ještě ${shared} další byt${shared === 1 ? "" : "y"} — buď stejný dům, nebo jen ulice, proto se nepřiřazuje.`);
        } else if (!inside) {
          reasons.push(`Bod z ${srcName} leží vedle budovy (nejspíš jen ulice), proto se nepřiřazuje.`);
        } else if (!streetOk) {
          reasons.push(`Bod z ${srcName} vychází na ${osm.address.road} ${osm.address.house_number}, ale ulice se v inzerátu neobjevuje — jen slabý hint.`);
          evidence.push({ ...ev, strength: "weak", note: `bod z ${srcName}, ulice se v inzerátu neobjevuje` });
        } else {
          evidence.push({ ...ev, strength: "strong", note: `bod z ${srcName} uvnitř budovy, ulice sedí s inzerátem` });
        }
      }
    }
  }

  // Sjednocení důkazů s číslem domu podle (ulice, číslo popisné).
  const candidates = [];
  for (const e of evidence) {
    const key = e.street && e.number ? `${streetTokens(e.street).sort().join(" ")}|${numberKey(e.number)}` : null;
    if (!key) continue;
    let c = candidates.find((x) => x.key === key);
    if (!c) candidates.push((c = { key, street: e.street, number: e.number, evidence: [] }));
    else c.number = displayNumber(c.number, e.number);
    c.evidence.push(e);
  }

  const solid = candidates.filter((c) => c.evidence.some((e) => e.strength !== "weak"));
  const city = ctx.city || null;
  const result = { level: "none", street: null, number: null, text: null, evidence: [], reasons, candidates: candidates.map((c) => ({ street: c.street, number: c.number })) };

  if (solid.length > 1) {
    result.level = "conflict";
    result.reasons.unshift(`Zdroje si odporují (${solid.map((c) => `${c.street} ${c.number}`).join(" × ")}) — nepřiřazuje se nic.`);
    return result;
  }
  if (solid.length === 0) {
    const weak = candidates[0];
    if (weak) {
      result.level = "medium";
      result.street = weak.street;
      result.number = weak.number;
      result.text = [`${weak.street} ${weak.number}`, city].filter(Boolean).join(", ");
      result.evidence = weak.evidence;
    }
    return result;
  }

  const c = solid[0];
  const types = new Set(c.evidence.map((e) => e.type));
  const hasStrong = c.evidence.some((e) => e.type === "portal" || (e.type === "pin" && e.strength === "strong"));
  // Text sám nestačí, ale potvrzený jiným zdrojem (stejná ulice od portálu,
  // nebo jakýkoli bod se stejným číslem) ano.
  const textCorroborated =
    types.has("text") &&
    (c.evidence.some((e) => e.type === "pin" && numberKey(e.number) === numberKey(c.number)) || streetHints.some((h) => sameStreet(h.street, c.street)));

  result.street = c.street;
  result.number = c.number;
  result.text = [`${c.street} ${c.number}`, city].filter(Boolean).join(", ");
  result.evidence = c.evidence;
  result.level = hasStrong || textCorroborated ? "high" : "medium";
  return result;
}
