# 🐕 Hlídací pes

Automatický hlídač nových nabídek nemovitostí. Každých ~15 minut projde
nastavené realitní portály a pošle notifikaci na Telegram o (a) nových
inzerátech odpovídajících filtru a (b) **změně ceny** u inzerátů, které už
dřív sledoval.

## Aktuální sledování

Konfigurace je pole **`watches`** v [`config.js`](config.js) — každé
sledování je nezávislý filtr se svým vlastním stavem (nedostane žádné
notifikace navíc kvůli jinému sledování, ani od něj neztratí dedup historii).

### 🏠 Byty na prodej

- **Nabídka:** prodej bytů (jakákoli dispozice)
- **Lokality** (každá + okolí 5 km): Ústí nad Orlicí, Letohrad, Žamberk, Česká Třebová
- **Cena / plocha:** bez omezení

### 🏕️ Pozemek (bydlení/zahrada)

- **Nabídka:** prodej pozemků — primárně stavební/bydlení a zahradní parcely
  (glamping-kandidáti); čistě zemědělská půda, lesy, louky, rybníky a
  podílové spoluvlastnictví se vynechávají
- **Lokalita:** Ústí nad Orlicí + okolí 20 km
- **Cena:** do 1 500 000 Kč (nabídky bez uvedené ceny se přesto ukážou —
  radši false positive než promeškaná příležitost)

Přidání dalšího sledování (např. domy, jiná lokalita, jiný cenový strop) je
nový záznam v poli `watches` — viz komentáře v `config.js`.

## Sledované portály

| Portál | Jak se čte | Přesnost lokality (byty) | Přesnost lokality (pozemky) |
|---|---|---|---|
| [Sreality.cz](https://www.sreality.cz) | embedded JSON (SSR) | přesný 5km okruh (GPS filtr) | přesný 20km okruh (GPS filtr) |
| [Bezrealitky.cz](https://www.bezrealitky.cz) | embedded JSON (SSR) | přesný 5km okruh (GPS filtr) | přesný 20km okruh (GPS filtr); bez subtype filtru (viz níže) |
| [Reality.iDNES.cz](https://reality.idnes.cz) | HTML | jen samotné město (bez GPS) | nejširší dostupná "okolí" úroveň, nepřekračuje 20 km (reálně blíž ~14 km — viz níže) |
| [RealityMIX.cz](https://realitymix.cz) | HTML | jen samotné město (bez GPS) | město + 3 sousední (Letohrad/Žamberk/Č. Třebová) — aproximace, ne skutečný okruh |
| [Bazoš.cz](https://reality.bazos.cz) | RSS | přesný 5km okruh (nativní parametr) | přesný 20km okruh (nativní parametr) |

**Podtypy pozemků** (stavební/bydlení vs. zahrada vs. ostatní) se řeší
per-portál různě:
- **Sreality** a **iDNES** mají pro oba podtypy samostatná URL (fetchují se
  a slučují zvlášť).
- **RealityMIX** stejně, navíc přes všechna 3 náhradní města.
- **Bazoš** má samostatnou kategorii jen pro "Zahrady"; obecná kategorie
  "Pozemky" mísí stavební parcely s poli/lesy/loukami, takže se navíc
  filtruje podle klíčových slov v titulku (`bydlen`/`stavebn`) a vyřazují
  se podílová spoluvlastnictví (`podíl`).
- **Bezrealitky** typ pozemku u inzerátů v tomhle regionu prakticky nikdy
  nevyplňuje (`landType` je skoro vždy `UNDEFINED`) — bere se tedy každý
  pozemek v okruhu + do ceny, bez rozlišení podtypu. Je jich v regionu
  málo, takže to zůstává použitelné i tak.

**Okruh 20 km u pozemků** — přesný jen u Sreality/Bezrealitky/Bazoše (mají
GPS souřadnice nebo nativní radius-parametr). iDNES má jen 5 diskrétních
úrovní "okolí" (ne km), nejširší nepřekračující 20 km je cca 14 km — dál se
nedostane, aby nešel přes 20 km limit z druhé strany. RealityMIX nemá
radius-search vůbec, takže se pro 20 km okruh bere jako aproximace stejná
trojice sousedních měst jako u bytů — reálně tedy nepokryje úplně každou
vesnici v okruhu 20 km, hlavně ne ty úplně nejmenší.

Výsledky z jednotlivých lokalit/podtypů/měst se u každého zdroje slučují a
deduplikují (`lib/merge.js`) — inzerát na pomezí dvou dotazů se nahlásí jen
jednou. Cenový strop se vždy kontroluje i klientsky (`lib/price.js`), i u
zdrojů, které umí filtrovat cenu přímo v URL (Bazoš) — jako pojistka.

## Jak to funguje

1. `.github/workflows/watch.yml` spouští `node index.js` cca každých 15
   minut (GitHub Actions cron, minimální praktický interval — přesně na
   minutu to negarantuje, ale v praxi sedí).
2. `index.js` pro každé sledování × každý portál stáhne aktuální nabídku a
   porovná ji s `data/seen.json` — konkrétně s poslední známou cenou
   každého inzerátu, uloženou pod klíčem `<sledování>:<portál>`. Pošle
   zprávu přes Telegram bota o:
   - **nových inzerátech** (ID, co tam dřív nebylo), a
   - **změně ceny** u inzerátů, které už zná (jiná známá cena než
     naposledy — 🔻 při zlevnění, 🔺 při zdražení). Přechod z/na "Cena na
     vyžádání" se nepočítá jako změna (žádná ze dvou stran není konkrétní
     číslo k porovnání), jen se cena tiše aktualizuje.
3. Aktualizovaný `data/seen.json` se po každém běhu commitne zpátky do
   repa — tak stav (vč. poslední známé ceny) přežije mezi jednotlivými
   spuštěními Action.
4. **První běh pro každou dvojici (sledování, zdroj)** aktuální nabídku jen
   "zabaseline" (uloží jako už viděnou, i s cenou) BEZ posílání notifikací
   — jinak by zaplavil Telegram desítkami zpráv o inzerátech, co tam visí
   už dlouho. Stejně se řeší i **přidání nového sledování/lokality** — po
   úpravě `config.js` se lokálně spustí `node index.js` bez Telegram
   proměnných (viz níže), ať se nově objevené inzeráty jen zabaselinují a
   nepošlou se jako "nové".
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
nějaká nová položka byla) vyhodí chybu — používá se to schválně jako
"tichý baseline" postup při rozšiřování filtrů (viz bod 4 výše).

## Upozornění při výpadku

Zdravotní stav každé dvojice (sledování, zdroj) se sleduje v
`data/seen.json` (`__health`).
- **⚠️ Přestal fungovat** — alert hned při první chybě, pak nejvýš 1× za
  12 hodin, dokud je pořád rozbitý (ať to při dlouhém výpadku nespamuje
  každých 15 minut).
- **✅ Zase funguje** — jakmile se předtím rozbitý zdroj rozchodí (sám,
  nebo po opravě), přijde zpráva o zotavení.
- **🔴 Neočekávaný pád celého běhu** — best-effort alert i tady.
- Běh, ve kterém nastala chyba, skončí nenulovým exit kódem → GitHub
  Actions ho označí jako neúspěšný (červený), což navíc spustí i výchozí
  e-mailové upozornění GitHubu vlastníkovi repa (záložní kanál nezávislý
  na tom, jestli se podaří odeslat Telegram zprávu).

**🛎️ Kontrola, jestli sám cron vůbec běží** ([`heartbeat.yml`](.github/workflows/heartbeat.yml)):
výše popsané alerty pokrývají "zdroj/portál nefunguje", ale ne scénář, kdy
GitHubu vůbec nenaskočí automatické (scheduled) spuštění `watch.yml` — to
se nehlásí jako chyba (žádný běh = nic k nahlášení), a přesně tohle se
reálně stalo pár hodin po prvním nasazení (viz "Známá omezení" — kulaté
minuty + prodleva u nového repa). `heartbeat.yml` běží
samostatně, jednou za hodinu, na jiném rozvrhu než `watch.yml`, a přes
GitHub API kontroluje, kdy naposledy proběhl skutečný `schedule`-běh
hlavního workflow. Když je to víc než 40 minut (= min. dva zmeškané
15minutové běhy v řadě), pošle **🛎️** Telegram zprávu — jiné označení než
alerty výše, ať je hned jasné, že jde o "cron neběží vůbec", ne o "portál
nefunguje". Zbytkové riziko: obě kontroly běží na stejné GitHub Actions
infrastruktuře, takže úplný výpadek celého GitHubu srazí obě najednou —
pro tenhle scénář by bylo potřeba nezávislé externí hlídání (např.
healthchecks.io), což ale vyžaduje založit účet u třetí strany.

## Telegram bot

Bot: **[@Peshlidaci_bot](https://t.me/Peshlidaci_bot)**. Token a chat ID
jsou uložené jako GitHub Secrets (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`)
— nikdy nejsou v repu ani v historii commitů.

## Přidání dalšího portálu

1. Nový soubor v `sources/`, export `async function fetchX(watch)` vracející
   pole objektů `{ source, sourceLabel, id, title, price, priceCzk, address, url }`.
   `watch` = jeden záznam z pole `watches` v `config.js` (typ nemovitosti,
   cenový strop, lokality). `price` je formátovaný text pro zobrazení
   ("4 400 000 Kč" / "Cena na vyžádání"), `priceCzk` je stejná cena jako
   číslo (nebo `null`, když není známá) — na něm stojí detekce změny ceny,
   viz `lib/price.js` (`parsePriceCzkFromText` pro zdroje, co mají jen
   naformátovaný text, `withinPriceCap` pro filtrování podle stropu).
2. Přidat do `SOURCES` v `index.js`.
3. `id` musí být stabilní a unikátní napříč běhy (typicky ID z URL inzerátu)
   — na něm stojí celá dedup logika i sledování změny ceny.

## Známá omezení / možná vylepšení

- GitHub Actions cron negarantuje přesný čas spuštění (může se zpozdit o
  pár minut, hlavně ve špičce) — proto je cron schválně posunutý mimo
  kulaté minuty (`4,19,34,49`, ne `*/15`, viz komentář ve `watch.yml`). U
  nově založeného repa navíc první automatické spuštění cronu může přijít
  až s pár hodinovým zpožděním, i když je vše nakonfigurované správně —
  jakmile jednou naskočí, pak už jede spolehlivě podle rozvrhu.
- iDNES a RealityMIX nemají GPS na inzerátech ani skutečný radius-search →
  u bytů jen samotné město, u pozemků aproximace (viz tabulka výše).
- Pokud portál za 15 minut zveřejní víc nových inzerátů, než kolik jich je
  na první stránce výpisu daného dotazu (typicky 15–50), nejstarší z nich
  se nemusí zachytit. U tak malé lokality je to velmi nepravděpodobné.
- RealityMIX a Bazoš parsují cenu heuristicky z textu karty/titulku — u
  pár inzerátů (zjištěno u pozemků) vyjde nesmyslně nízká cena, pravděpodobně
  když portál zobrazuje cenu za m² prominentněji než celkovou cenu. Inzerát
  se přesto nahlásí (jen se zavádějícím údajem o ceně) — odkaz v notifikaci
  vždy vede na reálný inzerát, kde je to vidět přesně.
- Bezrealitky nerozlišuje podtyp pozemku (viz tabulka výše) — u pozemkového
  sledování tak může přijít i nabídka pole/lesa, ne jen bydlení/zahrady.
- Portály mění strukturu stránek bez upozornění — pokud se scraper
  najednou "utne" (chyba v logu Action, Telegram alert), je potřeba znovu
  prověřit strukturu dané stránky a upravit příslušný soubor v `sources/`.
