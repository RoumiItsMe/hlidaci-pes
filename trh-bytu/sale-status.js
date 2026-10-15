// Stav prodeje bytu pro filtry a přehledy (úvodní stránka, tabulka srovnání,
// přehled). Čisté funkce nad "entry" z computeEntries (server.js) — jediné
// místo, které říká, co je "Prodáno" a co "Čeká na ověření".

// Zmizelý byt, který byl před zmizením rezervovaný, a nikdo zatím nezjistil,
// jak to dopadlo: po rezervaci se nabídka typicky stahuje, takže je to
// "možný prodej" (a ne jen "zmizelo"). Když se nabídka vrátí, byt přestane
// být zmizelý a štítek zmizí sám.
export function isPossibleSale(e) {
  return e.status === "removed" && !e.saleVerdict && Boolean(e.triage?.wasReserved);
}

// Cena prodeje je potvrzená: zadaná z katastru (nebo ručně), nebo ji v katastru
// ověřit nejde a portál byt označil jako prodaný (poslední cena platí, viz
// kn-schedule.js, priceAssumed).
export function isPriceConfirmed(e) {
  return e.verifiedSalePrice != null || Boolean(e.track?.priceAssumed);
}

// Filtr "Prodáno" je PŘÍSNÝ: jen prodané byty s potvrzenou cenou. Co teprve
// čeká na ověření (po rezervaci zmizelé; prodané, ale cenu v katastru ještě
// nikdo nepotvrdil), je ve filtru "Čeká na ověření" — jakmile se cena potvrdí,
// byt do "Prodáno" přeskočí sám. Nikam nezapadne: ve filtru "Čeká na ověření"
// zůstává, dokud se nerozhodne (rozvrh kontrol ani skenování ho z něj nevyřadí).
export function isConfirmedSale(e) {
  return e.status === "sold" && isPriceConfirmed(e);
}

export function isPendingSale(e) {
  return (e.status === "sold" && !isPriceConfirmed(e)) || isPossibleSale(e);
}

// Prodané potvrzeně i nepotvrzeně — pro řádky a sloupce s cenou prodeje.
export function isSoldOrAlmost(e) {
  return isConfirmedSale(e) || isPendingSale(e);
}
