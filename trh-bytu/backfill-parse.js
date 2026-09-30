// Jednorázový (ale bezpečně opakovatelný) přepočet dispozice/adresy pro
// existující záznamy v DB.
//
// track.js dopočítává disposition/address z title+description jen při
// PRVNÍM zaevidování inzerátu (viz "Nový inzerát" větev v processSource) —
// když se pak parse.js vylepší (nová heuristika, další skloňovaný tvar),
// staré řádky v DB zůstávají nedotčené navždy, dokud je někdo ručně
// nepřepočítá. Tenhle skript to udělá ve DVOU fázích:
//
//   1. Offline — z title/description, které appka už má uložené. Žádný
//      network fetch, běží na všech zdrojích.
//   2. Bazoš-only síťová fáze — PSČ (viz zipToKnownPlace) appka historicky
//      neukládala, DB ho tedy nemá k dispozici offline. Pro záznamy, co po
//      fázi 1 pořád nemají adresu, znovu navštíví jejich Bazoš detail (jen
//      Bazoš — jediný zdroj s touhle úrovní, viz track.js) a zkusí PSČ
//      odsud. Zdvořilostní pauza mezi requesty jako v track.js.
//
// Idempotentní: nikdy nepřepíše hodnotu, která už je vyplněná (jen NULL →
// něco), takže jde spustit opakovaně po každé úpravě parse.js bez rizika.
//
// Spuštění: node trh-bytu/backfill-parse.js

import { openDb } from "./db.js";
import { parseDisposition, parseAddressFromTitle, findKnownPlace, zipToKnownPlace } from "./parse.js";
import { fetchBazosDetail } from "./detail/bazos.js";
import { watches } from "../config.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const watch = watches.find((w) => w.key === "byty");
if (!watch) throw new Error('watch "byty" nenalezen v config.js');

const db = openDb();
const rows = db.prepare("SELECT id, source, url, title, description, address, disposition FROM listings WHERE disposition IS NULL OR address IS NULL").all();

let fixedDisposition = 0;
let fixedAddress = 0;
const stillMissingAddress = [];

// --- Fáze 1: offline, ze SVÝCH VLASTNÍCH title/description ---
for (const row of rows) {
  const updates = {};

  if (row.disposition == null) {
    const disposition = parseDisposition(row.title) ?? parseDisposition(row.description);
    if (disposition != null) {
      updates.disposition = disposition;
      fixedDisposition++;
    }
  }

  if (row.address == null) {
    // Stejné úrovně jako v track.js kromě PSČ (to offline nemáme, viz fáze 2)
    // — konec titulku → město přímo v titulku → město v popisu.
    const address = parseAddressFromTitle(row.title) ?? findKnownPlace(row.title, watch) ?? findKnownPlace(row.description, watch);
    if (address != null) {
      updates.address = address;
      fixedAddress++;
    } else if (row.source === "bazos") {
      stillMissingAddress.push(row);
    }
  }

  if (Object.keys(updates).length > 0) {
    const setClause = Object.keys(updates)
      .map((k) => `${k} = ?`)
      .join(", ");
    db.prepare(`UPDATE listings SET ${setClause} WHERE id = ?`).run(...Object.values(updates), row.id);
    console.log(`${row.id}: ${JSON.stringify(updates)}`);
  }
}

// --- Fáze 2: Bazoš PSČ, vyžaduje znovu navštívit detail ---
for (const row of stillMissingAddress) {
  const detail = await fetchBazosDetail(row.url);
  const address = zipToKnownPlace(detail.zip, watch);
  if (address != null) {
    db.prepare("UPDATE listings SET address = ? WHERE id = ?").run(address, row.id);
    fixedAddress++;
    console.log(`${row.id}: {"address":"${address}"} (PSČ ${detail.zip})`);
  }
  await sleep(300); // zdvořilost vůči portálu, stejná pauza jako track.js
}

console.log(
  `Hotovo. Zkoumáno ${rows.length} záznamů s chybějící dispozicí/adresou (z toho ${stillMissingAddress.length} dotázáno na Bazoš PSČ) — dispozice doplněna u ${fixedDisposition}, adresa u ${fixedAddress}.`
);
db.close();
