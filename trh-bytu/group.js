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

// Pořadí důvěryhodnosti dat napříč portály, u sloučené nemovitosti se z
// něj odvozuje "primární" zdroj — na výslovné přání uživatele ("brát
// primárně data z Sreality/iDNES, až potom Bazoš nebo RealityMIX — na
// těch 2 serverech bývá nejvíc dat"). Bezrealitky uživatel nejmenoval
// (v tomhle regionu má appka zatím jen 1 její inzerát), ale datově patří
// vedle Sreality — je to jediný další zdroj se strukturovanými parametry
// (viz params.js) — takže je zařazená hned za dvojici, kterou uživatel
// výslovně chtěl nahoře.
const SOURCE_PRIORITY = ["sreality", "idnes", "bezrealitky", "realitymix", "bazos"];

function sourceRank(source) {
  const idx = SOURCE_PRIORITY.indexOf(source);
  return idx === -1 ? SOURCE_PRIORITY.length : idx;
}

/** Členové skupiny seřazení podle důvěryhodnosti zdroje (viz SOURCE_PRIORITY), s deterministickým rozstřelem podle ID. */
function byPriority(members) {
  return [...members].sort((a, b) => sourceRank(a.source) - sourceRank(b.source) || a.id.localeCompare(b.id));
}

/**
 * Deterministický "hlavní" záznam skupiny — nejdůvěryhodnější zdroj podle
 * SOURCE_PRIORITY (pro poznámky, URL a základní údaje v titulku dlaždice).
 */
export function primaryListing(members) {
  return byPriority(members)[0];
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

// Typy událostí, co appka počítá jako SKUTEČNOU pozdější změnu u už
// zaevidovaného inzerátu — výhradně z VLASTNÍ historie appky (změna ceny,
// zmizení z nabídky, návrat do nabídky, a Bezrealitky-only "označeno jako
// rezervováno", jediný spolehlivý reserved příznak napříč portály — viz
// detail/bezrealitky.js). "created" (prvotní zaevidování) se nepočítá,
// to není změna, to je začátek historie.
//
// Záměrně NIKDY "naposledy upraveno od portálu" (Sreality `params.edited`
// apod.) — realitky si tohle pole bumpují i bez reálné změny nabídky
// (přesně důvod, proč to hlídací pes taky nikdy nebral jako signál "nová
// nabídka", viz sources/sreality.js). Appka věří jen tomu, co sama
// zaznamenala.
const CHANGE_EVENT_TYPES = new Set(["price_change", "removed", "reactivated", "reserved"]);

/**
 * Poslední skutečná změna napříč danými událostmi (viz CHANGE_EVENT_TYPES
 * výš) — `null`, když k žádné zatím nedošlo. Bere se přímo pole `events`
 * (typicky spojené ze všech členů skupiny), ne mapa — volající si eventy
 * pro skupinu poskládá sám (viz server.js).
 */
export function latestChange(events) {
  let best = null;
  for (const e of events) {
    if (!CHANGE_EVENT_TYPES.has(e.event_type)) continue;
    if (!best || e.occurred_at > best.occurred_at) best = e;
  }
  return best;
}

/** Skupinu, do které patří daný listing (podle ID), z pole VŠECH inzerátů. */
export function findGroupForListing(allListings, listingId) {
  const groups = groupListings(allListings);
  return groups.find((g) => g.members.some((m) => m.id === listingId)) || null;
}

/**
 * Jeden popis za skupinu, ne od každého portálu zvlášť — uživatel ho
 * nepotřebuje vícekrát. Bere se od nejdůvěryhodnějšího zdroje, co popis
 * MÁ (viz SOURCE_PRIORITY) — když ho nemá Sreality/iDNES, ale má ho
 * Bazoš/RealityMIX, appka radši ukáže ten, než nic. Vrací `null`, když
 * popis nemá žádný člen skupiny.
 */
export function pickDescription(members) {
  return byPriority(members).find((m) => m.description) || null;
}

/**
 * Nejlepší dostupná adresa napříč členy skupiny — stejná úvaha jako u
 * popisu: bere se od nejdůvěryhodnějšího zdroje, co adresu vůbec má.
 */
export function bestAddress(members) {
  const withAddress = byPriority(members).find((m) => m.address);
  return withAddress ? withAddress.address : null;
}

/**
 * Sloučí strukturované parametry (vlastnictví, stav, podlaží...) napříč
 * členy skupiny — pro každé pole se bere hodnota od nejdůvěryhodnějšího
 * zdroje, co ho má (v praxi jde skoro vždy jen o volbu mezi Sreality a
 * Bezrealitky — jediné dva zdroje s params vůbec, viz params.js — a
 * Sreality je v SOURCE_PRIORITY výš). Vrací obyčejný objekt
 * `{ pole: hodnota }` bez `null` položek.
 */
export function mergeParams(members) {
  const merged = {};
  for (const m of byPriority(members)) {
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
