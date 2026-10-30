// Zdroje nabídek aktuálního regionu (výpis + detail) — jedno místo, které sdílí sběr na PC (track.js) i cloudový
// sběrač (scout.js). Výchozí region čte portály přes ../sources/*.js (sdílené s hlídacím psem), další regiony přes
// vlastní zdroje s okresem a obcí (region-sources.js).

import { REGION } from "./region.js";
import { regionSources } from "./region-sources.js";
import { splitByAddress } from "./region-guard.js";
import { fetchSrealityAllPages } from "../sources/sreality.js";
import { fetchBezrealitky } from "../sources/bezrealitky.js";
import { fetchIdnes } from "../sources/idnes.js";
import { fetchRealitymix } from "../sources/realitymix.js";
import { fetchBazos } from "../sources/bazos.js";
import { fetchSrealityDetail } from "./detail/sreality.js";
import { fetchBezrealitkyDetail } from "./detail/bezrealitky.js";
import { fetchIdnesDetail } from "./detail/idnes.js";
import { fetchRealitymixDetail } from "./detail/realitymix.js";
import { fetchBazosDetail } from "./detail/bazos.js";

/**
 * Zdroje regionu: `{ name, fetchList(watch), fetchDetail(url), reservationFromDetail?, soldFromDetail? }`.
 * `log` dostane hlášky o vyřazených nabídkách (RealityMIX mimo sledovanou oblast).
 */
export function buildSources(log) {
  // RealityMIX doplňuje výpis malého města (Letohrad) nabídkami odjinud — z okresu
  // i z jiného kraje (Pardubice); sdílený zdroj je nefiltruje. Nabídky s adresou
  // mimo sledované lokality se tu vyřadí (viz region-guard.js; zbytek chytí kontrola
  // polohy z detailu v processSource).
  async function fetchRealitymixInArea(watch) {
    const { kept, dropped } = splitByAddress(await fetchRealitymix(watch), watch);
    if (dropped.length) log(`[realitymix] mimo sledovanou oblast (přeskočeno): ${dropped.map((d) => `${d.id} (${d.address})`).join(", ")}`);
    return kept;
  }

  const defaultSources = [
    // Sreality stahujeme přes VŠECHNY stránky výpisu — jen z 1. stránky by
    // starší inzeráty vytlačené novějšími vypadaly jako zmizelé.
    // Sreality nemá příznak rezervace ve výpisu, jen na detailu — proto se u
    // něj detail čte i u známých inzerátů (`reservationFromDetail`); ostatní
    // portály (iDNES, RealityMIX, Bezrealitky) ho mají už ve výpisu.
    { name: "sreality", fetchList: fetchSrealityAllPages, fetchDetail: fetchSrealityDetail, reservationFromDetail: true },
    { name: "bezrealitky", fetchList: fetchBezrealitky, fetchDetail: fetchBezrealitkyDetail },
    // iDNES má štítek "prodáno" jen na detailu, ne ve výpisu — proto se detail
    // čte i u známých inzerátů (`soldFromDetail`), dokud nejsou označené jako
    // prodané.
    { name: "idnes", fetchList: fetchIdnes, fetchDetail: fetchIdnesDetail, soldFromDetail: true },
    { name: "realitymix", fetchList: fetchRealitymixInArea, fetchDetail: fetchRealitymixDetail },
    { name: "bazos", fetchList: fetchBazos, fetchDetail: fetchBazosDetail },
  ];

  // Další regiony (region.js) čtou portály přes vlastní zdroje s okresem a obcí
  // regionu (region-sources.js); výchozí region zůstává přesně jak byl.
  return REGION.watch ? regionSources(REGION) : defaultSources;
}
