// Ceny a souhrny prodaných bytů pro statistiky. Používá je webová appka (server.js,
// stránka Statistiky) i MCP server (mcp-tools.js), aby chat počítal stejně jako appka.
// Čisté funkce nad "entry" z computeEntries (entries.js).

import { statsSalePrice, saleEvidence } from "./sale-record.js";

// Ověřená prodejní cena (uživatel si ji dohledal v katastru) má vždy
// přednost — je to REÁLNÁ transakce. Bez ní appka bere poslední evidovanou
// (inzerovanou) cenu těsně před zmizením — návod výslovně upozorňuje, že to
// NENÍ prodejní cena (typicky o pár % výš), proto se u takových řádků
// značí "odhad" a počet ověřených/odhadnutých se ukazuje zvlášť. To platí i
// pro byt, který portál označil jako PRODÁNO: je to fakt o prodeji, ale cena
// u inzerátu je jen poslední inzerovaná, ne kupní — jde do fronty Katastr
// ověřit. Výjimka: družstevní byt (v katastru se ověřit nedá) — tam je byt
// hotový a bere se poslední cena z portálu, ale SNÍŽENÁ o ASSUMED_PRICE_DISCOUNT
// (kupní cena bývá nižší než inzerovaná) a ve statistikách je označená jako
// odhad (`statsSalePrice`, sale-record.js).
export function effectivePriceForStats(e) {
  // Poslední cena snížená o koeficient: portálem prodaný byt, který jde ověřit
  // jen těžko (priceAssumed), i každý prodaný/zmizelý byt, který se v katastru
  // ověřit nedá — jinak by o jeho ceně nebylo vůbec nic, a přitom jde o téměř
  // jistý prodej.
  const assumed = Boolean(e.track?.priceAssumed) || (e.unverifiable && (e.status === "removed" || e.status === "sold" || e.status === "reserved"));
  return statsSalePrice({ verified: e.verifiedSalePrice, price: e.price, assumed });
}

// Byt patří do statistiky "ceny po rekonstrukci", pokud to uživatel vědomě
// nepřehlasoval (`statsInclude`, viz OWN_FIELDS "Ve statistice") — jinak
// auto-kritérium: zmizel z nabídky (= pravděpodobně prodáno/rezervováno
// jinde) nebo ho portál označil jako prodaný, A appka/uživatel ho označili
// jako "Po rekonstrukci". Novostavba se SCHVÁLNĚ nepočítá do stejného koše
// (jiný cenový segment), kdo ji chce zahrnout, přehlasuje ručně přes
// "Zahrnout".
export function isEligibleForRenoStats(e) {
  if (e.statsInclude === "exclude") return false;
  if (e.statsInclude === "include") return true;
  // Zmizelý byt, o kterém uživatel v katastru ověřil, že se neprodal, není
  // doklad o ceně, za kterou se prodávají byty.
  if (e.saleVerdict === "withdrawn") return false;
  return (e.status === "removed" || e.status === "sold") && e.ownCondition === "renovated";
}

// Souhrn "cena/m² u prodaných bytů po rekonstrukci" — PRIMÁRNĚ podle
// města, uvnitř každého města rozpad podle dispozice (přesně v tomhle
// pořadí chtěl uživatel, ne dvě oddělené tabulky vedle sebe). Vrací i
// `count` u každého řádku, ať je i při řídkých datech vidět velikost
// vzorku — appka si nic nevymýšlí za nedostatek dat, jen ho ukáže.
export function renovatedSaleStats(entries) {
  return soldSaleStats(entries, isEligibleForRenoStats);
}

// Prodané a téměř jistě prodané byty se stavem "V TOPu" (own_condition = top): za kolik
// se prodávají nejlepší byty. Stejný vzorek a cena jako almostSoldSaleStats, jen užší.
// Po rekonstrukci má spoustu podob (levná i drahá), proto TOP není součástí "Po
// rekonstrukci" — je to samostatný koš a ceny se nemíchají. Ruční "Ve statistice:
// vyřadit" platí i tady.
export function topSaleStats(entries) {
  return soldSaleStats(entries, (e) => e.almostSold && e.statsInclude !== "exclude" && e.ownCondition === "top");
}

// Prodané a téměř jistě prodané byty bez ohledu na stav bytu: to, o co v
// appce hlavně jde. Ruční "Ve statistice: vyřadit" platí i tady.
export function almostSoldSaleStats(entries) {
  return soldSaleStats(entries, (e) => e.almostSold && e.statsInclude !== "exclude");
}

function soldSaleStats(entries, isEligible) {
  const eligible = entries
    .filter(isEligible)
    .map((e) => ({
      pricePerM2: (() => {
        const { price } = effectivePriceForStats(e);
        return price != null && e.rep.area_m2 ? price / e.rep.area_m2 : null;
      })(),
      disposition: e.rep.disposition || "—",
      city: e.city || "—",
      basis: effectivePriceForStats(e).basis, // verified | assumed | asking
      // Pro rozklikávací seznam bytů za průměrem (viz renderCityStatsTable)
      // — appka jinak ukazovala jen holé číslo bez možnosti ověřit, ze
      // kterých konkrétních bytů vzniklo.
      id: e.rep.id,
      address: e.address || e.city,
      areaM2: e.rep.area_m2,
      evidence: saleEvidence(e.status),
    }))
    .filter((r) => r.pricePerM2 != null);

  function summarize(rows) {
    const values = rows.map((r) => r.pricePerM2);
    return {
      count: rows.length,
      verifiedCount: rows.filter((r) => r.basis === "verified").length,
      assumedCount: rows.filter((r) => r.basis === "assumed").length,
      pendingCount: rows.filter((r) => r.basis === "pending").length,
      avg: Math.round(values.reduce((s, v) => s + v, 0) / values.length),
      min: Math.round(Math.min(...values)),
      max: Math.round(Math.max(...values)),
      // Od nejlevnějšího po nejdražší — stejné pořadí, v jakém appka jinak
      // ukazuje rozsah (min–max).
      items: rows.slice().sort((a, b) => a.pricePerM2 - b.pricePerM2),
    };
  }

  const byCity = new Map();
  for (const r of eligible) {
    if (!byCity.has(r.city)) byCity.set(r.city, new Map());
    const byDisposition = byCity.get(r.city);
    if (!byDisposition.has(r.disposition)) byDisposition.set(r.disposition, []);
    byDisposition.get(r.disposition).push(r);
  }

  const cities = [...byCity.entries()]
    .map(([city, byDisposition]) => {
      const dispositions = [...byDisposition.entries()]
        .map(([disposition, rows]) => ({ disposition, ...summarize(rows) }))
        .sort((a, b) => b.count - a.count);
      const totalCount = dispositions.reduce((sum, d) => sum + d.count, 0);
      return { city, dispositions, totalCount };
    })
    .sort((a, b) => b.totalCount - a.totalCount);

  // Souhrn přes všechna města a dispozice (cena/m² různých dispozic se tu míchá, ale u malého
  // vzorku je to jediné číslo, které vůbec něco říká) — null, když není z čeho.
  const overall = eligible.length ? (({ items, ...rest }) => rest)(summarize(eligible)) : null;
  return { cities, totalEligible: eligible.length, overall };
}
