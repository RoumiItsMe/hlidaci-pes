// Sloučení "stejné nemovitosti" napříč portály pro ZOBRAZENÍ — dispozice +
// plocha (zaokrouhlená na celé m², ať drobné rozdíly v přesnosti mezi
// portály — "67" vs "66,5" vs "67,29" — neminou shodu) + cena u 2+ RŮZNÝCH
// zdrojů. Stejná úvaha jako fingerprint u hlídacího psa (cena+plocha), jen
// se tu nepersistuje do state, ale počítá se čerstvě při KAŽDÉM zobrazení
// — appka žádnou "group_id" neukládá, takže se nikdy nemůže rozejít se
// skutečností (funguje okamžitě i na datech nasbíraných předtím).
//
// Vědomě konzervativní: přesná shoda dispozice+plocha+cena u DVOU RŮZNÝCH
// portálů. Shoda jen v rámci JEDNOHO portálu (dva různé byty na Bazoši
// náhodou se stejnými parametry) se NIKDY neslučuje — je to vzácná
// koincidence, ne signál duplicity, a sloučení by tiše smazalo jeden
// reálný byt z přehledu. Radši dva řádky pro tutéž nemovitost navíc, než
// jeden řádek omylem za dvě různé.

function groupKey(listing) {
  if (listing.disposition == null || listing.area_m2 == null || listing.price_czk == null) return null;
  return `${listing.disposition}_${Math.round(listing.area_m2)}_${listing.price_czk}`;
}

/**
 * Vrátí pole skupin `{ key, members, merged }` — `merged: true` jen když
 * skupina spojuje 2+ různé zdroje. Cokoli bez jednoznačného klíče nebo se
 * shodou jen v rámci jednoho zdroje zůstává jako samostatná skupina o
 * jednom členovi.
 */
export function groupListings(listings) {
  const byKey = new Map();
  const groups = [];

  for (const l of listings) {
    const key = groupKey(l);
    if (key == null) {
      groups.push({ key: l.id, members: [l], merged: false });
      continue;
    }
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(l);
  }

  for (const [key, members] of byKey) {
    const distinctSources = new Set(members.map((m) => m.source));
    if (distinctSources.size > 1) {
      groups.push({ key, members, merged: true });
    } else {
      for (const m of members) groups.push({ key: m.id, members: [m], merged: false });
    }
  }

  return groups;
}

/** Deterministický "hlavní" záznam skupiny (pro poznámky/URL) — vždy stejný bez ohledu na pořadí. */
export function primaryListing(members) {
  return [...members].sort((a, b) => a.id.localeCompare(b.id))[0];
}

/** V nabídce, pokud je aktivní ALESPOŇ na jednom portálu; jinak rezervováno; jinak zmizelo všude. */
export function mergedStatus(members) {
  if (members.some((m) => m.status === "active")) return "active";
  if (members.some((m) => m.status === "reserved")) return "reserved";
  return "removed";
}

export function earliestFirstSeen(members) {
  return members.reduce((min, m) => (m.first_seen_at < min ? m.first_seen_at : min), members[0].first_seen_at);
}

/** Skupinu, do které patří daný listing (podle ID), z pole VŠECH inzerátů. */
export function findGroupForListing(allListings, listingId) {
  const groups = groupListings(allListings);
  return groups.find((g) => g.members.some((m) => m.id === listingId)) || null;
}

/**
 * Jeden popis za skupinu, ne od každého portálu zvlášť — uživatel ho
 * nepotřebuje vícekrát. Vybírá se nejdelší (nejvíc informace), s
 * deterministickým rozstřelem podle ID, ať se výběr při znovunačtení
 * stránky neliší. Vrací `null`, když popis nemá žádný člen skupiny.
 */
export function pickDescription(members) {
  const withDescription = members.filter((m) => m.description);
  if (withDescription.length === 0) return null;
  return [...withDescription].sort(
    (a, b) => b.description.length - a.description.length || a.id.localeCompare(b.id)
  )[0];
}

/**
 * Nejlepší (nejdelší = zpravidla nejpodrobnější, ideálně vč. ulice) adresa
 * napříč členy skupiny. Stejná "nejdelší vyhrává" úvaha jako u popisu —
 * portály dávají adresu v různé podrobnosti ("Ulice, Město" vs. jen
 * "Město"), delší řetězec skoro vždy nese víc informace, ne míň.
 */
export function bestAddress(members) {
  const candidates = members.map((m) => m.address).filter(Boolean);
  if (candidates.length === 0) return null;
  return [...candidates].sort((a, b) => b.length - a.length)[0];
}

/**
 * Sloučí strukturované parametry (vlastnictví, stav, podlaží...) napříč
 * členy skupiny — pro každé pole se bere první nalezená hodnota (jen
 * Sreality a Bezrealitky je vyplňují, viz params.js, takže v drtivé
 * většině skupin má hodnotu nejvýš jeden člen a "první nalezená" je jediná
 * k mání). Vrací obyčejný objekt `{ pole: hodnota }` bez `null` položek.
 */
export function mergeParams(members) {
  const merged = {};
  for (const m of members) {
    if (!m.params_json) continue;
    let params;
    try {
      params = JSON.parse(m.params_json);
    } catch {
      continue;
    }
    for (const [key, value] of Object.entries(params)) {
      if (value != null && merged[key] == null) merged[key] = value;
    }
  }
  return merged;
}
