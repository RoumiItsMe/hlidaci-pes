// Inline editace v tabulce srovnání (`.cell-form`, viz server.js) se
// odesílá přes fetch místo normálního <form> odeslání — normální odeslání
// vždy znamená celou novou navigaci stránky a prohlížeč po ní skočí nahoru,
// což při postupném vyplňování víc polí u jednoho bytu nutilo pořád dokola
// scrollovat zpátky dolů. Server po uložení odpovídá stejně jako dřív
// (302 na tutéž stránku se zachovanými filtry přes Referer hlavičku) — fetch
// tenhle redirect potichu následuje sám a appka jen vymění obsah <main> za
// čerstvě vyrenderovaný (ať se projeví i dopočítané sloupce jako Kč/m²) a
// scroll ručně vrátí tam, kde byl.
//
// Pozor: posluchač čeká na "submit" event. `HTMLFormElement.submit()`
// (na rozdíl od `requestSubmit()`) tenhle event vůbec nevyvolává (WHATWG
// spec) — proto cell-form pole v server.js volají `requestSubmit()`, jinak
// by appka skok nahoru dál neodchytila.
document.addEventListener("submit", async (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement) || !form.matches(".cell-form")) return;
  event.preventDefault();

  const scrollX = window.scrollX;
  const scrollY = window.scrollY;
  // Tabulka srovnání se scrolluje UVNITR vlastního obalu (`.compare-wrap`,
  // omezená výška + sticky hlavička, viz style.css), ne celou stránkou —
  // `window.scrollY` o ní nic neví. Výměna <main> vyrobí nový obal a ten
  // začíná na nule, takže u řádků hluboko v tabulce (a u sloupců vpravo)
  // by to pořád skákalo na začátek; pozici obalu je proto potřeba vrátit
  // zvlášť.
  const wrap = document.querySelector(".compare-wrap");
  const wrapTop = wrap ? wrap.scrollTop : 0;
  const wrapLeft = wrap ? wrap.scrollLeft : 0;
  const controls = form.querySelectorAll("input, select");
  // Tělo požadavku se musí sestavit PŘED deaktivací polí — `disabled`
  // ovládací prvek se do FormData vůbec nezahrne (stejné pravidlo jako při
  // normálním odeslání formuláře), takže opačné pořadí by potichu odeslalo
  // prázdné tělo a server by neměl co uložit.
  //
  // `new FormData(form)` by se fetch() odeslalo jako multipart/form-data —
  // server (parseBody v server.js) ale umí jen urlencoded tělo (stejné,
  // jaké by poslal normální <form> BEZ enctype="multipart/form-data", viz
  // MDN form.submit()). URLSearchParams(FormData) tělo zakóduje stejně jako
  // normální odeslání formuláře, takže se k serveru dostane ve tvaru, který
  // umí přečíst.
  const body = new URLSearchParams(new FormData(form));
  controls.forEach((el) => (el.disabled = true));

  try {
    const res = await fetch(form.action, { method: "POST", body });
    const html = await res.text();
    const next = new DOMParser().parseFromString(html, "text/html");
    const nextMain = next.querySelector("main");
    const currentMain = document.querySelector("main");
    if (nextMain && currentMain) {
      document.title = next.title;
      currentMain.replaceWith(nextMain);
    }
  } catch (err) {
    console.error("Uložení se nezdařilo:", err);
    controls.forEach((el) => (el.disabled = false));
  } finally {
    window.scrollTo(scrollX, scrollY);
    const liveWrap = document.querySelector(".compare-wrap");
    if (liveWrap) {
      liveWrap.scrollTop = wrapTop;
      liveWrap.scrollLeft = wrapLeft;
    }
  }
});
