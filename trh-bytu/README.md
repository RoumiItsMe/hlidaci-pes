# 🏠 Trh bytů

Lokální appka vedle hlídacího psa — dlouhodobě eviduje byty na prodej v
sledované oblasti (stejná lokalita jako watch `byty` v [`../config.js`](../config.js)):
kdy se objevily, jak se jim vyvíjela cena, kdy zmizely z nabídky
(pravděpodobně prodáno/rezervováno jinde/staženo z jiného důvodu —
appka to nikdy netvrdí jistě). U každého bytu drží dispozici, plochu,
popis, fotky a odkaz na inzerát.

**Stejná nemovitost inzerovaná na víc portálech se ukáže jen jednou**
(shoda dispozice+plochy+ceny napříč zdroji, viz [`group.js`](group.js)) —
appka ji spojí do jednoho záznamu se všemi odkazy, **jedním popisem**,
**jednou sadou parametrů**, sloučenou galerií fotek (když jeden portál
fotky nemá — typicky Sreality, viz níž — appka je ukáže z jiného portálu
se stejnou nemovitostí) a společnou časovou osou napříč portály.

**Pořadí důvěryhodnosti zdrojů** (`SOURCE_PRIORITY` v `group.js`):
**Sreality → iDNES → Bezrealitky → RealityMIX → Bazoš**. U sloučené
nemovitosti se popis/parametry/adresa/základní údaje berou vždy od
nejvýš postaveného zdroje, co je má — teprve když ho nemá (např. Sreality
u téhle konkrétní nemovitosti žádný popis nestáhla), sestoupí appka níž.
Sreality a iDNES uživatel označil za nejspolehlivější zdroj dat;
Bezrealitky je zařazená hned za ně, protože je to jediný další portál se
stejně strukturovanými daty jako Sreality (viz Parametry níž) — v tomhle
regionu má ale appka zatím jen 1 její inzerát, takže v praxi rozhoduje
většinou jen Sreality vs. iDNES vs. zbytek.

**Strukturované parametry** (vlastnictví, stav, typ budovy, podlaží,
energetická náročnost, výtah, balkón/lodžie/terasa/sklep/parkování/garáž)
— podobně jako je Sreality/Bazoš ukazují u vlastní nabídky, viz
[`params.js`](params.js). K dispozici jsou jen ze Sreality a Bezrealitky
(jediné dva portály se strukturovaným JSON na detailu) — u ostatních zůstává
sekce Parametry skrytá.

**Hlavní přehled je řádkový** — 1 nemovitost = 1 řádek, ale hustší než
holá tabulka: náhledová fotka (nebo "Bez fotky", když ji appka nemá u
žádného sloučeného zdroje), čitelný nadpis ve tvaru
`Byt 2+1, 55 m², Letohrad, ul. U dvora — 3 750 000 Kč`, kompaktní shrnutí
parametrů (jen popisné hodnoty + vybavení, co je "Ano" — ne "Ne"), úryvek
popisu (~220 znaků, uťatý na hranici slova) a řádek **"V nabídce od" +
"Poslední změna"** (viz níž), ať je na první pohled jasné, o co jde, kde
to je a jak dlouho/jestli se s tím něco děje — bez nutnosti klikat do
detailu.

## "V nabídce od" a "Poslední změna" — jen vlastní historie appky

"V nabídce od" = kdy appka nemovitost poprvé zaevidovala (nejstarší
`first_seen_at` napříč sloučenými zdroji). "Poslední změna" je datum
poslední **skutečné** události, co appka SAMA zaznamenala do vlastní
historie (`events`, viz `db.js`) — změna ceny, zmizení z nabídky, návrat
do nabídky, nebo (jen u Bezrealitky) označení jako rezervováno. Nikdy ne
"naposledy upraveno" od portálu (Sreality `params.edited` apod.) — to si
realitky bumpují i bez reálné změny nabídky, přesně ten samý problém,
kvůli kterému hlídací pes dřív hlásil roky staré inzeráty jako "nové" (viz
komentáře v `sources/sreality.js` a `group.js`). Appka věří jen tomu, co
sama uviděla se vlastníma očima mezi dvěma sběrnými běhy — když se od
zaevidování nic takového nestalo, řádek ukáže "Poslední změna: zatím
žádná", ne vymyšlené/portálové datum.

Vizuálně jde o dva odznaky, ne splývající text — "V nabídce od" je vždy
modrý; "Poslední změna" je **šedý/tečkovaný**, dokud se opravdu nic
nestalo ("Zatím beze změny"), a **zežloutne**, jakmile appka zaznamená
skutečnou událost — v přehledu tak jde okem snadno najít, u kterých bytů
se od zaevidování něco děje.

## Filtrování a řazení

Nad seznamem bytů: stavové filtry (Vše/V nabídce/Rezervováno/Zmizelo z
nabídky, jako dřív), řazení **podle ceny** (nebo nejlevnější/nejdražší
první — výchozí "Nejnovější" je popsané níž) a dva výběry — **město** a
**vlastnictví** — co se automaticky naplní jen hodnotami, které se v
datech opravdu vyskytují (appka nikdy nenabídne volbu, po které by nic
nenašla). Všechny filtry/řazení se kombinují a odkazy mezi sebou
zachovávají zvolený stav ostatních (klik na "Cena ↑" nezruší zvolené
město).

**Výchozí řazení ("Nejnovější") dává přednost TOP bytům** (viz níž) — ty
jsou vždy nahoře, bez ohledu na datum. Uvnitř toho (a u bytů bez TOP
označení) rozhoduje **poslední aktivita** = novější z dvojice (kdy byl byt
zaevidován, kdy u něj appka zaznamenala poslední skutečnou změnu — viz
"Poslední změna" výš) — čerstvě přidaný byt i dávno zaevidovaný byt s
dnešní změnou ceny se tak oba objeví nahoře. Řazení podle ceny naopak TOP
nijak nezvýhodňuje — je to čistě cena, jak by čtenář čekal.

## Vyřadit (✕) a TOP (⭐)

Každý řádek (i detail bytu) má dvě malá kolečka v pravém horním rohu:

- **✕ Skrýt z přehledu** — byt zmizí ze VŠECH běžných pohledů (appka nic
  nemaže, jen ho přestane defaultně ukazovat, stejná filozofie jako u
  `status = removed`, viz níž). Skryté byty jdou zpátky najít přes pilulku
  **"🚫 Skryté (N)"** nad seznamem, kde má tlačítko místo ✕ **↺ Obnovit**.
- **⭐/☆ Označit jako TOP** — byty, které uživatel sleduje nejvíc. Pilulka
  **"⭐ TOP"** nad seznamem je filtruje na jedno kliknutí; TOP byty navíc
  dostávají zlatý okraj řádku a hvězdičku před titulkem, ať jsou vidět i
  bez filtru.

Obě jsou nezávislé na sobě i na stavu appky (aktivní/rezervováno/zmizelo)
a ukládají se stejně jako poznámky v detailu — appka o nich nikdy nic
sama nerozhoduje.

Město se vytahuje z adresy (viz `extractCity` v `parse.js`) — nejdřív
zkusí, jestli adresa obsahuje jméno některého ze 4 hlavních sledovaných
měst (i uvnitř delšího řetězce jako "Česká Třebová, okr. Ústí nad
Orlicí"), jinak spadne na poslední rozumný segment adresy (typicky
zachytí i okolní města mimo hlavní 4, např. Pardubice). Vlastnictví jde
jen ze strukturovaných parametrů (tedy jen ze Sreality/Bezrealitky, viz
Parametry výš) — u zbylých portálů je pole ownership prázdné, takže
tahle skupina bytů se v konkrétním výběru vlastnictví neukáže (ale
zůstane vidět u "Vlastnictví (vše)").

**Chybějící dispozice/plocha/cena/adresa se zkusí dohledat i v popisu**
(viz `parse.js`), ne jen v titulku — u nového inzerátu appka detail
stejně stahuje kvůli fotkám, takže popis má vždy k dispozici. Pořadí
zdrojů dat pro jedno pole: pole od portálu → titulek → popis. U adresy,
když se nenajde ani ulice v titulku, zkusí appka v popisu aspoň JMÉNO
sledovaného města — přesná adresa ne vždy, ale "aspoň víme, kde to je".
Nic z toho není zaručené (fail-soft) — když ani popis nic neříká, políčko
v řádku prostě chybí.

**Na rozdíl od hlídacího psa běží čistě lokálně** — žádný GitHub Actions,
žádné Telegram notifikace. Data (SQLite databáze + stažené fotky) zůstávají
jen na tomhle počítači v `data/` (gitignored, negitovaná).

## Spuštění

```bash
npm run track-sales   # sběrný běh — stáhne aktuální nabídku, zaeviduje nové byty, zaznamená změny
npm run sales-app     # spustí lokální web na http://localhost:4321
```

První `track-sales` běh zaeviduje VŠECHNY aktuálně aktivní byty v regionu
najednou (desítky, ne jednotky) — o dost víc detail-page requestů a
stažených fotek než běžný den. To je v pořádku a jednorázové, další běhy
už zpracovávají jen skutečné nové přírůstky.

## Naplánované denní spouštění (Windows Task Scheduler)

Ať appka sbírá data sama, bez ručního spouštění, nastav naplánovanou úlohu:

**Přes PowerShell (jednorázově, jako správce nebo běžný uživatel):**

```powershell
$action = New-ScheduledTaskAction -Execute "node" -Argument "trh-bytu\track.js" -WorkingDirectory "C:\Users\roman\Documents\Hlídací pes"
$trigger = New-ScheduledTaskTrigger -Daily -At 8:00am
Register-ScheduledTask -TaskName "Trh bytu - sber dat" -Action $action -Trigger $trigger -Description "Denni sber dat o bytech na prodej (Trh bytu appka)"
```

**Nebo přes GUI:** Otevři *Plánovač úloh* (Task Scheduler) → *Vytvořit
základní úlohu* → název „Trh bytů — sběr dat" → spouštět *Denně*, čas dle
uvážení (např. 8:00) → akce *Spustit program* → Program: `node`, Argumenty:
`trh-bytu\track.js`, Spustit v: `C:\Users\roman\Documents\Hlídací pes`.

Ověření, že úloha běží: *Plánovač úloh* → *Knihovna plánovače úloh* → najdi
úlohu → záložka *Historie*. Log samotného sběru je v `data/track.log`.

## Kde jsou data

- `data/trh-bytu.sqlite` — databáze (inzeráty, časová osa událostí, fotky).
- `data/photos/<zdroj>_<id>/` — stažené fotky, max. 10 na inzerát.
- `data/track.log` — log každého sběrného běhu.

Nic z `data/` se necommituje do gitu (viz `.gitignore`) — je to čistě
lokální evidence.

## Data zůstávají i po zmizení z nabídky

Appka nikdy nic nemaže. Když byt zmizí z nabídky (pravděpodobně prodáno/
rezervováno/staženo), zapíše se jen `status = "removed"` + datum — popis,
fotky, parametry a celá časová osa zůstávají v databázi navždy, přesně tak,
jak byly naposledy zaznamenané. V celém kódu appky (`track.js`, `server.js`,
`db.js`) není jediný `DELETE` nad tabulkami `listings`/`photos`/`events`.

## Vlastní poznámky u bytu

V detailu bytu (`/byt/<id>`) jde doplnit **ověřenou prodejní cenu, datum
prodeje a volnou poznámku** — až si sám dohledáš skutečnou cenu (např. v
katastru nemovitostí), zapiš si ji tam. Appka sama žádná data z katastru
nestahuje.

## Sloučení stejné nemovitosti napříč portály

Appka porovnává VŠECHNY inzeráty podle (dispozice, plocha zaokrouhlená na
celé m², cena) — když se dva inzeráty z RŮZNÝCH portálů shodují ve všech
třech, bere je jako jednu nemovitost. Vědomě konzervativní: shoda v rámci
JEDNOHO portálu (dva různé byty na Bazoši náhodou se stejnými parametry)
se nikdy neslučuje — radši dva řádky pro tutéž nemovitost navíc, než
omylem sloučit dva různé byty do jednoho a jeden tiše "zmizet" z přehledu.

Počítá se vždy čerstvě při zobrazení (appka si nikde neukládá "tohle patří
k tamtomu") — funguje okamžitě i na starších datech a nemůže se rozejít
se skutečností.

Důsledek pro stav: pokud je nemovitost aktivní byť jen na JEDNOM portálu,
appka ji ukáže jako "V nabídce" (dá se pořád reálně sehnat), i kdyby na
jiném portálu mezitím zmizela nebo byla označená jako rezervovaná —
detail bytu ale ukazuje stav KAŽDÉHO portálu zvlášť, takže nic nezůstává
skryté.

## Vědomá omezení (v1)

- **"Rezervováno" appka pozná spolehlivě jen u Bezrealitky** (má to přímo v
  datech). U ostatních portálů se stav pozná až zmizením z nabídky
  (`removed`) — bez rozlišení, jestli šlo o rezervaci, prodej, nebo že
  majitel/RK inzerát prostě stáhl z jiného důvodu.
- **Popis u RealityMIX appka nezíská** — na jejich detailu se dotahuje až
  přes JavaScript na klientovi, v syrovém HTML není. Fotky a základní údaje
  (dispozice, m², cena) u RealityMIX fungují normálně.
- **Fotky u Sreality appka nezíská** — jejich CDN vrací na každý pokus o
  stažení "401 Unauthorized", bez ohledu na hlavičky (ověřeno naostro).
  Zbytek (popis, dispozice, m², cena) u Sreality funguje normálně. U
  ostatních 4 portálů se fotky stahují bez problémů.
