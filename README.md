# 🐕 Hlídací pes

Automatický hlídač nových nabídek nemovitostí. Každých ~15 minut projde
nastavené realitní portály a o nových inzerátech (odpovídajících filtru)
pošle notifikaci na Telegram.

## Aktuální filtr

- **Nabídka:** prodej bytů (jakákoli dispozice)
- **Lokalita:** Ústí nad Orlicí (PSČ 562 01) + okolí 5 km
- **Cena / plocha:** bez omezení

Filtr se mění v [`config.js`](config.js).

## Sledované portály

| Portál | Jak se čte | Přesnost lokality |
|---|---|---|
| [Sreality.cz](https://www.sreality.cz) | embedded JSON (SSR) | přesný 5km okruh (GPS filtr) |
| [Bezrealitky.cz](https://www.bezrealitky.cz) | embedded JSON (SSR) | přesný 5km okruh (GPS filtr) |
| [Reality.iDNES.cz](https://reality.idnes.cz) | HTML | město Ústí nad Orlicí (bez GPS, širší okolí nelze filtrovat) |
| [RealityMIX.cz](https://realitymix.cz) | HTML | město Ústí nad Orlicí (bez GPS, širší okolí nelze filtrovat) |
| [Bazoš.cz](https://reality.bazos.cz) | RSS | přesný 5km okruh (nativní parametr portálu) |

U iDNES a RealityMIX portály nenabízí GPS souřadnice u jednotlivých
inzerátů v seznamu ani radius-search, takže se bere jen samotné město —
okolní vesnice v okruhu 5 km tyhle dva zdroje nepokryjí. Sreality,
Bezrealitky a Bazoš mají přesný 5km okruh.

## Jak to funguje

1. `.github/workflows/watch.yml` spouští `node index.js` cca každých 15
   minut (GitHub Actions cron, minimální praktický interval — přesně na
   minutu to negarantuje, ale v praxi sedí).
2. `index.js` stáhne aktuální nabídku z každého portálu, porovná ji s
   `data/seen.json` (co už bylo dřív vidět) a o nových inzerátech pošle
   zprávu přes Telegram bota.
3. Aktualizovaný `data/seen.json` se po každém běhu commitne zpátky do
   repa — tak stav přežije mezi jednotlivými spuštěními Action.
4. **První běh pro každý zdroj** aktuální nabídku jen "zabaseline" (uloží
   jako už viděnou) BEZ posílání notifikací — jinak by first run zaplavil
   Telegram desítkami zpráv o inzerátech, co tam visí už dlouho.

## Lokální spuštění / test

```bash
npm install
TELEGRAM_BOT_TOKEN=xxx TELEGRAM_CHAT_ID=xxx node index.js
```

Bez nastavených env proměnných skript baseline krok (stažení + uložení
stavu) provede v pořádku, jen při pokusu o odeslání notifikace (pokud by
nějaká nová položka byla) vyhodí chybu.

## Telegram bot

Bot: **[@Peshlidaci_bot](https://t.me/Peshlidaci_bot)**. Token a chat ID
jsou uložené jako GitHub Secrets (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`)
— nikdy nejsou v repu ani v historii commitů.

## Přidání dalšího portálu

1. Nový soubor v `sources/`, export `async function fetchX(config)` vracející
   pole objektů `{ source, sourceLabel, id, title, price, address, url }`.
2. Přidat do `SOURCES` v `index.js`.
3. `id` musí být stabilní a unikátní napříč běhy (typicky ID z URL inzerátu)
   — na něm stojí celá dedup logika.

## Známá omezení / možná vylepšení

- GitHub Actions cron negarantuje přesný čas spuštění (může se zpozdit o
  pár minut, hlavně ve špičce).
- iDNES a RealityMIX nemají radius-search ani GPS na inzerátech → filtr jen
  na město, ne přesných 5 km (viz tabulka výše).
- Pokud portál za 15 minut zveřejní víc nových inzerátů, než kolik jich je
  na první stránce výpisu (typicky 15–22), nejstarší z nich se nemusí
  zachytit. U tak malé lokality je to velmi nepravděpodobné.
- Portály mění strukturu stránek bez upozornění — pokud se scraper
  najednou "utne" (chyba v logu Action), je potřeba znovu prověřit
  strukturu dané stránky a upravit příslušný soubor v `sources/`.
