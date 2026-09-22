// Stažení fotek inzerátu na lokální disk (data/photos/<listingId>/N.jpg).
// Na rozdíl od hlídacího psa appka fotky ukládá natrvalo — po stažení
// inzerátu z portálu odkaz na fotku obvykle přestane fungovat, takže
// "jen si uložit URL" by časem znamenalo prázdné obrázky u prodaných bytů.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PHOTOS_DIR } from "./db.js";

export const MAX_PHOTOS_PER_LISTING = 10;

function extFromUrl(url) {
  const m = url.match(/\.(jpe?g|png|webp)(?:$|\?)/i);
  return m ? m[1].toLowerCase().replace("jpeg", "jpg") : "jpg";
}

/**
 * Stáhne až `MAX_PHOTOS_PER_LISTING` fotek pro daný inzerát a vrátí pole
 * `{ localPath (relativní k data/), sourceUrl }`. Fail-soft na úrovni
 * jednotlivé fotky — když jedna nejde stáhnout, ostatní se stáhnou dál
 * (portály občas mají nestabilní CDN, viz zkušenost hlídacího psa).
 *
 * `onWarn` (volitelné) — appka běží na pozadí bez dohledu (naplánovaná
 * úloha), takže selhání nesmí zůstat jen v konzoli, kterou nikdo nevidí;
 * když je předané, jde (i) do track.log přes track.js's log().
 *
 * Zjištěno naostro: Sreality CDN (d18-a.sdn.cz) vrací 401 "Unauthorized"
 * na KAŽDOU fotku bez ohledu na hlavičky (User-Agent, Referer) nebo na to,
 * jak čerstvě po načtení detailu se o fotku žádá — nejde o expirovaný token,
 * ale o anti-hotlink ochranu, která vyžaduje něco, co prostý HTTP fetch
 * nedokáže replikovat (pravděpodobně browser-fingerprint/JS token). U
 * Sreality tak appka fotky nikdy nezíská — zdokumentováno v README, stejný
 * princip jako chybějící popis u RealityMIX (fail-soft, ne shozený běh).
 */
export async function downloadPhotos(listingId, photoUrls, onWarn) {
  const urls = photoUrls.slice(0, MAX_PHOTOS_PER_LISTING);
  if (urls.length === 0) return [];

  const safeDirName = listingId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const dir = path.join(PHOTOS_DIR, safeDirName);
  mkdirSync(dir, { recursive: true });

  const results = [];
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const filename = `${i + 1}.${extFromUrl(url)}`;
      writeFileSync(path.join(dir, filename), buf);
      // Vždy lomítko dopředu (ne path.join, který by na Windows vrátil
      // zpětné lomítko) — local_path se ukládá do DB a používá v URL
      // adresách webu, kde zpětné lomítko není spolehlivý oddělovač.
      results.push({ localPath: `photos/${safeDirName}/${filename}`, sourceUrl: url });
    } catch (err) {
      const msg = `[photos] nepodařilo se stáhnout ${url}: ${err.message}`;
      if (onWarn) onWarn(msg);
      else console.warn(msg);
    }
    // Krátká pauza mezi fotkami — zdvořilost vůči portálu (stejný princip
    // jako sleep(400) mezi Telegram zprávami u hlídacího psa).
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return results;
}
