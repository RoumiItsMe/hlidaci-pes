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
   minut. **Spouští ho externí služba [cron-job.org](https://cron-job.org)**
   přes GitHub API (`workflow_dispatch`) — ne GitHubův vlastní `schedule`
   trigger, viz [Proč externí cron](#proč-externí-cron-a-ne-githubův-schedule)
   níže. `schedule` ve `watch.yml` zůstává v souboru jako bonusová záloha
   (kdyby GitHub časem začal spouštět spolehlivě sám), ale neřeš ho —
   primární a spolehlivý spouštěč je cron-job.org.
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

## Proč externí cron (a ne GitHubův `schedule`)

**Zjištěno naostro po nasazení:** GitHub Actions `schedule` trigger u
tohohle repa nenaskočil ani jednou během prvních ~4+ hodin po nasazení —
v historii běhů byly jen ruční `workflow_dispatch` spuštění. Posun mimo
kulaté minuty (`4,19,34,49` místo `*/15`) nepomohl. Tohle je bohužel
známá (i když ne oficiálně garantovaná) vlastnost GitHub Actions cronu —
u nových/málo vytížených repozitářů se scheduled trigger někdy neaktivuje
spolehlivě vůbec, a GitHub to nijak nehlásí (žádný běh = nic k nahlášení).

**Řešení:** místo spoléhání na GitHubův vlastní scheduler spouští
`watch.yml` externí free cron služba **[cron-job.org](https://cron-job.org)**
— zavolá GitHub API endpoint pro `workflow_dispatch` (přesně to samé, co
dělá tlačítko "Run workflow" na GitHubu nebo `gh workflow run`), a to
každých 15 minut, spolehlivě. `schedule` trigger zůstává ve `watch.yml`
jako neškodná bonusová záloha (kdyby to GitHub časem opravil), ale
neřídíme se podle něj.

### Jednorázové nastavení (udělá vlastník repa)

1. **Vytvoř GitHub token** — [github.com/settings/tokens?type=beta](https://github.com/settings/tokens?type=beta)
   → *Generate new token* (fine-grained):
   - Repository access → *Only select repositories* → `RoumiItsMe/hlidaci-pes`
   - Permissions → *Repository permissions* → **Actions** → nastav na
     **Read and write**
   - Expiration: klidně nejdelší možnou volbu (token jde kdykoli
     obnovit/znovu vygenerovat, jen si pohlídej datum vypršení)
   - *Generate token* → **zkopíruj si ho hned** (zobrazí se jen jednou) —
     nikam ho neposílej, vlož ho v dalším kroku přímo do cron-job.org
2. **Založ si účet na [cron-job.org](https://cron-job.org)** (zdarma)
3. **Vytvoř nový cronjob:**
   - **Title:** `Hlídací pes — spustit watch.yml`
   - **URL:** `https://api.github.com/repos/RoumiItsMe/hlidaci-pes/actions/workflows/watch.yml/dispatches`
   - **Schedule:** každých 15 minut
   - **Request method:** `POST`
   - **Headers** (v pokročilém nastavení):
     - `Authorization: Bearer <tvůj token z kroku 1>`
     - `Accept: application/vnd.github+json`
     - `X-GitHub-Api-Version: 2022-11-28`
     - `Content-Type: application/json`
   - **Request body:** `{"ref":"main"}`
   - Ulož a použij "Test run" tlačítko — během pár vteřin by se měl v
     [GitHub Actions](https://github.com/RoumiItsMe/hlidaci-pes/actions/workflows/watch.yml)
     objevit nový běh.

Token dej pozor nikdy nevkládat nikam jinam než do hlaviček tohohle
jednoho cronjobu — má zápisový přístup k Actions v tomhle repu.

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

**🛎️ Kontrola, jestli hlídací pes vůbec běží** ([`heartbeat.yml`](.github/workflows/heartbeat.yml)):
výše popsané alerty pokrývají "zdroj/portál nefunguje", ale ne scénář, kdy
`watch.yml` neproběhne vůbec (spouštěč — cron-job.org — přestane volat,
nebo je výpadek na straně GitHubu) — to se nehlásí jako chyba (žádný běh =
nic k nahlášení). `heartbeat.yml` běží samostatně, jednou za hodinu, na
jiném rozvrhu než `watch.yml`, a přes GitHub API kontroluje, kdy naposledy
proběhl JAKÝKOLI běh hlavního workflow (ať ho spustil cron-job.org,
GitHubův bonusový `schedule`, nebo ruční spuštění). Když je to víc než
40 minut (= min. dva zmeškané 15minutové běhy v řadě), pošle **🛎️**
Telegram zprávu — jiné označení než alerty výše, ať je hned jasné, že jde
o "hlídací pes vůbec neběžel", ne o "portál nefunguje". Zbytkové riziko:
`heartbeat.yml` běží na stejné GitHub Actions infrastruktuře jako
`watch.yml`, takže úplný výpadek celého GitHubu by srazil obě kontroly
najednou — tohle konkrétní riziko ale řeší už to, že primární spouštěč
(cron-job.org) je mimo GitHub úplně, viz [Proč externí cron](#proč-externí-cron-a-ne-githubův-schedule).

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

- GitHub Actions `schedule` trigger se u tohohle repa ukázal nespolehlivý
  (nenaskočil ani po 4+ hodinách) — proto je primární spouštěč externí
  cron-job.org, ne GitHubův vlastní scheduler. Podrobnosti a nastavení viz
  [Proč externí cron](#proč-externí-cron-a-ne-githubův-schedule).
  cron-job.org samo o sobě taky negarantuje úplně přesnou minutu (běžně
  v řádu vteřin až nízkých jednotek minut zpoždění), ale řádově
  spolehlivěji než to, co jsme pozorovali u GitHubu.
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
