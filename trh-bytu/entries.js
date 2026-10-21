// Společný výpočet "entries" — jedné položky na byt (skupinu nabídek napříč portály)
// s odvozenými údaji (stav, ceny, fáze prodeje, adresa, ...). Používá ho webová appka
// (server.js) i MCP server pro dotazy v chatu (mcp-tools.js), takže oba počítají
// STEJNĚ. Čistě čte z databáze, nic nezapisuje.

import { nowIso } from "./db.js";
import { groupListings, primaryListing, mergedStatus, earliestListedAt, latestRemovedAt, priceDropSummary, latestChange, bestPrice, bestPriceListing, bestAddress, saleVerdict, mergeParams, pickOwnValue, isStarred, isHidden } from "./group.js";
import { assessSale } from "./sale-triage.js";
import { buildAddressContext, addressSuggestion } from "./auto-address.js";
import { createWatchResolver } from "./kn-scan.js";
import { buildSaleTrack } from "./kn-schedule.js";
import { isAlmostSold } from "./sale-record.js";
import { isNewBuildPending } from "./new-build.js";
import { parseUnknownFields } from "./unknown-fields.js";
import { addressInfo } from "./address-info.js";
import { extractCity, parsePriceNote } from "./parse.js";
import { REGION_WATCH } from "./region.js";

const BYTY_WATCH = REGION_WATCH;

export const SOURCE_LABELS = {
  sreality: "Sreality.cz",
  bezrealitky: "Bezrealitky.cz",
  idnes: "Reality.iDNES.cz",
  realitymix: "RealityMIX.cz",
  bazos: "Bazoš.cz",
};

export function formatCzk(n) {
  return n == null ? "—" : `${n.toLocaleString("cs-CZ")} Kč`;
}

// Portály, u kterých proběhla poslední změna skupiny — jen když skupina
// spojuje víc portálů (jinak by to byla zbytečná informace navíc). Bere
// všechny události téhož typu z téhož sběrného běhu (do 10 minut od
// poslední), protože jeden běh často zaznamená zmizení na víc portálech
// naráz. `events` = události všech členů skupiny.
export function changeSources(members, events, change) {
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

// Cena skupiny slovy pro titulek a detail. Cena bez čísla je věc portálů
// (RK ji neuvádí), ne chybějící údaj — proto se píše výslovně ("cena na
// vyžádání", u Bazoše i jeho vlastními slovy: Dohodou / Nabídněte / V
// textu), ne jako pomlčka, která vypadá jako chyba appky. Cena vyčtená z
// popisu se značí, protože text bývá zastaralý (RK cenu u inzerátu sníží a
// v textu nechá původní).
export function priceLabel(members) {
  const listing = bestPriceListing(members);
  if (listing) return formatCzk(listing.price_czk) + (listing.price_from_text ? " (z textu inzerátu)" : "");
  const notes = [...new Set(members.map((m) => parsePriceNote(m.title)).filter(Boolean))];
  return `cena na vyžádání${notes.length ? ` (${notes.join(", ")})` : ""}`;
}

// Odvozené údaje spočítané JEDNOU za skupinu, sdílené mezi přehledem
// (renderTable) a srovnávací tabulkou (renderComparisonTable) — obě jen
// čtou, žádné opakované JSON.parse/reduce nad stejnou skupinou vícekrát na
// dvou různých stránkách.
export function computeEntries(db) {
  const allListings = db.prepare("SELECT * FROM listings").all();
  // Skupiny (ne syrové řádky) — stejná nemovitost napříč portály se ukáže
  // jen jednou, viz group.js.
  const allGroups = groupListings(allListings);
  // Kde plomby hlídá API katastru (kn-scan.js), ruční kontrola podle rozvrhu
  // se nepřipomíná — bez skenů (bez klíče) vrací null a rozvrh platí celý.
  // Kontext adres (geokódování + RÚIAN) se staví jednou pro hlídání plomb, novostavby i návrhy adres.
  const actx = buildAddressContext(db, allListings, allGroups);
  const watchFor = createWatchResolver(db, allListings, allGroups, Date.now(), actx);
  const ruianCache = actx.ruianCache;

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
    const removedAt = status === "removed" || status === "sold" ? latestRemovedAt(g.members) : null;
    const { dropCount, originalPrice } = priceDropSummary(events);
    const verdict = saleVerdict(g.members);
    // Fáze prodeje po rezervaci a rozvrh kontrol v katastru (kn-schedule.js);
    // `null`, když byt nemá platnou rezervaci nebo je pořád v nabídce.
    const track = buildSaleTrack(g.members, events, Date.now(), watchFor(g));
    // Zmizelý byt BEZ rezervace hlídá API katastru stejně jako rezervované
    // (kn-scan.js, unreservedTrack): místo začátku rezervace se bere zmizení
    // inzerátu. `needsConfirm` = po zmizení se objevila plomba, kterou appka
    // nedokázala sama přiřadit.
    const unreservedWatch = !track && status === "removed" && !verdict && removedAt ? watchFor(g)?.(removedAt) ?? null : null;
    const triage = status === "removed" ? assessSale(g.members, events) : null;
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
      // Výsledek ruční kontroly v katastru (viz saleVerdict v group.js) a
      // odhad, jak pravděpodobně se zmizelý byt prodal (jen pro řazení
      // fronty /kontrola, viz sale-triage.js).
      addressInfo: (() => {
        const info = addressInfo(g.members);
        const suggestion = info.state === "missing" ? addressSuggestion(actx, g) : null;
        return { ...info, suggestion: suggestion?.text ?? null, suggestionWhy: suggestion?.why ?? null };
      })(),
      // Novostavba, jejíž adresu RÚIAN zatím nezná: v katastru se zatím nedá ověřit (new-build.js).
      newBuildPending: isNewBuildPending(g.members, ruianCache),
      // Základní údaje, které uživatel označil jako nezjistitelné (unknown-fields.js).
      unknownFields: parseUnknownFields(g.members),
      track,
      unreservedWatch,
      // Čas se podívat do katastru: nastal kontrolní bod rozvrhu a po něm se
      // ještě nekontrolovalo (viz kn-schedule.js).
      saleCandidate: Boolean(track?.due),
      knFiledAt: pickOwnValue(g.members, "kn_filed_at"),
      plombaEnd: pickOwnValue(g.members, "kn_plomba_end"),
      knAutoUnit: pickOwnValue(g.members, "kn_auto_unit"),
      lvNumber: pickOwnValue(g.members, "lv_number"),
      saleVerdict: verdict,
      knCheckedAt: g.members.reduce((max, m) => (m.kn_checked_at && m.kn_checked_at > max ? m.kn_checked_at : max), "") || null,
      triage,
      // Neověřitelný byt (družstevní / dům bez jednotek) a téměř jistě prodaný
      // (prodaný, nebo po rezervaci zmizel) — viz sale-record.js. Obojí řídí, jak
      // se byt počítá ve statistikách.
      unverifiable: Boolean(track?.unverifiable || unreservedWatch?.unverifiable),
      almostSold: isAlmostSold({ status, verdict, wasReserved: Boolean(track) || Boolean(triage?.wasReserved) }),
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
