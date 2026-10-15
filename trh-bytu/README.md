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
[`params.js`](params.js). Strukturovaně je dávají jen Sreality a Bezrealitky
(jediné dva portály se strukturovaným JSON na detailu); u ostatních je appka
**vytěží z textu inzerátu** ([`extract-params.js`](extract-params.js)):
patro, výtah, sklep (i plochu), balkon/lodžii/terasu a vlastnictví — z
formulací jako „bez výtahu", „Výtah: ne", „K bytu náleží sklep o výměře 9 m²",
„družstevní byt", „v OV", „3. NP". Pravidla jsou poměřená proti inzerátům,
které strukturovaná data mají (výtah a vlastnictví sedí ve 100 % případů,
sklep v ~80 %, zbytek jsou chyby portálu). „Ne" appka napíše jen tehdy, když to
text řekne výslovně — nezmínění věci neznamená, že tam není. Portálové
„Ne" u sklepa/balkonu/lodžie/terasy ale ustoupí textu, který tvrdí opak
(prodejce nezaškrtne políčko a v popisu píše „K bytu náleží sklep"). Starší
záznamy dopočítá `node trh-bytu/backfill-parse.js --params-only` (jen
parametry z textu a ulice, bez sítě).

**Podlaží se vždy píše oběma číslováními** — „1. patro (2. NP) z 4", „Přízemí
(1. NP)". V češtině se míchají dvě: NP (nadzemní podlaží) počítá přízemí jako 1,
„patro" ho nepočítá, takže 2. NP je 1. patro. Sreality i Bezrealitky dávají číslo
podlaží (NP) — appka ho dřív psala jako „patro", z textu naopak převáděla na
patro, a v jedné tabulce tak seděla dvě číslování lišící se o jedno (u
inzerátů s oběma údaji se číslo ze Sreality rovnalo NP ve 17 z 17 případů, a
u čtyř bytů, o kterých text říká „přízemí", je u Sreality „1. patro"). Starší
záznamy převedl `backfill-parse.js --params-only` (fáze 4); sloupec Patro je
v tabulce kvůli délce širší.

**Ruční přepsání parametrů** (výběr/pole v tabulce nebo v detailu) se ukládá jen
tehdy, když se hodnota liší od toho, co říká portál nebo text inzerátu —
formulář v detailu dřív posílal všechna pole předvyplněná zobrazenou hodnotou
a každé uložení tak zmrazilo i to, co uživatel nezměnil (pozdější opravy čtení
inzerátů se k bytu pak nikdy nedostaly). Zmrazené kopie, které už v databázi
byly, zahodila fáze 4b backfillu; skutečně ruční hodnoty zůstaly.

**Ulice v adrese:** když inzerát ulici nedává strukturovaně, appka ji hledá v
titulku a popisu („ulice X", „ul. X", „na ulici X") a připojí k městu
(„Česká Třebová, ul. Litomyšlská"). **Přesná adresa** (zapsaná ručně nebo určená
automaticky z polohy, viz Přesná adresa) je v tabulce srovnání pod přibližnou
jako štítek „📍 …"; u nabídek, kde chybí, je tam odkaz „📍 doplnit adresu" na
formulář v detailu.

**Tabulka srovnání (`/tabulka`) je ve výchozím stavu zúžená na 15 sloupců** —
to, podle čeho se byty porovnávají (adresa, dispozice, plocha, patro, výtah,
balkón, sklep, vlastnictví, cena, Kč/m², sleva, přidáno, doba v nabídce, odkazy).
Sloupce, které appka vyplňuje sama nebo se do nich sahá zřídka (Stav, Konstrukce,
Revitalizace, Ve statistice, Ověřená cena, Poznámka, Motivace prodávajícího),
jsou za přepínačem **Víc sloupců (+7)**; všechno z toho je i v detailu bytu.
Přepínač je v adrese (`?cols=all`), takže se zachová při filtrování a řazení.
Filtry stavu a řazení v tabulce se vracejí do tabulky a drží zvolené město a
sloupce (dřív odkaz filtru stavu vedl na přehled a řazení zapomnělo filtr).

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
do nabídky, znovu vložení inzerátu, rezervace (i její zrušení, viz
"Rezervace" níž). Nikdy ne
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

**Výchozí řazení ("Nejnovější") jde ve čtyřech skupinách za sebou:**
1. byty **se změnou, které jsou zároveň TOP** (viz níž),
2. byty **se změnou**,
3. byty **TOP** bez změny,
4. ostatní.

"Se změnou" = appka u bytu zaznamenala skutečnou událost (změna ceny,
zmizení/návrat do nabídky, znovu vložený inzerát — viz "Poslední změna"
výš). Uvnitř každé skupiny rozhoduje **poslední aktivita** = novější z
dvojice (kdy byl byt zaevidován, kdy u něj proběhla poslední změna), takže
nejčerstvější změna je vždy nahoře. Řazení podle ceny naopak změny ani TOP
nijak nezvýhodňuje — je to čistě cena, jak by čtenář čekal.

## Vyřadit (✕) a TOP (⭐)

Každý řádek (i detail bytu) má dvě malá kolečka v pravém horním rohu:

- **✕ Skrýt z přehledu** — byt zmizí ze VŠECH běžných pohledů (appka nic
  nemaže, jen ho přestane defaultně ukazovat, stejná filozofie jako u
  `status = removed`, viz níž). Skryté byty jdou zpátky najít přes pilulku
  **"🚫 Skryté (N)"** nad seznamem, kde má tlačítko místo ✕ **↺ Obnovit**.
  **Jediná výjimka: rezervovaný byt** se ukáže v pohledu **"Rezervováno"**
  i když je skrytý (rezervace je důležitá informace o trhu) — řádek je
  označený *"skryto"* a jde vrátit tlačítkem ↺. V ostatních pohledech
  (Vše, V nabídce, ...) zůstává skrytý.
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
$action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument '"C:\Users\roman\Documents\Hlídací pes\scripts\run-hidden.vbs" "trh-bytu\track.js"'
$trigger = New-ScheduledTaskTrigger -Daily -At 8:00am
Register-ScheduledTask -TaskName "Trh bytu - sber dat" -Action $action -Trigger $trigger -Description "Denni sber dat o bytech na prodej (Trh bytu appka)"
```

Akce jde přes `scripts/run-hidden.vbs` (`wscript.exe <vbs> <skript>`), ne
přímo `node <skript>` — Task Scheduler jinak při každém běhu na vteřinu
bliká černé okno příkazové řádky, viz "Spuštění bez blikajícího okna" níž.

**Nebo přes GUI:** Otevři *Plánovač úloh* (Task Scheduler) → *Vytvořit
základní úlohu* → název „Trh bytů — sběr dat" → spouštět *Denně*, čas dle
uvážení (např. 8:00) → akce *Spustit program* → Program: `node`, Argumenty:
`trh-bytu\track.js`, Spustit v: `C:\Users\roman\Documents\Hlídací pes`.

Ověření, že úloha běží: *Plánovač úloh* → *Knihovna plánovače úloh* → najdi
úlohu → záložka *Historie*. Log samotného sběru je v `data/track.log`.

### Dohnání zmeškaného běhu (PC spal/byl vypnutý v 8:00)

Prostý denní spouštěč se **nespustí**, když počítač v 8:00 spí nebo je
vypnutý — `StartWhenAvailable` v praxi nedožene spolehlivě ani po probuzení
(ověřeno naostro: 10 minut po probuzení se úloha pořád nespustila). Řešení
bez nutnosti budit počítač: přidat úloze DALŠÍ dva spouštěče — "probuzení ze
spánku" (event trigger na Event ID 1 / `Microsoft-Windows-Power-Troubleshooter`)
a "start počítače" (pro úplné vypnutí) — vedle stávajícího denního v 8:00.
`track.js` je idempotentní (ověřeno), takže občasné vícenásobné spuštění za
den nevadí.

**Registrace event/startup spouštěče vyžaduje administrátorská práva**
(na rozdíl od prostého denního spouštěče výše) — spusť v PowerShellu
**jako správce** (pravým tlačítkem → Spustit jako správce):

```powershell
$taskName = "Trh bytu - sber dat"
$action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument '"C:\Users\roman\Documents\Hlídací pes\scripts\run-hidden.vbs" "trh-bytu\track.js"'

$dailyTrigger = New-ScheduledTaskTrigger -Daily -At 8:00am

$startupTrigger = New-ScheduledTaskTrigger -AtStartup
$startupTrigger.Delay = "PT2M"   # 2 min zpoždění, ať je síť připravená

$eventTriggerClass = Get-CimClass -ClassName MSFT_TaskEventTrigger -Namespace Root/Microsoft/Windows/TaskScheduler
$eventTrigger = New-CimInstance -CimClass $eventTriggerClass -ClientOnly
$eventTrigger.Subscription = '<QueryList><Query Id="0" Path="System"><Select Path="System">*[System[Provider[@Name=''Microsoft-Windows-Power-Troubleshooter''] and EventID=1]]</Select></Query></QueryList>'
$eventTrigger.Enabled = $true

$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($dailyTrigger, $startupTrigger, $eventTrigger) -Settings $settings -Description "Denni sber dat o bytech na prodej (Trh bytu appka) - 8:00 + dohani start/probuzeni PC" -Force
```

Ověření: `(Get-ScheduledTask -TaskName "Trh bytu - sber dat").Triggers` má
mít 3 položky (`MSFT_TaskDailyTrigger`, `MSFT_TaskBootTrigger`,
`MSFT_TaskEventTrigger`).

### Spuštění bez blikajícího okna

Naplánovaná úloha s akcí `node <skript>` při každém běhu na vteřinu
bliknou černým oknem příkazové řádky — otravné hlavně u úlohy, co běží
každých 5 minut (viz "Telegram tlačítka" níž). Řešení: `scripts/run-hidden.vbs`
— spustí se přes `wscript.exe` místo přímo `node`, skript pak node spustí
v úplně skrytém okně (`objShell.Run ..., 0, True`):

```powershell
$action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument '"C:\Users\roman\Documents\Hlídací pes\scripts\run-hidden.vbs" "trh-bytu\<skript>.js"'
```

**Past, na kterou appka narazila naostro:** `run-hidden.vbs` má v sobě
natvrdo cestu k repu, a "Hlídací pes" obsahuje české znaky — klasický
VBScript engine (cscript/wscript) čte `.vbs` soubor v ANSI kódové stránce,
ne UTF-8, takže "í" v cestě dokázal rozbít natolik, že `objShell.Run`
hlásil `Systém nemůže nalézt uvedený soubor` (kód 80070002), i když cesta
evidentně existovala. Oprava: použít KRÁTKOU (8.3) variantu cesty, ta je
vždy čistě ASCII:

```powershell
$fso = New-Object -ComObject Scripting.FileSystemObject
$fso.GetFolder("C:\Users\roman\Documents\Hlídací pes").ShortPath
# → C:\Users\roman\DOCUME~1\HLDACP~1
```

`run-hidden.vbs` tuhle krátkou cestu už má zapsanou — při přesunu repa
jinam (jiný PC, jiná složka) je potřeba vygenerovat ji znovu a soubor
upravit.

## Kde jsou data

- `data/trh-bytu.sqlite` — databáze (inzeráty, časová osa událostí, fotky).
- `data/photos/<zdroj>_<id>/` — stažené fotky, max. 10 na inzerát. Jen fotky
  samotného bytu: detail RealityMIX, iDNES i Bazoše má vedle galerie i fotku
  makléře, logo realitky a „podobné nabídky" (jiné byty), takže parsery v
  `detail/` berou jen galerii bytu (RealityMIX podle ID nabídky v cestě, iDNES
  jen `.b-gallery`, Bazoš podle ID inzerátu). Starší záznamy s cizími fotkami
  vyčistil `node trh-bytu/cleanup-foreign-photos.js` (bez `--apply` jen vypíše).
  **iDNES fotky jsou v plné velikosti** (cca 1333×1000, stovky kB): berou se z
  odkazů galerie pro lightbox, ne z miniatur (pár kB), a je jich víc než dřív
  (galerie má i fotky, které miniatury neukazovaly). Miniatury u inzerátů, které
  byly ještě v nabídce, nahradil `node trh-bytu/upgrade-idnes-photos.js` (maže
  miniatury až po úspěšném stažení všech plných fotek); u zmizelých inzerátů už
  plné adresy nejdou získat, zůstávají miniatury.
- `data/track.log` — log každého sběrného běhu.

Nic z `data/` se necommituje do gitu (viz `.gitignore`) — je to čistě
lokální evidence.

## Data zůstávají i po zmizení z nabídky

Appka nikdy nic nemaže. Když byt zmizí z nabídky (pravděpodobně prodáno/
rezervováno/staženo), zapíše se jen `status = "removed"` + datum — popis,
fotky, parametry a celá časová osa zůstávají v databázi navždy, přesně tak,
jak byly naposledy zaznamenané. V běžném kódu appky (`track.js`, `server.js`,
`db.js`) není jediný `DELETE` nad tabulkami `listings`/`photos`/`events`;
jedinou výjimkou je jednorázový úklid cizích fotek (`cleanup-foreign-photos.js`,
viz „Kde jsou data"), který maže jen fotky, o kterých je jisté, že nejsou z
galerie bytu.

## Kdy appka řekne „zmizelo z nabídky"

Že se inzerát nenašel ve výpisu portálu, ještě neznamená, že zmizel — appka
to dřív brala jako jistotu a mýlila se ve třech případech:

- **Neúplný výpis (Sreality).** Sreality řadí výsledky podle poslední úpravy
  a má jich v okrese přes 100 po ~21 na stránku. Appka stahovala jen 1.
  stránku, takže inzerát, který novější úpravy vytlačily na 2. stránku, se
  tvářil jako zmizelý, i když byl pořád v nabídce (a navíc appka většinu
  Sreality bytů vůbec neevidovala). Teď se stahují **všechny stránky**
  (`fetchSrealityAllPages` v `sources/sreality.js`); pokud by některá
  stránka byla prázdná nebo chyběla, sběr u Sreality raději selže, než aby
  vyhodnotil zmizení z neúplného seznamu. Ostatní portály (iDNES,
  RealityMIX, Bazoš, Bezrealitky) mají v těchto lokalitách všechny výsledky
  na jedné stránce — ověřeno porovnáním s počtem výsledků, které portál uvádí.
- **Znovu vložený inzerát.** Portál (typicky Bazoš) dá při opětovném vložení
  inzerátu nové ID. Když se ve stejném běhu u téhož portálu objeví nový
  inzerát se stejnou dispozicí, plochou (±1 m²) a stejným začátkem popisu,
  appka je spojí (`replaced_by`) a do časové osy zapíše událost **„Inzerát
  znovu vložen pod novým ID"** i s případnou změnou ceny (např. `2 290 000 Kč
  → na vyžádání`) — místo falešného „zmizelo z nabídky". Obě ID pak tvoří
  jeden řádek. Při nejednoznačné shodě (víc kandidátů) appka nespojuje nic.
- **Přechodný výpadek.** Zmizení se potvrzuje až tím, že inzerát chybí ve
  **dvou po sobě jdoucích bězích** (`missed_since` v DB). Mezitím zůstává v
  nabídce; potvrzené zmizení se datuje od prvního nenalezení.

## Přesná adresa bytu (a jednotka) — zapsat, dokud je inzerát online

Adresa v appce je jen **přibližná** (odhad z inzerátu, často jen „Česká
Třebová"). Až inzerát zmizí, jde byt v katastru dohledat mnohem hůř než dokud
je online, proto si u každé nabídky zapiš přesnou adresu hned, jak ji zjistíš:

- **Detail bytu → 📍 Přesná adresa:** pole *Adresa* (ulice, č.p./č.o., obec) a
  *Jednotka* (číslo jednotky nebo bytu). *Uložit adresu* uloží obojí (prázdné
  uložení vymaže), *Adresa neznámá* znamená „nabídku jsem prošel a adresu se
  zjistit nepodařilo" — to je jiný stav než „ještě jsem se nekoukal".
- **Přehled:** u každého bytu ve stavu V nabídce/Rezervováno je štítek
  **📍 doplnit adresu**, u vyplněného rovnou adresa, u neznámé „adresa
  neznámá". Filtr **📍 Bez adresy (N)** ukáže jen nabídky, které ještě
  nemáš prošlé (řazené od nejnovějších, takže nové jsou nahoře).
- **Kontrola v katastru** (níž) bere do řádku „Do katastru" tuhle adresu
  s jednotkou; bez ní jen přibližné místo a upozornění.
- Zapisuje se na byt jako celek (všechny portály, kde je). Je to samostatné
  pole vedle „Adresa / lokalita" z tabulky srovnání — to zůstává přibližným
  místem z inzerátu, které appka sama dohledává.

### Automatické určení adresy z polohy

Appka adresu zkouší určit sama, hned při prvním spatření inzerátu — ze stránky
zmizelého inzerátu souřadnice i adresa zmizí (ověřeno), takže pozdější
dohledání je mnohem těžší. Sbírá tři druhy důkazů (`geo-suggest.js`):

| Důkaz | Odkud | Důvěra |
|---|---|---|
| **Adresa od portálu** | Sreality: ulice + číslo popisné, **jen když prodejce zadal adresu** (`entityType: address`; „jen ulice / část obce / obec" Sreality řekne taky a číslo pak není). Bezrealitky: ulice, číslo jen občas | silný |
| **Text inzerátu** | „ulice Kubelkova 1759", „v ulici Dukelská 323" (jen s klíčovým slovem před ulicí, číslo před m²/Kč se nebere) | střední — sám nestačí |
| **Bod** | souřadnice z iDNES, RealityMIX, Bezrealitky, Sreality → nejbližší dům z OpenStreetMap, ověřený v RÚIAN | silný jen při splnění všech pojistek níž |

**Pojistky u bodu** (prodejce někdy zadá jen ulici — bod pak leží na silnici a
sdílí ho víc bytů): bod se bere, jen když (1) leží **uvnitř obrysu budovy podle
RÚIAN** (oficiální registr ČÚZK, `ruian.js`), (2) **žádný jiný byt nemá bod do 8 m**
(sdílený bod = ulice, nebo stejný dům, což z bodu nepoznáme — radši nic), (3)
ulice z bodu se **objevuje v inzerátu**, (4) číslo domu z mapy se **shoduje s
čísly popisnými té budovy v RÚIAN** a (5) dům **nemá víc čísel popisných**.
Poslední bod je důležitý: panelový blok má často víc vchodů s vlastním číslem
(např. Jilemnického 295–299 je jeden dům) a bod ukáže dům, ne vchod — takový
byt z bodu dostane jen **návrh**, adresu doplní až další důkaz (číslo od
Sreality, text inzerátu). Když si zdroje odporují (jiné číslo domu, číslo od
Sreality neodpovídá budově v bodě), nepřiřadí se nic.

### Katastrální území a údaje o domě (RÚIAN)

V katastru se byt nehledá podle města, ale podle **katastrálního území (k.ú.) +
čísla popisného** — a k.ú. se od města často liší (U Stadionu v České Třebové
leží v k.ú. *Parník*, Dukelská v Ústí v k.ú. *Hylváty*). Appka ho proto k
bytu dohledá v RÚIAN (kód i název) spolu s údaji o domě: všechna čísla
popisná, počet podlaží a bytů. Bere se z adresy bytu, jinak z bodu v inzerátu.
Ukazuje se v detailu pod adresou a ve frontě **🏛️ Katastr** v řádku „Do
katastru". Adresu zapsanou ručně appka ověří v RÚIAN hned po uložení.

- **Vysoká jistota** → adresa se doplní sama a v přehledu je u ní „(auto)", v
  detailu je vidět **důvod** (které zdroje se shodly). Střední jistota je jen
  **návrh** s tlačítkem „Použít návrh". Když se nepřiřadilo nic, detail řekne
  proč („bod sdílí další byt", „prodejce označil jen ulici"…).
- **Jednotku appka nikdy nedoplňuje** — není v inzerátech ani v registrech.
- Co zapsal uživatel (adresa, „neznámá"), automat nikdy nepřepíše. Adresu, kterou
  doplnil sám, při každém běhu přepočítává a když přestane být jistá (např.
  bod začal sdílet další byt), **odvolá**. Smazáš-li automatickou adresu,
  nevrátí se; tlačítko **🔄 Zkusit znovu automaticky** automat znovu zapne.
- Dva byty ve stejném domě (stejné číslo popisné od Sreality) dostanou oba tu
  adresu — to je správně. Pojistka „sdílený bod" se týká jen adresy odvozené z
  bodu.
- Geokodér je veřejná služba OpenStreetMap: max. 1 dotaz/s, výsledek se ukládá
  (`geocode_cache`), posílají se jen souřadnice veřejných inzerátů. Starší
  nabídky, které jsou ještě online, doplní `node trh-bytu/backfill-geo.js`
  (vypíše přehled — co se přiřadilo, co ne a proč). U **už zmizelých** inzerátů
  souřadnice nejsou a doplnit se nedají.

## Kontrola v katastru — jestli se zmizelý byt prodal (`/kontrola`)

Po zmizení inzerátu portál o prodeji nic neřekne (Sreality vrací 404, RealityMIX
a Bazoš přesměrují na výpis, iDNES napíše jen „nabídka již není aktivní" a
štítek „prodáno" zmizí spolu s ní), takže jediná jistota je katastr. Stránka
**🏛️ Katastr** ho nenahrazuje, jen práci kolem něj zkrátí:

- **Údaje o prodeji jsou jedny, ať je zadáš kdekoli** (`sale-record.js`, testy
  `sale-record.test.js`). Fronta Katastr, detail bytu (sekce **🏛️ Prodej a
  katastr**), tabulka srovnání i Telegram zapisují přes jeden kód do týchž sloupců a
  vždy na všechny nabídky jednoho bytu, takže se nic nerozejde:

  | Údaj | Zadáš v | Vidíš v |
  |---|---|---|
  | prodáno / neprodáno | Katastr (tlačítka), detail (vyplývá z níž), Telegram „Prodáno“ | štítek v přehledu a tabulce, detail, statistiky, Katastr |
  | vklad podán (datum) | Katastr, detail; automaticky z API katastru | Katastr, detail, souhrn na Telegramu |
  | LV | Katastr, detail | Katastr, detail, Telegram |
  | jednotka | detail („Přesná adresa“), Katastr (pole „jednotka“, „To je ten byt“); odhad appky z API je zvlášť | všude |
  | kupní cena, datum prodeje | Katastr, detail, tabulka (Víc sloupců) | statistiky (ceny/m² prodaných bytů), Katastr (Vyřízené), detail, tabulka |

  **Pravidlo, které to drží pohromadě:** cena, datum prodeje i podaný vklad
  znamenají, že je byt **prodaný** — zapíše se i verdikt (dřív cena zadaná v detailu
  nechala byt „zmizelý“ ve frontě a mimo „Prodáno“ ve statistikách). Prázdné pole v
  detailu údaj smaže, ve frontě Katastr se prázdné pole ignoruje (nic nemaže).
  **Vrátit mezi nerozhodnuté** smaže verdikt, vklad, kontrolu **i cenu a datum
  prodeje** (cena by jinak byt hned zase označila za prodaný; tlačítko se na to
  zeptá); LV a jednotka zůstávají, ty patří bytu. Formuláře ve frontě Katastr jsou
  předvyplněné tím, co už je zapsané jinde. Při startu se jednorázově dopočítá
  verdikt u starších záznamů, které mají cenu, datum nebo vklad, ale verdikt ne.
- **Rozvrh kontrol** (nahoře na stránce, štítek **🔎 kandidát prodeje** v
  přehledu u bytů, které jsou právě k vyřízení): po rezervaci trvá, než se prodej
  v katastru vůbec ukáže — kupec s hotovostí podá návrh na vklad za 1–3 týdny,
  kupec s hypotékou za 6–12 týdnů (schválení úvěru, podpis kupní smlouvy). Pevná
  připomínka „po 21 dnech a pak každé 3 týdny“ proto chodila u hypotéky zbytečně
  a u hotovosti pozdě. Appka teď plánuje **kontrolní body** podle dnů od
  rezervace (`kn-schedule.js`, čistá logika s testy `kn-schedule.test.js`):
  - **Hotovostní kupec:** 14. a 28. den od rezervace.
  - **Hypotéka:** od 45. do 100. dne jednou týdně, potom 130., 160. a 190. den;
    kdo se nezjistí ani pak, přesune se do „Nezjištěno“.
  - **Inzerát zmizel:** kontrola 3 a 10 dní po zmizení (inzerát se stahuje často
    kolem podpisu smlouvy, takže plomba bývá dny až týdny po něm).
  - **Vklad podán (plomba v katastru):** prodej je potvrzený, zbývá cena. Ta jde
    zjistit až po rozhodnutí o vkladu (ochranná lhůta, rozhodnutí většinou do
    měsíce), proto první kontrola ceny **25. den po podání**, pak týdně do 90. dne.
  Byt je „k vyřízení“, když existuje kontrolní bod v minulosti, po kterém ještě
  nebyla kontrola. *Zatím nic* proto byt odsune **až k dalšímu bodu**, ne o pevný
  počet dní, a vynechaný běh nic nestlačí. Sekce **Zkontrolovat teď** ukazuje jen
  byty k vyřízení; ostatní jsou sbalené v „Čeká na další kontrolu“ (s datem další
  kontroly). Pod rozvrhem je nenápadně vidět **medián z tvých dat** (dny od
  rezervace k podání vkladu), ať jde konstanty časem doladit.
  Karta bytu má řádek „Do katastru“ (adresa, k.ú., dům, jednotka) a pole
  **LV č.** (nepovinné — příště pak stačí k.ú. + LV, bez dohledávání podle
  adresy). Rezervované byty **bez adresy** jsou zvlášť jako připomínka „doplň
  adresu, dokud je inzerát online“ — bez adresy je v katastru nejde najít.
- **Telegram souhrn:** místo jedné zprávy na byt chodí **jedna souhrnná zpráva**
  „🏛️ Kontrola v katastru (N)“ ve chvíli, kdy nějakému bytu s přesnou adresou
  nastal kontrolní bod (adresa, jednotka, LV, k.ú., důvod „14. den od
  rezervace…“). Každý bod se ohlásí jen jednou (sloupec `kn_digest_cp`), takže
  zpráva nechodí při každém běhu; v jedné zprávě je max. 8 bytů, zbytek příště.
  Výsledek se zapisuje v appce (tlačítka ve zprávě nejsou); selhání Telegramu
  body neoznačí a zkusí se další běh.
- **Plomby z bezplatného API katastru** (`kn-api.js`, `kn-plomba.js`,
  `kn-scan.js`; testy `kn-api.test.js`, `kn-plomba.test.js`, `kn-scan.test.js`):
  po každém sběru (`track.js`) appka projde domy rezervovaných bytů s přesnou
  adresou a zjistí, které jednotky mají **plombu** (podaný návrh na vklad). Z řízení
  čte přesné **datum podání** a stav. Cenu API nedává — ta zůstává na tobě (výpis
  z katastru za 50 Kč, nebo ručně).
  - **Klíč** `KN_API_KEY=…` patří do `.env.local` v kořeni repa (stejný soubor
    jako Telegram; jedna řádka, bez uvozovek, nikdy do gitu ani do chatu).
    Bez klíče se tahle část přeskočí. Klíč má **omezenou platnost** (aktuální
    vyprší 12. 4. 2027 — vygeneruj nový v portálu `api-kn.cuzk.gov.cz`).
  - **Limit volání** je 500 za období (den) a plomby jsou vidět jen u jednotky, ne u
    domu: sken domu stojí 1 + počet bytů volání (22 bytů ≈ 23), dům s jednotkou
    bytu zapsanou nebo odhadnutou 1–3. Proto se **dávkuje**: dům se znovu prochází
    nejdřív po **5 dnech** a denně se vezme nejvýš pětina domů, nejstarší první
    (`CYCLE_DAYS`, `selectBuildingsToScan`). Plomba trvá týdny (řízení o vkladu),
    takže ji pětidenní cyklus nepropásne, jen oznámí o pár dní později. Nový byt
    se zkontroluje hned: při dalším sběru, nebo **ihned po uložení adresy v appce**
    (server k tomu načte `KN_API_KEY` z `.env.local`; ať byt s právě doplněnou
    adresou nevisí v „Zkontrolovat teď“ do dalšího sběru). Garáže a nebytové
    prostory se při dalších skenech přeskakují. Navíc je tvrdý strop 350 volání
    denně (100 zůstává v rezervě) a dům, na který by rozpočet nestačil celý, se
    neskenuje — neúplný sken by prohlásil nezkontrolované jednotky za čisté. Když
    rozpočet nestačí na všechny domy, track.log to napíše („nejstarší kontrola domu
    je N dní stará“).
  - **Jednotka bytu zapsaná** (v detailu bytu jako `č.p./číslo`, např. `412/12`):
    plomba po rezervaci na ní je silný důkaz → appka sama zapíše „Vklad podán“
    s datem z řízení (i LV), pošle zprávu na Telegram a byt přejde do fáze ceny
    (první kontrola ceny 25. den po podání).
  - **Cena po podání vkladu a konec plomby.** Kupní cenu jde v katastru zjistit až
    po rozhodnutí o vkladu, tedy po konci plomby. Byt s podaným vkladem proto
    zůstává v Katastru v evidenci (skupina „Čeká na další kontrolu“, rozbalená) i
    **během** plomby a připomene se podle kalendáře (25., 32., 39. den po podání…).
    U karty (i v detailu bytu) je pole **konec plomby**: zadáš datum, které vidíš v
    katastru — i budoucí — a cena se pak připomene **až od něj** („Plomba skončila
    D. M. — zjisti kupní cenu“); dřívější připomínky se do té doby odloží. Zadání
    nebo změna konce plomby ruší dřívější „Zatím nic“. Když plomba na známé
    jednotce zmizí a API to zachytí, cena je k vyřízení hned i bez zadaného data. Po
    zjištění ceny je byt „Prodáno“ s ověřenou cenou (tu pak statistiky použijí).
  - **Jednotka neznámá → shoda na úrovni domu.** V malé lokalitě se v domě za pár
    týdnů neprodávají dva byty, proto se plomba spojí s bytem **sama**, když je
    jasno: dům má právě **jeden** sledovaný byt (rezervovaný nebo zmizelý) bez
    jednotky a vkladu a právě **jednu** volnou jednotku s plombou po rezervaci
    (`matchFilings`). Zapíše se „Vklad podán“ a odhadnutá jednotka (`kn_auto_unit`,
    ruční `unit_number` to nikdy není), zpráva na Telegramu i karta to označí
    jako **odhad**. Nespojí se, když v domě jiný sledovaný byt čeká na plombu taky,
    když plomby jsou dvě, když jiný byt v domě má vklad zapsaný bez jednotky, nebo
    když uživatel odhad už jednou zrušil, nebo když má dům víc než **30 bytů**
    (`AUTO_LINK_MAX_FLATS`; garáže se nepočítají) — ve velkém domě se za pár týdnů
    běžně prodá i jiný byt, takže plomba bez potvrzení k bytu nepatří. V těch
    případech karta ukáže **nápovědu**
    (č., LV, podíl na společných částech, datum podání, stav) s tlačítkem **To je
    ten byt**, které zapíše jednotku, vklad i LV.
  - **Zmizelé byty bez rezervace** (Sreality rezervaci vůbec neukazuje a inzerát se
    mohl stáhnout dřív, než ji někdo zapsal) hlídá API taky. Místo začátku
    rezervace se bere **zmizení inzerátu** (plomba podaná do 14 dní před ním se
    ještě počítá) a hlídá se **120 dní** po něm (`UNRESERVED_HORIZON_DAYS`,
    `unreservedTrack`). Podmínka je stejná jako jinde: přesná adresa a dům v ISKN —
    zmizelý byt bez adresy se zkontrolovat nedá, dokud se adresa nedoplní (ukládání
    adresy pak dům prohledá hned). Pravidla jsou taky stejná: ve domě do 30 bytů a
    s jedinou volnou plombou se přiřadí sama, jinak je byt v seznamu **nahoře** s
    nápovědou a tlačítkem „To je ten byt“; kde API nic nenašlo, leží byt ve sbalené
    skupině „Zmizelé byty, které hlídá API katastru“. Po potvrzení (nebo
    automatickém přiřazení) je byt „Prodáno — vklad podán“ a jde do fáze ceny jako
    rezervovaný, s časovou osou „Bez rezervace · inzerát zmizel …“.
  - **Ruční kontrola se tam, kde hlídá API, nepřipomíná.** Pokud se dům
    prochází a sken je čerstvý (do 8 dnů), nemá smysl chodit do katastru
    „zkontrolovat, jestli je podaný vklad“ — appka už ví, že není. Takový byt
    nepatří do „Zkontrolovat teď“ ani do Telegram souhrnu a leží ve sbalené
    skupině **Hlídá appka přes API katastru**. Ozve se jen když najde plombu,
    kterou nedokázala jednoznačně přiřadit („V domě je podaný vklad — potvrď,
    jestli je to tenhle byt“; „Zatím nic“ to odloží do příchodu novější plomby).
    Rozvrh dnů od rezervace platí dál jen tam, kam API nedosáhne: dům bez skenu
    (bez klíče, nový, rozpočet nestačil), starší sken, byt bez přesné adresy.
    Po půl roce bez plomby byt skončí jako „nezjištěno“ jako dřív. Fáze ceny se
    nemění: cena se hledá až po podání vkladu.
  - **Vrácení:** „Zrušit vklad podán“ u odhadnutého vkladu smaže odhad a tomuhle
    bytu už se nic automaticky nepřiřadí (`kn_auto_off`). Vklad podán před
    rezervací (s rezervou 14 dní) se nepočítá.
  - Když plomba z minula zmizela, řízení skončilo (vklad proveden, nebo
    zamítnut) — karta to napíše i se stavem řízení („zjisti cenu“).
  - **Družstevní byty** v katastru žádný vklad nemají (převádí se členský
    podíl), API u nich nic nenajde: dům Křib 1807 je družstevní a API u něj nevrací
    žádné jednotky. Karta to napíše („Dům nemá v katastru vymezené jednotky“);
    cena ani prodej se tu ověřit nedají. Takový byt proto **jde rovnou do
    „Vyřízených“** jako „Nejde ověřit v katastru“ (s důvodem a datem zmizení) a
    nikde se nehlídá ani nepřipomíná. Týká se to bytů, které jsou družstevní podle
    portálu (nebo ručně opraveného vlastnictví), i bytů v domě, který API nezná s
    jednotkami; platí pro rezervované i zmizelé, s rezervací i bez ní. Dům bez
    jednotek se přestane prohledávat (znovu jen jednou za 60 dní,
    `NO_UNITS_RECHECK_DAYS`), ať se nepálí volání zbytečně. Stav se nemění, když
    uživatel byt ručně označí jako prodaný (vklad podán / cena) — pak platí jeho
    údaj. Portálem prodaný družstevní byt je vyřízený s poslední cenou −10 %
    (viz výš).
  - **Neověřitelný byt se nezahazuje — jde o aspoň částečně prodaný byt.** Hlavní
    účel appky je přehled o prodaných a téměř jistě prodaných bytech, takže i byt,
    který v katastru nejde ověřit, má cenu a počítá se (`isAlmostSold`,
    `statsSalePrice` v `sale-record.js`): **poslední cena −10 %**, označená „nejde
    ověřit“. Ve „Vyřízených“ řádek říká, kolik se ve statistikách počítá, a má
    formulář **Znám skutečnou cenu** — zadáš-li ji (od makléře, z družstva…), byt je
    „Prodáno“ s ověřenou cenou a koeficient se přestane používat. Stejně se dá cena
    zadat v detailu bytu.
  - **Statistiky: „Prodané a téměř jistě prodané byty“** (bez ohledu na stav
    bytu, po městech a dispozicích): prodané (z katastru, nebo podle portálu), **po
    rezervaci zmizelé** (téměř jistý prodej) a **zatím jen rezervované** (kupec už
    je, ale rezervace může padnout; pak byt z přehledu sám zmizí). U každého bytu je
    vidět, na čem prodej stojí („prodáno“ / „zmizelo po rezervaci“ /
    „rezervováno“) a odkud je cena („ověřeno“ / „nejde ověřit — poslední cena −10 %“ /
    „čeká na ověření v katastru — poslední cena −10 %“; neověřená cena se tedy
    počítá −10 % vždy, dokud ji neověříš — skutečná cena pak odhad nahradí).
    Zmizelý byt **bez** rezervace sem nepatří
    (je to jen možný prodej), byt bez ceny v inzerátu („cena na vyžádání“) taky ne,
    dokud nezadáš skutečnou, a ručně skrytý byt (křížek) se nepočítá nikdy. Starší
    sekce „Ceny po rekonstrukci“ zůstává, jen užší.
  - Výsledky skenu leží v tabulce `kn_scans` (jeden řádek na dům).
- **Možný prodej:** byt, který byl těsně před zmizením **rezervovaný** a do
  nabídky se nevrátil, má v přehledu štítek **Možný prodej** (a ve filtru „Čeká na ověření“) místo obyčejného „Zmizelo z nabídky" — po rezervaci se inzerát
  typicky stahuje, takže poslední známá informace je „rezervováno". Vrátí-li se
  inzerát do nabídky, byt je zase „V nabídce" a štítek zmizí sám; zadáš-li
  výsledek z katastru, štítek nahradí „Prodáno" / „Staženo (neprodáno)". Filtr
  „Zmizelo z nabídky" dál ukazuje všechny zmizelé včetně možných prodejů.
  Když se byt **30 dní** (`PROBABLE_SALE_AFTER_DAYS` v `sale-triage.js`) nevrátil,
  štítek se změní na **Pravděpodobně prodáno** (oba jsou ve filtru „Čeká na ověření“).
  Verdikt dál dává jen katastr.
- **Rychlý přehled prodaných bytů: dva filtry na úvodní stránce i v tabulce
  srovnání.**
  - **Prodáno** je přísné: jen byty s **potvrzenou cenou** — cena z katastru
    (nebo zadaná ručně) a družstevní byty, které se v katastru ověřit nedají a
    portál je označil za prodané (platí poslední cena, ve statistice −10 %).
  - **Čeká na ověření** je všechno ostatní, co má šanci být prodané: byty
    zmizelé po rezervaci („Možný prodej“ / „Pravděpodobně prodáno“) a byty
    prodané podle portálu nebo s podaným vkladem, kterým zatím chybí potvrzená
    cena. Jakmile cenu potvrdíš (z katastru, nebo ručně v detailu / ve frontě
    Katastr / ve statistikách), byt do filtru **Prodáno** **přeskočí sám**.
  - Každý řádek má údaj **💰 cena prodeje**: ověřená („2 850 000 Kč (ověřeno)“),
    nebo odhad („~3 420 000 Kč (odhad −10 %, čeká na ověření)“ / „nejde
    ověřit“), k tomu stav vkladu („vklad podán …“, „plomba do …“). V tabulce je
    sloupec **Cena prodeje** (u filtrů Prodáno a Čeká na ověření rovnou vidět,
    jinak za „Víc sloupců“). Je to tentýž soubor bytů a stejné ceny jako ve
    statistikách („Prodané a téměř jistě prodané byty“), jen bez bytů, které
    jsou zatím jen rezervované (ty mají vlastní filtr „Rezervováno“).
  - **Byt nezapadne, ani když řízení na katastru trvá měsíce.** Po podání
    vkladu se na cenu ptá plán kontrol (25.–90. den) a pak **dál každých 30 dní
    (`PRICE_TAIL_DAYS`), dokud cenu nezjistíš** — fáze ceny nikdy neskončí jako
    „Nezjištěno“. Dům se hlídá přes API katastru ještě 400 dní
    (`SCAN_HORIZON_DAYS`) i po konci kalendářních kontrol, takže se plomba a
    vklad zachytí i s velkým zpožděním. Do té doby je byt vidět ve filtru
    „Čeká na ověření“ (a ve frontě Katastr, i ve skupině „Nezjištěno“).
- **Telegram upozornění na zmizení:** když rezervovaný byt zmizí ze **všech**
  portálů, ve stejném běhu přijde zpráva „Zmizel z nabídky po rezervaci — možný
  prodej" s adresou (nebo upozorněním, že chybí), k.ú. a obdobím „rezervováno od
  → zmizelo". Poslední řádek zprávy říká, co dál, podle toho, jestli byt umí
  hlídat API katastru: **hlídá se** (dům má sken) → „Plomby v domě hlídá appka
  sama a ozve se; byt je v Katastr → Hlídá appka přes API katastru“; **dům se
  prohledá při tomhle sběru** (nový dům); **nejde ověřit** (družstevní byt, dům
  bez jednotek) → appka nic nehlídá; **bez přesné adresy** → „doplň ji v detailu,
  appka pak dům prohledá hned“. Zmizení bytu navíc dům **přeskenuje hned** (ne až
  za 5 dní): vklad se čeká právě teď. Zpráva přichází, až byt zmizí ze všech
  portálů, takže může přijít o pár dní později než zmizení prvního inzerátu. Jednou na zmizení
  (`possible_sale_notified_at`); vrátí-li se byt do nabídky a znovu zmizí, přijde
  nové upozornění. Byty, které zmizely před zavedením upozornění, se
  neupozorňují zpětně, a byt s verdiktem z katastru taky ne. Neodešle-li se
  zpráva (výpadek Telegramu), zkusí se další běh.
- **Fronta zmizelých** = zmizelé byty bez verdiktu. U každého je řádek „Do katastru:"
  (adresa, dispozice, plocha, podlaží — z toho se byt v katastru dohledá) a
  „Rezervováno od … → zmizelo …" (nebo jen datum zmizení), ať je jasné, v jakém
  období převod hledat.
- **Odhad pravděpodobnosti prodeje** řadí frontu, nic netvrdí
  (`sale-triage.js`, každý bod má viditelný důvod): byl rezervovaný (+3),
  zmizel z víc portálů najednou (+1), před zmizením zlevnil (+1); proti mluví,
  že se po zmizení už jednou vrátil (−2) nebo visel jen pár dní (−1).
- **Tlačítka u rezervovaného bytu:** *Vklad podán* (den podání, výchozí dnes,
  nesmí být v budoucnu; byt je pak „Prodáno“ a plánuje se kontrola ceny),
  *Cena zjištěna* (kupní cena a datum prodeje z katastru → uloží se jako
  „Ověřená cena“ a „Datum prodeje“ a cena se započítá do statistik; prázdné pole
  nikdy nepřepíše dřív zapsanou hodnotu), *Zatím nic* (odsune k dalšímu
  kontrolnímu bodu), *Neprodáno* (byt je „Staženo (neprodáno)“ a ze statistik
  cen prodejů se vyřadí), *Zrušit „vklad podán“* a *Vrátit do fronty* u
  vyřízených. U zmizelých bytů **bez** rezervace jsou *Prodáno* / *Neprodáno* /
  *Zatím nic* jako dřív. Výsledek se zapisuje na všechny portály, kde byt je.
- „Neprodáno" platí jen do dalšího zmizení: když se byt po kontrole vrátí do
  nabídky a znovu zmizí, spadne do fronty znovu.
- „Prodáno" z Telegram připomínky se bere jako stejný verdikt (byt je pak
  „Prodáno"). Prodej označený z katastru nemá cenu, dokud ji nezadáš — na
  rozdíl od iDNES „prodáno", kde je poslední cena inzerátu prodejní.

## Vlastní poznámky u bytu

V detailu bytu (`/byt/<id>`) jde doplnit **ověřenou prodejní cenu, datum
prodeje a volnou poznámku** — až si sám dohledáš skutečnou cenu (např. v
katastru nemovitostí), zapiš si ji tam. Appka sama žádná data z katastru
nestahuje.

## Sloučení stejné nemovitosti napříč portály

**Inzeráty bez ceny** (RK ji nezveřejní — "Cena na vyžádání", "Dohodou";
reálný případ: byt 3+1 na Křibu je na Sreality, iDNES, Bazoši i RealityMIX a
u žádného ceny není) se neslučují podle ceny, ale **podle textu**: stejná
dispozice, plocha (±1 m²) a shodný úsek popisu (porovnává se úsek z
vnitřku popisu, protože iDNES předsazuje titulek). Portál bez popisu
(RealityMIX) se spojí přes **přesnou shodu adresy včetně ulice** (na pořadí částí nezáleží) — jen město
nestačí. Porovnávají se jen inzeráty z různých portálů a jen dvojice, kde
aspoň jeden cenu nemá; dva inzeráty s různou cenou jsou vždy dva byty.

V řádku se takový byt jmenuje **"… — cena na vyžádání"**; znamená to, že
cena není na žádném z portálů zveřejněná (appka ji nemá odkud přečíst),
ne že by se nevyčetla. U Bazoše, který k takové ceně připisuje vlastní
slovo, se ukáže i to: *"cena na vyžádání (Dohodou)"*, *(Nabídněte)*,
*(V textu)*. Jakmile ji některý portál uvede, ukáže se cena (bere se z
nejdůvěryhodnějšího portálu, který ji má). Skutečnou prodejní cenu si
můžeš doplnit ručně v detailu bytu.

**Cena z textu inzerátu.** Když portál cenu neuvádí, appka ji zkusí vyčíst
z popisu (tvary jako "Cena: 3.950.000 Kč", "za cenu 2 990 000 kč",
"cena 4 200 000,-", "cena 3,5 mil. Kč"; částka bez slova "cena" před
sebou se nebere, stejně jako částky pod 300 000 Kč). Taková cena se
v přehledu značí **"(z textu inzerátu)"**, protože text bývá zastaralý —
reálný příklad: v popisu stojí 3 950 000 Kč, na portálech už je 3 750 000
Kč (RK cenu snížila a text nechala). Bez zmínky ceny v textu (např. Bazoš
"V textu" jen píše, že je inzerent ochotný se o ceně dohodnout) se nic
nevymýšlí.

**Byt na víc portálech se ukáže jednou** — data (adresa, popis, parametry)
z nejdůvěryhodnějšího portálu, který je má, a fotky z kteréhokoli, který je
má (Sreality fotky nedává, viz níž). V řádku je vidět, kde byt ještě je a kde
už ne: *"Sreality.cz + Reality.iDNES.cz · zmizelo: RealityMIX.cz + Bazoš.cz"*.

U bytu na víc portálech říká odznak "Poslední změna", **u kterých portálů**
se změna stala (např. "Zmizelo z nabídky (Bazoš.cz + RealityMIX.cz)") —
zmizení ze dvou portálů ze čtyř není zmizení z trhu, byt je dál v nabídce.

Ostatní inzeráty (s cenou): appka je porovnává podle dispozice a ceny **přesně** — a
plochy **s tolerancí do 1 m²** (`AREA_TOLERANCE_M2` v `group.js`). Přesná
shoda plochy nestačí, protože portály evidentně měří/zaokrouhlují jinak —
reálný případ: tentýž byt na Dukelské v Ústí nad Orlicí má na Sreality
uvedenou plochu 51 m², na iDNES a RealityMIX 52 m². Bez tolerance appka
tenhle byt ukazovala jako dva samostatné řádky (a horší — Sreality bez
fotky, protože jejich CDN appce fotky nedá, viz níž — takže jeden ze
řádků byl zbytečně "Bez fotky", i když appka fotku odjinud měla).

Vědomě konzervativní i tak: shoda v rámci JEDNOHO portálu (dva různé byty
na Bazoši náhodou se stejnými parametry) se nikdy neslučuje — radši dva
řádky pro tutéž nemovitost navíc, než omylem sloučit dva různé byty do
jednoho a jeden tiše "zmizet" z přehledu. Bazoš navíc u stejného bytu
občas uvádí plochu o dost víc odlišnou (např. "CP 57 m²" u bytu, který má
jinde 51–52 m²) — to je za hranicí tolerance schválně, ať appka nesloučí
dva různé byty jen proto, že náhodou vyšly na stejnou dispozici a cenu.

Počítá se vždy čerstvě při zobrazení (appka si nikde neukládá "tohle patří
k tamtomu") — funguje okamžitě i na starších datech a nemůže se rozejít
se skutečností.

Důsledek pro stav: **rezervace na kterémkoli portálu = byt je rezervovaný**
("Rezervováno"), i kdyby ho jiný portál pořád nabízel jako volný — rezervace
je fakt o bytu, ne o portálu, a většina portálů ji vůbec neukazuje. Jinak
platí: pokud je nemovitost aktivní byť jen na JEDNOM portálu, appka ji
ukáže jako "V nabídce" (dá se pořád reálně sehnat), i kdyby na jiném
portálu mezitím zmizela. Řádek říká, kde je byt rezervovaný a kde zmizel
("· rezervováno: Reality.iDNES.cz", "· zmizelo: Bazoš.cz"), detail bytu
ukazuje stav KAŽDÉHO portálu zvlášť.

## Rezervace

Appka zaznamenává rezervaci při **každém** běhu a ze všech portálů, které ji
ukazují, do časové osy i odznaku "Poslední změna" ("Označeno jako
rezervováno (Reality.iDNES.cz)", a když se zruší, "Rezervace zrušena"):

| Portál | Kde je rezervace vidět |
|---|---|
| iDNES | štítek "Rezervováno" na kartě ve výpisu |
| RealityMIX | text "Rezervováno" na kartě ve výpisu |
| Bezrealitky | příznak `reserved` ve výpisu |
| Sreality | jen na detailu inzerátu (`stateCb` = Rezervováno); ve výpisu ne, filtr "Bez rezervovaných nabídek" je u nich prémiový — proto appka u Sreality čte detail všech sledovaných inzerátů |
| Bazoš | rezervaci vůbec nemá |

Když portál rezervaci v daném běhu nesdělil (Bazoš, nebo selhalo stažení
detailu Sreality), stav se nemění — chybějící informace rezervaci ani
nevytvoří, ani nezruší. Datum události je okamžik, kdy ji appka poprvé
uviděla (ne kdy ji zadala RK).

### Prodáno (iDNES)

iDNES u prodaného bytu dá na **detail** inzerátu štítek "prodáno" a prodejce
tam nechá skutečnou prodejní cenu (obvykle sníženou). Ve výpisu štítek není —
karta má jen "Zlevněno" a štítek "Rezervováno" z ní zmizí, takže bez detailu by
appka prodej vyhodnotila jako zrušenou rezervaci s další slevou. Proto appka u
iDNES čte detail i u známých inzerátů, dokud nejsou prodané.

Prodej je **konečný stav** "Prodáno" (vlastní filtr a štítek, událost "Prodáno
— prodejní cena X Kč" v časové ose, datum = kdy ho appka zjistila). Přebíjí
rezervaci i "v nabídce" (stejně jako rezervace je to fakt o bytu, ne o portálu),
zmizení z výpisu ho už nepřepíše, a souhrn kontrol v katastru se u něj zastaví, jakmile je cena ověřená. Do statistik "ceny po rekonstrukci" se prodaný byt počítá
(se stavem "Po rekonstrukci"). **Cena z inzerátu, který portál označil jako
„prodáno“, ale ověřená NENÍ** — je to poslední inzerovaná cena, ne kupní (po
slevě a vyjednávání se byt prodá jinak). Takový byt jde do fronty Katastr (fáze
ceny, první kontrola 25 dní po prodeji, nebo po podání vkladu podle API) a ve
statistikách se počítá jako „odhad“, dokud se cena neověří. **Výjimka: družstevní
byt** — v katastru se nepřevádí vkladem a cena ani vklad se tam ověřit nedají, proto
je byt rovnou vyřízený a bere se poslední cena z portálu. Ta je ale **inzerovaná, ne
kupní** (po vyjednávání se byt prodá níž), takže se do statistik počítá **snížená o
10 %** (`ASSUMED_PRICE_DISCOUNT` v `sale-record.js`) a všude je označená jako
odhad: ve statistikách „družstevní — poslední cena −10 %“ (a zvlášť v počtech), v
detailu i ve „Vyřízených“ s oběma částkami. Cena se nikam neukládá, počítá se při
čtení; jakmile zadáš skutečnou cenu, platí ta (a koeficient se už nepoužije).
Družstevní byt se pozná podle vlastnictví z inzerátu (nebo ručně opraveného v
„Doplnit parametry“), případně podle toho, že dům v katastru nemá jednotky; takové
byty se přes API ani nekontrolují.

**Telegram upozornění:** appka na rezervaci pošle i zprávu přes stejného
Telegram bota jako hlídací pes (`TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` v
`.env.local` v kořeni repa — appka na ně jinak nesahá, jen kvůli týhle jedné
notifikaci). Důvod: zvoneček v appce uvidíš, jen když appku zrovna otevřeš,
ale "je rezervováno" je signál na okamžitou akci (zkontrolovat převod v
katastru), ne něco, co počká do příští návštěvy appky. Posílá se při nové
rezervaci na kterémkoli portálu (i u bytu, který appka zaeviduje už jako
rezervovaný), nikdy při zrušení rezervace. Chybějící `.env.local` nebo
výpadek Telegramu sběrný běh nezastaví, jen se zaloguje.

### Kontrola v katastru po rezervaci (Telegram souhrn)

Dřív appka u každé rezervace posílala za 21 dní zprávu „⏰ Pořád rezervováno?“ s
tlačítky a pak každé 3 týdny znovu. To je pryč — nahradil to **rozvrh kontrol**
(viz kapitola „Kontrola v katastru“ výš): ozve se jen ve chvíli, kdy má smysl se
v katastru na byt podívat, a o všech bytech najednou jednou zprávou.

Zprávy se posílají na konci každého sběrného běhu (`track.js`). Výsledek kontroly
(*Vklad podán*, *Cena zjištěna*, *Zatím nic*…) se zapisuje v appce na stránce
**🏛️ Katastr**, ne tlačítkem ve zprávě.

**Starší zprávy s tlačítky** (✅ Prodáno / ⏳ Odložit o 3 týdny), které už máš
v chatu z dřívějška, appka dál zpracuje: *Prodáno* označí byt jako prodaný,
*Odložit* ho odsune k dalšímu kontrolnímu bodu.

**Zpracování kliknutí NENÍ okamžité** — appka nemá žádný server běžící na
pozadí (na rozdíl od webhooku by to vyžadovalo appku vystavenou na
veřejnou adresu, což tahle appka záměrně nedělá), takže Telegram jen čeká,
až se appka sama zeptá, jestli něco nového přišlo (`getUpdates`). K tomu
slouží **samostatná naplánovaná úloha** `trh-bytu/process-telegram.js` —
na rozdíl od `track.js` (jednou denně, plný sběr) tahle neumí nic jiného
než přečíst čekající kliknutí, takže se dá spouštět často beze zátěže na
sledované portály:

```powershell
$action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument '"C:\Users\roman\Documents\Hlídací pes\scripts\run-hidden.vbs" "trh-bytu\process-telegram.js"'
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)
Register-ScheduledTask -TaskName "Trh bytu - telegram tlacitka" -Action $action -Trigger $trigger -Description "Kazdych 5 minut zpracuje kliknuti na tlacitka ze starsich Telegram pripominek (Trh bytu appka)"
```

(`-RepetitionDuration ([TimeSpan]::MaxValue)` tady NEJDE — Task Scheduler jeho
XML hodnotu odmítne jako "mimo rozsah"; 10 let je dost dlouho a je to platná
hodnota.)

S během po 5 minutách se kliknutí projeví do ~5 minut (ne okamžitě, ale ne
ani "až zítra"). Po zpracování appka: smaže tlačítka z původní zprávy (ať
nejdou zmáčknout podruhé) a pošle novou, TRVALOU zprávu do chatu s
potvrzením — Telegramova vlastní "načítá se" bublina po kliknutí totiž zmizí
po pár vteřinách a snadno unikne pozornosti. Protože nové zprávy tlačítka
nemají, je tahle úloha už jen dobíhající pojistka pro staré zprávy; jinak ji
nepotřebuješ.

## Zvoneček (upozornění)

V hlavičce appky je **🔔** — červené číslo u něj říká, kolik upozornění
přibylo od doby, kdy jsi je naposledy přečetl. Klik otevře stránku
**Upozornění** (`/upozorneni`): všechna upozornění od nejnovějšího,
nepřečtená zvýrazněná, u každého byt (s cenou / poslední známou cenou), co se
stalo, kdy a na kterém portálu; klik vede na detail bytu. Pilulky nahoře
filtrují podle druhu. Tlačítko **"Označit vše jako přečtené"** zvoneček
vynuluje — samotné otevření stránky upozornění nepřečte, ať žádné nezmizí
omylem.

Tři druhy upozornění:

| | Kdy vznikne |
|---|---|
| 🔒 **Rezervace** | byt přešel z "nerezervovaný" na "rezervovaný" (na kterémkoli portálu) |
| 💰 **Změna ceny** | byt má novou cenu — "3 900 000 Kč → 3 800 000 Kč (−100 000 Kč)"; i "cena → na vyžádání" u znovu vloženého inzerátu |
| 🆕 **Nová nabídka** | byt, který appka dřív neznala |

Pravidla, ať zvoneček nezahltí šumem:

- **Jeden byt = jedno upozornění**, i když se změna projeví na třech
  portálech (události z jednoho sběrného běhu se slučují). A vždy jen **nová
  informace**: když další portál později "dožene" rezervaci nebo cenu, kterou
  appka už hlásila, nové upozornění nevzniká.
- **Nové nabídky se sledují od zapnutí upozornění** — jinak by zhruba 100 bytů
  z prvního sběru bylo "nových". Nová nabídka je jen byt, jehož NEJSTARŠÍ
  inzerát (napříč portály) appka zaevidovala až po tom; byt, který jiný portál
  znal dřív, novou nabídkou není.
- **Skryté byty (✕)** hlásí **rezervace i pohyb ceny** (viz "Vyřadit") — to
  jsou informace o trhu, které chceš vidět i u vyřazeného bytu. Nehlásí jen
  nové nabídky (skrýt jde jen byt, který jsi už viděl).
- Upozornění se objeví po **dalším sběrném běhu**, který změnu uvidí (denně,
  případně po probuzení PC) — appka portály nesleduje průběžně.
- Když rezervace mezitím skončila, upozornění to říká (*"nyní: V nabídce"*).
- Zvoneček hlásí i **nově nalezený byt, který už je rezervovaný**.
- Přečteno/nepřečteno a "nové od" jsou jediné údaje navíc, co se ukládají
  (tabulka `app_state`); samotná upozornění se počítají z historie událostí.

## Vědomá omezení (v1)

- **Rezervaci u Bazoše appka nepozná** — Bazoš ji nemá. U bytu, který je jen
  na Bazoši, se stav pozná až zmizením z nabídky (`removed`) — bez
  rozlišení, jestli šlo o rezervaci, prodej, nebo že majitel inzerát prostě
  stáhl z jiného důvodu.
- **Popis u RealityMIX appka nezíská** — na jejich detailu se dotahuje až
  přes JavaScript na klientovi, v syrovém HTML není. Fotky a základní údaje
  (dispozice, m², cena) u RealityMIX fungují normálně.
- **Fotky u Sreality appka nezíská** — jejich CDN vrací na každý pokus o
  stažení "401 Unauthorized", bez ohledu na hlavičky (ověřeno naostro).
  Zbytek (popis, dispozice, m², cena) u Sreality funguje normálně. U
  ostatních 4 portálů se fotky stahují bez problémů.
