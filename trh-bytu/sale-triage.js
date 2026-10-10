// Odhad, jak pravděpodobně se ZMIZELÝ byt prodal — slouží jen k seřazení
// fronty "Kontrola v katastru" (viz server.js /kontrola), ne jako verdikt.
// Portály po zmizení inzerátu o prodeji nic neřeknou (404, přesměrování,
// nebo jen "nabídka již není aktivní"), jediná jistota je katastr, takže
// tady se jen z vlastní historie appky určí, které byty stojí za kontrolu
// jako první. Čistá logika bez DB/HTTP (stejná filozofie jako group.js).
//
// Skóre je záměrně hrubé a každý bod má čitelný důvod, který se ukáže
// uživateli — appka nic netvrdí jistě, jen říká, proč si to myslí.

const DAY_MS = 24 * 60 * 60 * 1000;

function byTime(a, b) {
  return a.occurred_at < b.occurred_at ? -1 : a.occurred_at > b.occurred_at ? 1 : 0;
}

/**
 * @param members  inzeráty skupiny (řádky `listings`, všechny ve stavu removed)
 * @param events   události všech členů skupiny (`listing_id`, `event_type`,
 *                 `old_price_czk`, `new_price_czk`, `occurred_at`)
 * @returns `{ score, level, reasons }` — level: likely | possible | unclear | unlikely
 */
export function assessSale(members, events) {
  const reasons = [];
  let score = 0;

  const removedTimes = members.filter((m) => m.removed_at).map((m) => new Date(m.removed_at).getTime());
  const lastRemoved = removedTimes.length ? Math.max(...removedTimes) : null;

  // Rezervace těsně před zmizením — nejsilnější signál: kupec byl, byt
  // zmizel. "Těsně před" = poslední rezervační událost je "reserved", ne
  // později zrušená.
  const wasReserved = members.some((m) => {
    const own = events.filter((e) => e.listing_id === m.id && (e.event_type === "reserved" || e.event_type === "unreserved")).sort(byTime);
    return own.length > 0 && own[own.length - 1].event_type === "reserved";
  });
  if (wasReserved) {
    score += 3;
    reasons.push("byl rezervovaný");
  }

  // Zmizel z víc portálů naráz — RK, která byt stahuje, ho stáhne všude;
  // u prodeje zmizí všude také, ale u jednoho portálu to nic neříká.
  const portals = new Set(members.map((m) => m.source));
  if (portals.size >= 2 && removedTimes.length >= 2 && Math.max(...removedTimes) - Math.min(...removedTimes) <= 3 * DAY_MS) {
    score += 1;
    reasons.push(`zmizel z ${portals.size} portálů najednou`);
  }

  // Zlevnění v posledním měsíci před zmizením — prodejce, který ustupuje z
  // ceny, často míří na uzavření obchodu.
  if (lastRemoved != null) {
    const dropped = events.some(
      (e) =>
        e.event_type === "price_change" &&
        e.old_price_czk != null &&
        e.new_price_czk != null &&
        e.new_price_czk < e.old_price_czk &&
        new Date(e.occurred_at).getTime() >= lastRemoved - 30 * DAY_MS &&
        new Date(e.occurred_at).getTime() <= lastRemoved
    );
    if (dropped) {
      score += 1;
      reasons.push("před zmizením zlevnil");
    }
  }

  // Zmizel, vrátil se a znovu zmizel — chování stahovaného/opravovaného
  // inzerátu, ne prodaného bytu.
  if (events.some((e) => e.event_type === "reactivated")) {
    score -= 2;
    reasons.push("po zmizení se už jednou vrátil");
  }

  // Inzerát visel jen pár dní — nejspíš chyba, test nebo oprava inzerátu,
  // ne rychlý prodej.
  if (lastRemoved != null) {
    const firstSeen = Math.min(...members.map((m) => new Date(m.first_seen_at).getTime()));
    const days = Math.round((lastRemoved - firstSeen) / DAY_MS);
    if (days < 4) {
      score -= 1;
      reasons.push(`visel jen ${Math.max(days, 0)} dní`);
    }
  }

  const level = score >= 3 ? "likely" : score >= 1 ? "possible" : score === 0 ? "unclear" : "unlikely";
  return { score, level, reasons };
}

export const SALE_LEVEL_LABELS = {
  likely: "Pravděpodobně prodáno",
  possible: "Možná prodáno",
  unclear: "Nejasné",
  unlikely: "Spíš staženo",
};
