# 🐕 Hlídací pes

Automatický hlídač nových nabídek nemovitostí. Každých ~15 minut projde
nastavené realitní portály a o nových inzerátech (odpovídajících filtru)
pošle notifikaci na Telegram.

## Aktuální filtr

- **Nabídka:** prodej bytů (jakákoli dispozice)
- **Lokality** (každá + okolí 5 km): Ústí nad Orlicí, Letohrad, Žamberk, Česká Třebová
- **Cena / plocha:** bez omezení

Filtr se mění v [`config.js`](config.js) — lokality jsou pole `locations`,
každá se svým středem a okruhem. Přidání další lokality je otázka jednoho
nového záznamu v tom poli (viz komentáře v souboru); pokud by ležela mimo
okres Ústí nad Orlicí, je navíc potřeba upravit `sources/realitymix.js`
(sdílený `OKRES_SLUG`) — viz tabulka portálů níže.

## Sledované portály

| Portál | Jak se čte | Kolik dotazů na běh | Přesnost lokality |
|---|---|---|---|
| [Sreality.cz](https://www.sreality.cz) | embedded JSON (SSR) | 1 (celý okres najednou) | přesný 5km okruh kolem každé lokality (GPS filtr) |
| [Bezrealitky.cz](https://www.bezrealitky.cz) | embedded JSON (SSR) | 1 na lokalitu | přesný 5km okruh kolem každé lokality (GPS filtr) |
| [Reality.iDNES.cz](https://reality.idnes.cz) | HTML | 1 na lokalitu | jen samotné město (bez GPS, širší okolí nelze filtrovat) |
| [RealityMIX.cz](https://realitymix.cz) | HTML | 1 na lokalitu | jen samotné město (bez GPS, širší okolí nelze filtrovat) |
| [Bazoš.cz](https://reality.bazos.cz) | RSS | 1 na lokalitu | přesný 5km okruh kolem každé lokality (nativní parametr portálu) |

U iDNES a RealityMIX portály nenabízí GPS souřadnice u jednotlivých
inzerátů v seznamu ani radius-search, takže se bere jen samotné město —
okolní vesnice v okruhu 5 km tyhle dva zdroje nepokryjí. Sreality,
Bezrealitky a Bazoš mají přesný 5km okruh kolem každé nakonfigurované
lokality. Sreality navíc fetchuje jen jednou za běh (ne 1x na lokalitu),
protože všechny čtyři nakonfigurované lokality leží ve stejném okrese a
Sreality umí vrátit celý okres jedním dotazem — filtr na "je blízko
ALESPOŇ jedné z lokalit" se pak dělá až lokálně nad staženými daty.
Výsledky z jednotlivých lokalit se u ostatních zdrojů slučují a
deduplikují (`lib/merge.js`) — inzerát na pomezí dvou okruhů se nahlásí
jen jednou.

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
   Telegram desítkami zpráv o inzerátech, co tam visí už dlouho. Stejně se
   řeší i **rozšíření o novou lokalitu** — po přidání do `config.js` se
   lokálně spustí `node index.js` bez Telegram proměnných (viz níže), ať se
   nově objevené inzeráty jen zabaselinují a nepošlou se jako "nové".
5. Když zdroj selže (změna struktury stránky, výpadek webu...) nebo se
   naopak rozchodí, přijde o tom Telegram alert — viz [Upozornění při
   výpadku](#upozornění-při-výpadku).

## Lokální spuštění / test

```bash
npm install
TELEGRAM_BOT_TOKEN=xxx TELEGRAM_CHAT_ID=xxx node index.js
```

Bez nastavených env proměnných skript baseline krok (stažení + uložení
stavu) provede v pořádku, jen při pokusu o odeslání notifikace (pokud by
nějaká nová položka byla) vyhodí chybu.

## Upozornění při výpadku

Zdravotní stav každého zdroje se sleduje v `data/seen.json` (`__health`).
- **⚠️ Zdroj přestal fungovat** — alert hned při první chybě, pak nejvýš
  1× za 12 hodin, dokud je pořád rozbitý (ať to při dlouhém výpadku
  nespamuje každých 15 minut).
- **✅ Zdroj zase funguje** — jakmile se předtím rozbitý zdroj rozchodí
  (sám, nebo po opravě), přijde zpráva o zotavení.
- **🔴 Neočekávaný pád celého běhu** — best-effort alert i tady.
- Běh, ve kterém nastala chyba, skončí nenulovým exit kódem → GitHub
  Actions ho označí jako neúspěšný (červený), což navíc spustí i výchozí
  e-mailové upozornění GitHubu vlastníkovi repa (záložní kanál nezávislý
  na tom, jestli se podaří odeslat Telegram zprávu).

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
