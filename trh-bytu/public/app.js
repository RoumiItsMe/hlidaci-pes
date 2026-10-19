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
  if (!(form instanceof HTMLFormElement) || !form.matches(".cell-form, .ajax-form")) return;
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
  const controls = form.querySelectorAll("input, select, button");
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
  // `event.submitter` = tlačítko, kterým se odeslalo — bez něj by se do těla
  // nedostala jeho dvojice name/value a formuláře s víc tlačítky (fronta
  // "Kontrola v katastru": Prodáno / Neprodáno / Zatím nic) by neposlaly,
  // které z nich uživatel stiskl.
  const body = new URLSearchParams(new FormData(form, event.submitter));
  controls.forEach((el) => (el.disabled = true));

  try {
    // `getAttribute`, ne `form.action`: ovládací prvek jménem "action"
    // (tlačítka ve frontě /kontrola) by vlastnost `form.action` přebil a
    // `fetch` by dostal prvek místo adresy.
    const res = await fetch(form.getAttribute("action"), { method: "POST", body });
    const html = await res.text();
    const next = new DOMParser().parseFromString(html, "text/html");
    const nextMain = next.querySelector("main");
    const currentMain = document.querySelector("main");
    if (nextMain && currentMain) {
      document.title = next.title;
      // Rozbalené <details data-keep-open="…"> (seznam úkolů na přehledu) zůstanou
      // rozbalené i po výměně obsahu — jinak by se po každém vyřízeném bytu
      // sbalily a hromadné vyřizování by se muselo pokaždé rozklikávat znovu.
      const open = [...currentMain.querySelectorAll("details[data-keep-open][open]")].map((d) => d.dataset.keepOpen);
      for (const id of open) nextMain.querySelector(`details[data-keep-open="${CSS.escape(id)}"]`)?.setAttribute("open", "");
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

// Napovídání přesné adresy (pole s `data-address-suggest`, detail bytu): po napsání
// začátku ulice nabídne čísla popisná, po výběru vyplní celou adresu (viz
// address-suggest.js, GET /api/adresy). Poslouchá se na `document`, protože ajax
// formuláře po uložení vyměňují celý <main>.
(() => {
  let box = null; // <ul class="suggest-list"> — jediná nabídka, vždy u pole, do kterého se píše
  let field = null;
  let items = [];
  let active = -1;
  let timer = null;
  let controller = null;
  let seq = 0;

  function close() {
    clearTimeout(timer);
    controller?.abort();
    seq++;
    box?.remove();
    box = null;
    field = null;
    items = [];
    active = -1;
  }

  function place() {
    if (!box || !field || !field.isConnected) return;
    const r = field.getBoundingClientRect();
    box.style.left = `${r.left + window.scrollX}px`;
    box.style.top = `${r.bottom + window.scrollY + 2}px`;
    box.style.width = `${r.width}px`;
  }

  function highlight(i) {
    active = i;
    box?.querySelectorAll("li[data-i]").forEach((li) => li.setAttribute("aria-selected", String(Number(li.dataset.i) === i)));
    box?.querySelector(`li[data-i="${i}"]`)?.scrollIntoView({ block: "nearest" });
  }

  function render(list, more) {
    if (!field) return;
    items = list;
    active = -1;
    if (!list.length) {
      box?.remove();
      box = null;
      return;
    }
    if (!box) {
      box = document.createElement("ul");
      box.className = "suggest-list";
      box.setAttribute("role", "listbox");
      document.body.appendChild(box);
    }
    box.replaceChildren();
    list.forEach((item, i) => {
      const li = document.createElement("li");
      li.dataset.i = String(i);
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", "false");
      const label = document.createElement("span");
      label.className = "suggest-label";
      label.textContent = item.label;
      const detail = document.createElement("span");
      detail.className = "suggest-detail";
      detail.textContent = item.detail;
      li.append(label, detail);
      box.appendChild(li);
    });
    if (more > 0) {
      const li = document.createElement("li");
      li.className = "suggest-more";
      li.textContent = `a dalších ${more} — pokračuj v psaní`;
      box.appendChild(li);
    }
    place();
  }

  async function load(el) {
    controller?.abort();
    const text = el.value;
    if (text.trim().length < 2) return close();
    const mine = ++seq;
    controller = new AbortController();
    try {
      const res = await fetch(`/api/adresy?q=${encodeURIComponent(text)}`, { signal: controller.signal });
      const data = await res.json();
      if (mine !== seq || el !== field) return; // mezitím se psalo dál, nebo se pole opustilo
      render(data.items ?? [], data.more ?? 0);
    } catch (err) {
      if (err.name !== "AbortError") close();
    }
  }

  function choose(i) {
    const item = items[i];
    if (!item || !field) return;
    const el = field;
    el.value = item.value;
    el.setSelectionRange(el.value.length, el.value.length);
    if (item.kind === "name") load(el); // název ulice → rovnou její čísla
    else close();
  }

  document.addEventListener("input", (event) => {
    const el = event.target;
    if (!(el instanceof HTMLInputElement) || !el.matches("[data-address-suggest]")) return;
    field = el;
    clearTimeout(timer);
    timer = setTimeout(() => load(el), 180);
  });

  document.addEventListener("keydown", (event) => {
    if (!box || event.target !== field) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      highlight((active + step + items.length) % items.length);
    } else if (event.key === "Enter" && active >= 0) {
      event.preventDefault(); // vybrat nabídku, ne odeslat formulář
      choose(active);
    } else if (event.key === "Escape") {
      close();
    }
  });

  // mousedown, ne click: pole tak neztratí fokus dřív, než se výběr provede.
  document.addEventListener("mousedown", (event) => {
    const li = event.target instanceof Element ? event.target.closest(".suggest-list li[data-i]") : null;
    if (li) {
      event.preventDefault();
      choose(Number(li.dataset.i));
    }
  });
  document.addEventListener("focusout", (event) => {
    if (event.target === field) close();
  });
  document.addEventListener("submit", close, true);
  window.addEventListener("resize", place);
})();
