#!/usr/bin/env bash
# Spustí hlídacího psa a commitne jeho stav (data/seen.json) na main. Volá ho watch.yml.
#
# Proč je to samostatný skript: když `git push` selže, protože na main mezitím přibyl JINÝ commit
# (stačí obyčejný push z počítače, a běh trvá i několik minut), nesmí se detekce pustit znovu.
# Telegram zprávy tohoto běhu už odešly, ale zahozený stav o tom neví, takže druhý průchod by je
# poslal podruhé (viděno naostro 22. 10. 2026: dvě změny ceny dvakrát, 4 zprávy místo 2). Místo
# toho se stav z tohoto běhu přenese přes nový stav z main (scripts/merge-seen.js) a pushne se
# znovu. Detekce běží právě jednou.
#
# WATCH_CMD je jen pro testy (scripts/run-and-commit.test.js).

set -e

WATCH_CMD=${WATCH_CMD:-"node index.js"}
STATE=data/seen.json
TMP=${RUNNER_TEMP:-$(mktemp -d)}
BASE="$TMP/seen.base.json"
OURS="$TMP/seen.ours.json"
COMMIT_MSG="chore: aktualizace stavu hlídacího psa [skip ci]"

# Stav, ze kterého běh vychází (základ trojcestného sloučení). Při úplně prvním běhu žádný není.
if [ -f "$STATE" ]; then cp "$STATE" "$BASE"; else echo '{}' > "$BASE"; fi

# `$WATCH_CMD` NESMÍ stát na vlastním řádku — shell běží s `set -e` a ten u prostého příkazu
# ukončí celý skript okamžitě při nenulovém exit kódu, ještě před uložením kódu. Stav (health
# počítadla, "už jsem alertoval") by se tak ztratil přesně tehdy, kdy se vyskytne vážná chyba.
$WATCH_CMD && SCRIPT_EXIT=0 || SCRIPT_EXIT=$?

if git diff --quiet -- "$STATE"; then
  echo "Stav beze změny, není co commitovat."
  exit "$SCRIPT_EXIT"
fi
cp "$STATE" "$OURS"

for i in 1 2 3; do
  git add "$STATE"
  git commit -q -m "$COMMIT_MSG"
  if git push; then
    echo "Push OK (pokus $i)."
    exit "$SCRIPT_EXIT"
  fi
  echo "Push selhal (pokus $i/3) — na main mezitím přibyly jiné commity. Stahuju je a stav z tohoto běhu přes ně přenesu (detekce se znovu NEpouští, notifikace už odešly)."
  git fetch origin main
  git reset --hard origin/main
  node scripts/merge-seen.js "$BASE" "$OURS"
  if git diff --quiet -- "$STATE"; then
    echo "Stav z tohoto běhu už na main je, není co pushovat."
    exit "$SCRIPT_EXIT"
  fi
done
echo "::error::Nepodařilo se commitnout stav ani po 3 pokusech (opakovaný souběh s jiným během)."
exit 1
