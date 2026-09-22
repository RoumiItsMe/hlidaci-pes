# 🏠 Trh bytů

Lokální appka vedle hlídacího psa — dlouhodobě eviduje byty na prodej v
sledované oblasti (stejná lokalita jako watch `byty` v [`../config.js`](../config.js)):
kdy se objevily, jak se jim vyvíjela cena, kdy zmizely z nabídky
(pravděpodobně prodáno/rezervováno jinde/staženo z jiného důvodu —
appka to nikdy netvrdí jistě). U každého bytu drží dispozici, plochu,
popis, fotky a odkaz na inzerát.

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

## Vlastní poznámky u bytu

V detailu bytu (`/byt/<id>`) jde doplnit **ověřenou prodejní cenu, datum
prodeje a volnou poznámku** — až si sám dohledáš skutečnou cenu (např. v
katastru nemovitostí), zapiš si ji tam. Appka sama žádná data z katastru
nestahuje.

## Vědomá omezení (v1)

- **Žádné sloučení stejného bytu napříč portály** — pokud je stejná
  nemovitost inzerovaná na dvou portálech, appka ji povede jako dva
  samostatné záznamy. Pro odhad rozsahu prodejních cen v okolí to nevadí
  (jen mírně nadhodnotí počet nabídek).
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
