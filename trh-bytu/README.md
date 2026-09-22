# 🏠 Trh bytů

Lokální appka vedle hlídacího psa — dlouhodobě eviduje byty na prodej v
sledované oblasti (stejná lokalita jako watch `byty` v [`../config.js`](../config.js)):
kdy se objevily, jak se jim vyvíjela cena, kdy zmizely z nabídky
(pravděpodobně prodáno/rezervováno jinde/staženo z jiného důvodu —
appka to nikdy netvrdí jistě). U každého bytu drží dispozici, plochu,
popis, fotky a odkaz na inzerát.

**Stejná nemovitost inzerovaná na víc portálech se ukáže jen jednou**
(shoda dispozice+plochy+ceny napříč zdroji, viz [`group.js`](group.js)) —
appka ji spojí do jednoho záznamu se všemi odkazy, **jedním popisem**
(vybere ten nejdelší, ne kopie z každého portálu), sloučenou galerií fotek
(když jeden portál fotky nemá — typicky Sreality, viz níž — appka je
ukáže z jiného portálu se stejnou nemovitostí) a společnou časovou osou
napříč portály.

**Strukturované parametry** (vlastnictví, stav, typ budovy, podlaží,
energetická náročnost, výtah, balkón/lodžie/terasa/sklep/parkování/garáž)
— podobně jako je Sreality/Bazoš ukazují u vlastní nabídky, viz
[`params.js`](params.js). K dispozici jsou jen ze Sreality a Bezrealitky
(jediné dva portály se strukturovaným JSON na detailu) — u ostatních zůstává
sekce Parametry skrytá.

**Hlavní přehled je dlaždicový**, ne tabulkový — každá dlaždice má
náhledovou fotku (nebo "Bez fotky", když ji appka nemá u žádného
sloučeného zdroje), stav a čitelný nadpis ve tvaru
`Byt 2+1, 55 m², Letohrad, ul. U dvora — 3 750 000 Kč`. Adresa je vždy tak
podrobná, jak ji appka zná — ulice, když je (od portálu nebo vytažená z
titulku u Bazoše, viz `parse.js`), jinak jen město/městská část; chybí-li
úplně, appka ji z titulku prostě vynechá.

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
