// Jednorázový (ale bezpečně opakovatelný) přepočet dispozice/adresy pro
// existující záznamy v DB.
//
// track.js dopočítává disposition/address z title+description jen při
// PRVNÍM zaevidování inzerátu (viz "Nový inzerát" větev v processSource) —
// když se pak parse.js vylepší (nová heuristika, další skloňovaný tvar),
// staré řádky v DB zůstávají nedotčené navždy, dokud je někdo ručně
// nepřepočítá. Tenhle skript to udělá: projde záznamy s chybějící
// disposition/address a zkusí je dopočítat ze SVÝCH VLASTNÍCH title/
// description, které appka už má uložené — žádný nový network fetch.
//
// Idempotentní: nikdy nepřepíše hodnotu, která už je vyplněná (jen NULL →
// něco), takže jde spustit opakovaně po každé úpravě parse.js bez rizika.
//
// Spuštění: node trh-bytu/backfill-parse.js

import { openDb } from "./db.js";
import { parseDisposition, parseAddressFromTitle, findKnownPlace } from "./parse.js";
import { watches } from "../config.js";

const watch = watches.find((w) => w.key === "byty");
if (!watch) throw new Error('watch "byty" nenalezen v config.js');

const db = openDb();
const rows = db.prepare("SELECT id, title, description, address, disposition FROM listings WHERE disposition IS NULL OR address IS NULL").all();

let fixedDisposition = 0;
let fixedAddress = 0;

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
    // Stejné čtyři úrovně jako v track.js (portálové pole tady chybí, DB
    // ho pro tenhle běh nemá k dispozici) — konec titulku → město přímo v
    // titulku → město v popisu.
    const address = parseAddressFromTitle(row.title) ?? findKnownPlace(row.title, watch) ?? findKnownPlace(row.description, watch);
    if (address != null) {
      updates.address = address;
      fixedAddress++;
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

console.log(`Hotovo. Zkoumáno ${rows.length} záznamů s chybějící dispozicí/adresou — dispozice doplněna u ${fixedDisposition}, adresa u ${fixedAddress}.`);
db.close();
