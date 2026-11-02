# Cloudový sběrač (sběr dat, když PC není zapnuté)

Appka sbírá data na PC (naplánovaná úloha v 8:00, při startu PC a tlačítko „Aktualizovat teď“). Když je PC týden
vypnuté, vznikne v datech týdenní mezera a změny z té doby se zapíšou, jako by se staly až při dalším startu.

**Cloudový sběrač** tu mezeru zmenší na jeden den: jednou denně (spouští ho externí cron, viz [Spolehlivý spouštěč](#spolehlivý-spouštěč-cron-joborg)) stáhne výpisy portálů na GitHub Actions a uloží je jako
snímky do **soukromého** repozitáře. Appka si je při dalším sběru stáhne a zapíše stejnými pravidly jako běžný sběr,
ale s časem, kdy snímek vznikl. Databáze zůstává jen na tvém PC, takže se nic neslučuje a tvoje poznámky, ruční
sloučení, jednotky a ověřené ceny nikam neodcházejí.

```
GitHub Actions (denně)                     tvoje PC (při sběru)
 scout.js ─► snapshots/<region>/<čas>.json ─► git pull ─► snapshot-replay.js ─► databáze
 (soukromé repo)                              TRH_SNAPSHOT_REPO v .env.local
```

## Co to stojí

Jeden běh trvá zhruba 3,5 minuty (obě sekce; GitHub účtuje 4). Při jednom běhu denně je to **asi 120 minut
měsíčně**, s přeskočeným záložním plánovaným během (viz níž, 1 minuta denně) **nejvýš 150**, tedy do 7,5 % z 2 000
bezplatných minut soukromých repozitářů (GitHub Free). Snímky mají kolem 35 kB na sekci, ročně jde o desítky MB.
Kdyby sběr selhal, GitHub pošle e-mail o neúspěšném běhu.

## Nastavení (jednorázově, 5 minut)

1. **Soukromé repo pro snímky** (prázdné, jen pro tyto soubory):

   ```sh
   gh repo create trh-bytu-data --private --clone
   ```

   Naklonuje se do aktuální složky, např. `C:\Users\roman\Documents\trh-bytu-data`.

2. **Workflow:** zkopíruj [`scout.yml`](scout.yml) do toho repa jako `.github/workflows/scout.yml`, `commit` a `push`.
   (Kód sběrače si workflow při každém běhu samo stáhne z veřejného repa `hlidaci-pes`, takže ho nemusíš aktualizovat.)

3. **Vyzkoušej ho ručně:** na GitHubu v soukromém repu *Actions → Sběrač (Trh bytů) → Run workflow* (nebo
   `gh workflow run scout.yml`). Po pár minutách musí v repu přibýt `snapshots/default/…json` a `snapshots/nachod/…json`.

4. **Napoj appku:** do `.env.local` v kořeni projektu přidej cestu k lokálnímu klonu:

   ```
   TRH_SNAPSHOT_REPO=C:\Users\roman\Documents\trh-bytu-data
   ```

   Git na PC musí umět `git pull` bez dotazu na heslo (stačí, že už jsi přihlášený k GitHubu, např. přes `gh auth login`).
   Appka pouští `git pull` s vypnutým dotazováním, takže ve špatném případě jen zaloguje chybu a použije snímky, které už
   jsou na disku.

5. **Spouštěč:** nastav externí cron podle [Spolehlivý spouštěč](#spolehlivý-spouštěč-cron-joborg). Bez něj sběrač
   jede jen podle GitHubova plánovače, který u tohoto účtu chodí o hodiny později nebo vůbec.

Od té chvíle při každém sběru (úloha v 8:00, start PC i tlačítko) appka nejdřív přehraje nové snímky a pak udělá svůj
běžný sběr. V `track.log` je to vidět jako `=== Přehrávám snímek z cloudu: … ===`.

## Spolehlivý spouštěč (cron-job.org)

GitHubův vlastní plánovač (`schedule`) je u tohoto účtu **nespolehlivý**: naměřeno 10/2026 — první plánovaný běh sběrače
přišel o 7 hodin později a další den vůbec (i Hlídací pes má jen ~5 plánovaných běhů denně místo 96, proto ho spouští
externí cron, viz hlavní README). Sběrač proto spouští stejná cesta:

1. **Token.** Použij fine-grained token, který už máš pro cron-job.org (hlavní README, „Jednorázové nastavení“): na
   <https://github.com/settings/personal-access-tokens> ho otevři a v *Repository access* přidej
   `RoumiItsMe/trh-bytu-data` (oprávnění *Actions: Read and write* zůstává). Nebo vytvoř nový token jen pro toto repo.
2. **Druhý cronjob na cron-job.org** (nejrychleji *Duplicate* toho stávajícího):
   - **Title:** `Trh bytů — spustit sběrač`
   - **URL:** `https://api.github.com/repos/RoumiItsMe/trh-bytu-data/actions/workflows/scout.yml/dispatches`
   - **Schedule:** jednou denně, např. ve 4:00 (časové pásmo Europe/Prague)
   - **Request method:** `POST`, stejné hlavičky jako u Hlídacího psa (`Authorization: Bearer <token>`,
     `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`, `Content-Type: application/json`)
   - **Request body:** `{"ref":"main"}`
   - *Test run* — do pár vteřin musí v *Actions* soukromého repa přibýt běh typu `workflow_dispatch`.
3. **Záloha.** `schedule` ve workflow zůstává. Když přijde, ale poslední snímek je mladší než 12 hodin, skončí za pár
   vteřin (účtuje se 1 minuta), takže se nesbírá dvakrát denně.

Kdyby spouštěč přestal fungovat (vypršel token, výpadek služby), appka to ohlásí: při přehrávání zapíše do `track.log`
varování a na Přehledu se pod nadpisem objeví „⚠ Cloudový sběrač nejspíš neběží: poslední snímek je starý …“ (po 36 hodinách).

## Jak přehrávání funguje

- Přehrávají se snímky **novější než poslední sběr na PC** (`app_state` klíč `snapshots_applied_until`), od nejstaršího.
  Snímek starší než tvůj poslední sběr by jen opakoval, co už appka ví.
- Použijí se stejná pravidla jako při běžném sběru (`process-source.js`): nová nabídka, změna ceny (včetně „Dohodou →
  cena“), rezervace, prodej, zmizení, návrat do nabídky. Časy událostí jsou čas snímku.
- **Zmizení** se potvrdí druhým snímkem po odstupu (6 h) a datuje se prvním nenalezením, jako při běžném sběru. Na
  stránku inzerátu se při přehrávání nikdo neptá (ukazuje dnešek, ne tehdy). Tohle ověření dělá až běžný sběr na PC.
- **Rezervace Sreality a prodej iDNES** zjišťuje sběrač z detailu každé nabídky (portály je ve výpisu nemají).
- **Nové nabídky z doby bez PC** se založí s detailem, pokud je stránka ještě živá; jinak jen z údajů výpisu (bez popisu
  a fotek).
- Zdroj, který se ve snímku nepodařilo stáhnout, se přeskočí. Výpis, který je najednou prázdný u zdroje s mnoha
  aktivními nabídkami, se bere jako výpadek portálu a taky se přeskočí.
- Telegram zprávy o rezervaci chodí i u přehraných změn (s časovým zpožděním).

## Co to NEdělá

- Nesbírá fotky, nepočítá adresy a nehlídá katastr — to dělá běžný sběr na PC (nic z toho se neztrácí).
- Nesbírá častěji než jednou denně. Chceš-li to změnit, uprav `cron` v `scout.yml`. Při častějším sběru dávej pozor na
  limit minut (4 účtované minuty na běh v soukromém repu).
- Nezapisuje do databáze nic sám — když PC zůstane vypnuté, snímky jen čekají v repu.
