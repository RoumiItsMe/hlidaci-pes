// Sloučení "stejné nemovitosti" napříč portály pro ZOBRAZENÍ — dispozice +
// cena přesně + plocha S TOLERANCÍ (viz AREA_TOLERANCE_M2 níž) u 2+
// RŮZNÝCH zdrojů. Stejná úvaha jako fingerprint u hlídacího psa
// (cena+plocha), jen se tu nepersistuje do state, ale počítá se čerstvě
// při KAŽDÉM zobrazení — appka žádnou "group_id" neukládá, takže se nikdy
// nemůže rozejít se skutečností (funguje okamžitě i na datech nasbíraných
// předtím).
//
// Vědomě konzervativní: přesná shoda dispozice+cena u DVOU RŮZNÝCH
// portálů, plocha jen "dost blízko" (ne nutně přesně stejná po
// zaokrouhlení — reálný případ: tentýž byt na Dukelské má na Sreality
// uvedenou plochu 51 m², na iDNES/RealityMIX 52 m², protože portály
// evidentně měří/zaokrouhlují jinak). Shoda jen v rámci JEDNOHO portálu
// (dva různé byty na Bazoši náhodou se stejnými parametry) se NIKDY
// neslučuje — je to vzácná koincidence, ne signál duplicity, a sloučení
// by tiše smazalo jeden reálný byt z přehledu. Radši dva řádky pro tutéž
// nemovitost navíc, než jeden řádek omylem za dvě různé.

// Max. rozdíl v ploše (m²), co appka ještě bere jako "tentýž byt" napříč
// portály. 1 m² pokrývá pozorovaný reálný rozdíl (51 vs 52 m² pro
// identický inzerát); víc než to už je riziko, že jde o dva různé byty se
// shodou disponice+ceny čistou náhodou (viz komentář výš).
export const AREA_TOLERANCE_M2 = 1;

function unionFind(size) {
  const parent = Array.from({ length: size }, (_, i) => i);
  function find(i) {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  }
  function union(a, b) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }
  return { find, union };
}

// Rozdělí členy JEDNOHO bucketu (stejná dispozice+cena, viz níž) na shluky
// podle plochy — dva inzeráty se shlukují, když je jejich plocha od sebe
// max. AREA_TOLERANCE_M2. Union-find nad malým polem (typicky jednotky
// prvků na bucket), ne nad celým datasetem — výkonnostně bezvýznamné.
function clusterByArea(members) {
  const { find, union } = unionFind(members.length);
  for (let i = 0; i < members.length; i++) {
    for (let j = i + 1; j < members.length; j++) {
      if (Math.abs(members[i].area_m2 - members[j].area_m2) <= AREA_TOLERANCE_M2) union(i, j);
    }
  }
  const clusters = new Map();
  for (let i = 0; i < members.length; i++) {
    const root = find(i);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root).push(members[i]);
  }
  return [...clusters.values()];
}

/**
 * Vrátí pole skupin `{ key, members, merged }` — `merged: true` jen když
 * skupina spojuje 2+ různé zdroje. Cokoli bez jednoznačného klíče (chybí
 * dispozice/plocha/cena) nebo se shodou jen v rámci jednoho zdroje zůstává
 * jako samostatná skupina o jednom členovi.
 */
export function groupListings(listings) {
  // Bucket = přesná shoda dispozice+cena (silný signál sám o sobě —
  // plocha se pak řeší až uvnitř bucketu s tolerancí, viz clusterByArea).
  const buckets = new Map();
  const groups = [];

  for (const l of listings) {
    if (l.disposition == null || l.area_m2 == null || l.price_czk == null) {
      groups.push({ key: l.id, members: [l], merged: false });
      continue;
    }
    const bucketKey = `${l.disposition}_${l.price_czk}`;
    if (!buckets.has(bucketKey)) buckets.set(bucketKey, []);
    buckets.get(bucketKey).push(l);
  }

  for (const [bucketKey, bucketMembers] of buckets) {
    for (const cluster of clusterByArea(bucketMembers)) {
      const distinctSources = new Set(cluster.map((m) => m.source));
      if (distinctSources.size > 1) {
        groups.push({ key: `${bucketKey}_${cluster.map((m) => m.id).sort().join(",")}`, members: cluster, merged: true });
      } else {
        for (const m of cluster) groups.push({ key: m.id, members: [m], merged: false });
      }
    }
  }

  return mergeRelistedGroups(groups, listings);
}

// Znovu vložený inzeráty (viz relist.js: starý inzerát má `replaced_by`
// ukazující na nový) patří k sobě, i když se ve výše spočítaném klíči
// nepotkají — nový bývá bez ceny ("Dohodou"), takže by zůstal samostatným
// řádkem vedle původního. Skupiny, které jsou takhle propojené, se spojí.
// `merged` (= nalezeno na víc PORTÁLECH) se přepočítá — dvě ID téhož portálu
// ho nezapínají.
function mergeRelistedGroups(groups, listings) {
  const groupIndexById = new Map();
  groups.forEach((g, i) => g.members.forEach((m) => groupIndexById.set(m.id, i)));

  const { find, union } = unionFind(groups.length);
  let anyLink = false;
  for (const l of listings) {
    if (!l.replaced_by) continue;
    const a = groupIndexById.get(l.id);
    const b = groupIndexById.get(l.replaced_by);
    if (a == null || b == null) continue;
    union(a, b);
    anyLink = true;
  }
  if (!anyLink) return groups;

  const byRoot = new Map();
  groups.forEach((g, i) => {
    const root = find(i);
    if (!byRoot.has(root)) byRoot.set(root, []);
    byRoot.get(root).push(g);
  });

  return [...byRoot.values()].map((parts) => {
    if (parts.length === 1) return parts[0];
    const members = parts.flatMap((g) => g.members);
    return {
      key: `relist_${members.map((m) => m.id).sort().join(",")}`,
      members,
      merged: new Set(members.map((m) => m.source)).size > 1,
    };
  });
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
// zmizení z nabídky, návrat do nabídky, znovu vložení inzerátu pod novým
// ID, a Bezrealitky-only "označeno jako
// rezervováno", jediný spolehlivý reserved příznak napříč portály — viz
// detail/bezrealitky.js). "created" (prvotní zaevidování) se nepočítá,
// to není změna, to je začátek historie.
//
// Záměrně NIKDY "naposledy upraveno od portálu" (Sreality `params.edited`
// apod.) — realitky si tohle pole bumpují i bez reálné změny nabídky
// (přesně důvod, proč to hlídací pes taky nikdy nebral jako signál "nová
// nabídka", viz sources/sreality.js). Appka věří jen tomu, co sama
// zaznamenala.
const CHANGE_EVENT_TYPES = new Set(["price_change", "removed", "reactivated", "reserved", "relisted"]);

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

// Skrytí (křížek) a TOP (hvězdička) jsou uživatelovy vlastní příznaky, ne
// data z portálu — ukládají se na jednotlivé listingy (stejně jako
// notes/verified_sale_*, viz db.js), ale ČTOU se přes CELOU skupinu, ne jen
// z primaryListing. Důvod: kdyby se pořadí SOURCE_PRIORITY pro danou
// nemovitost v čase přerovnalo (např. přibude Sreality inzerát tam, kde
// dřív byl primární jen Bazoš), příznak zapsaný na starém primárním
// listingu by jinak "zmizel", i když ho uživatel nikdy nezrušil.
export function isStarred(members) {
  return members.some((m) => m.starred);
}
export function isHidden(members) {
  return members.some((m) => m.hidden);
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
