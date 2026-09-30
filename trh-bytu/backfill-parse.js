// Jednorázový (ale bezpečně opakovatelný) přepočet dispozice/adresy/
// vlastního hodnocení pro existující záznamy v DB.
//
// track.js dopočítává disposition/address/own_* z title/description jen při
// PRVNÍM zaevidování inzerátu (viz "Nový inzerát" větev v processSource) —
// když se pak parse.js/detect-own-fields.js vylepší (nová heuristika, další
// skloňovaný tvar, nové klíčové slovo), staré řádky v DB zůstávají
// nedotčené navždy, dokud je někdo ručně nepřepočítá. Tenhle skript to
// udělá ve TŘECH fázích:
//
//   1. Offline — dispozice/adresa z title/description, které appka už má
//      uložené. Žádný network fetch, běží na všech zdrojích.
//   2. Bazoš-only síťová fáze — PSČ (viz zipToKnownPlace) appka historicky
//      neukládala, DB ho tedy nemá k dispozici offline. Pro záznamy, co po
//      fázi 1 pořád nemají adresu, znovu navštíví jejich Bazoš detail (jen
//      Bazoš — jediný zdroj s touhle úrovní, viz track.js) a zkusí PSČ
//      odsud. Zdvořilostní pauza mezi requesty jako v track.js.
//   3. Offline — vlastní hodnocení (own_condition/own_construction/
//      own_revitalized, viz detect-own-fields.js), taky z title/
//      description. Nezávislé na fázích 1-2.
//
// Idempotentní: nikdy nepřepíše hodnotu, která už je vyplněná (jen NULL →
// něco) — ani hodnotu, kterou mezitím ručně upravil uživatel přes <select> v
// appce — takže jde spustit opakovaně po každé úpravě parse.js/
// detect-own-fields.js bez rizika.
//
// Spuštění: node trh-bytu/backfill-parse.js

import { openDb } from "./db.js";
import { parseDisposition, parseAddressFromTitle, findKnownPlace, zipToKnownPlace } from "./parse.js";
import { detectOwnCondition, detectOwnConstruction, detectOwnRevitalized } from "./detect-own-fields.js";
import { fetchBazosDetail } from "./detail/bazos.js";
import { watches } from "../config.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const watch = watches.find((w) => w.key === "byty");
if (!watch) throw new Error('watch "byty" nenalezen v config.js');

const db = openDb();

// --- Fáze 1: offline, dispozice/adresa ze SVÝCH VLASTNÍCH title/description ---
const rows = db.prepare("SELECT id, source, url, title, description, address, disposition FROM listings WHERE disposition IS NULL OR address IS NULL").all();

let fixedDisposition = 0;
let fixedAddress = 0;
const stillMissingAddress = [];

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
  `Fáze 1-2 hotovo. Zkoumáno ${rows.length} záznamů s chybějící dispozicí/adresou (z toho ${stillMissingAddress.length} dotázáno na Bazoš PSČ) — dispozice doplněna u ${fixedDisposition}, adresa u ${fixedAddress}.`
);

// --- Fáze 3: offline, vlastní hodnocení (own_condition/own_construction/own_revitalized) ---
const ownRows = db
  .prepare(
    "SELECT id, title, description, own_condition, own_construction, own_revitalized FROM listings WHERE own_condition IS NULL OR own_construction IS NULL OR own_revitalized IS NULL"
  )
  .all();

let fixedCondition = 0;
let fixedConstruction = 0;
let fixedRevitalized = 0;

for (const row of ownRows) {
  const updates = {};
  const text = `${row.title || ""} ${row.description || ""}`;

  // Kontrola `row.own_* == null` je tu záměrně, ne jen "detekce něco
  // našla" — řádek se do `ownRows` dostal, i když třeba jen JEDNO ze tří
  // polí je NULL; ostatní dvě může mít nastavené UŽIVATEL ručně a ty se
  // nesmí přepsat, i kdyby detekce z textu vyšla na jinou hodnotu.
  if (row.own_condition == null) {
    const condition = detectOwnCondition(text);
    if (condition != null) {
      updates.own_condition = condition;
      fixedCondition++;
    }
  }
  if (row.own_construction == null) {
    const construction = detectOwnConstruction(text);
    if (construction != null) {
      updates.own_construction = construction;
      fixedConstruction++;
    }
  }
  if (row.own_revitalized == null) {
    const revitalized = detectOwnRevitalized(text);
    if (revitalized != null) {
      updates.own_revitalized = revitalized;
      fixedRevitalized++;
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

console.log(
  `Fáze 3 hotovo. Zkoumáno ${ownRows.length} záznamů s chybějícím vlastním hodnocením — stav doplněn u ${fixedCondition}, konstrukce u ${fixedConstruction}, revitalizace u ${fixedRevitalized}.`
);

db.close();
