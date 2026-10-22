// node --test trh-bytu/photos.test.js
// Do galerie iDNES se mezi fotky míchají videa (…/thumbs/video/<id>.mp4). Appka je stahovala jako
// `1.jpg`, prohlížeč je v <img> nezobrazil a byt zůstal bez náhledu (22. 10. 2026: 20 inzerátů).
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as cheerio from "cheerio";
import { imageKind, imageKindOfFile, fetchImageBuffer } from "./photos.js";
import { extractPhotoUrls } from "./detail/idnes.js";

const pad = (head) => Buffer.concat([Buffer.from(head), Buffer.alloc(32)]);
const JPEG = pad([0xff, 0xd8, 0xff, 0xe0]);
const PNG = pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([1, 2, 3, 4]), Buffer.from("WEBPVP8 "), Buffer.alloc(16)]);
const GIF = pad(Buffer.from("GIF89a"));
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from("ftypisom"), Buffer.alloc(32)]); // přesně to, co leželo jako 1.jpg
const AVIF = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from("ftypavif"), Buffer.alloc(32)]);

test("druh obrázku se pozná podle obsahu; video, HTML a prázdný soubor ne", () => {
  assert.equal(imageKind(JPEG), "jpeg");
  assert.equal(imageKind(PNG), "png");
  assert.equal(imageKind(WEBP), "webp");
  assert.equal(imageKind(GIF), "gif");
  assert.equal(imageKind(AVIF), "avif");
  assert.equal(imageKind(MP4), null); // mp4 má také `ftyp`, ale ne brand avif
  assert.equal(imageKind(Buffer.from("<!DOCTYPE html><html><body>Chyba</body></html>")), null);
  assert.equal(imageKind(Buffer.alloc(0)), null);
  assert.equal(imageKind(null), null);
});

test("druh obrázku se čte i ze souboru na disku (přípona .jpg nic neznamená)", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "photos-test-"));
  try {
    writeFileSync(path.join(dir, "ok.jpg"), JPEG);
    writeFileSync(path.join(dir, "video.jpg"), MP4);
    writeFileSync(path.join(dir, "prazdny.jpg"), "");
    assert.equal(imageKindOfFile(path.join(dir, "ok.jpg")), "jpeg");
    assert.equal(imageKindOfFile(path.join(dir, "video.jpg")), null);
    assert.equal(imageKindOfFile(path.join(dir, "prazdny.jpg")), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stažení: obrázek projde; video (podle hlavičky i podle obsahu) a chyba serveru ne", async () => {
  const hits = { video: 0 };
  const server = http.createServer((req, res) => {
    if (req.url === "/foto.jpg") return res.writeHead(200, { "content-type": "image/jpeg" }).end(JPEG);
    if (req.url === "/video.mp4") {
      hits.video++;
      return res.writeHead(200, { "content-type": "video/mp4" }).end(MP4);
    }
    // portál lže v hlavičce, ale obsah je video
    if (req.url === "/lze.jpg") return res.writeHead(200, { "content-type": "image/jpeg" }).end(MP4);
    if (req.url === "/html.jpg") return res.writeHead(200, { "content-type": "text/html" }).end("<html></html>");
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.deepEqual(await fetchImageBuffer(`${base}/foto.jpg`), JPEG);
    await assert.rejects(fetchImageBuffer(`${base}/video.mp4`), /není obrázek \(video\/mp4\)/);
    await assert.rejects(fetchImageBuffer(`${base}/lze.jpg`), /není obrázek/);
    await assert.rejects(fetchImageBuffer(`${base}/html.jpg`), /není obrázek \(text\/html\)/);
    await assert.rejects(fetchImageBuffer(`${base}/neexistuje.jpg`), /HTTP 404/);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

const GALLERY = (links) => `<html><body>
  <div class="b-author"><img src="https://sta-reality2.1gr.cz/sta/compile/thumbs/makler.jpg"></div>
  <div class="b-gallery">${links}</div>
  <div class="grid-similar-offers"><img src="https://sta-reality2.1gr.cz/sta/compile/thumbs/podobny.jpg"></div>
</body></html>`;
const BASE = "https://sta-reality2.1gr.cz/sta/compile/thumbs";

test("iDNES galerie: video na prvním místě se přeskočí, fotky zůstanou v pořadí a bez dotazu", () => {
  const html = GALLERY(`
    <a data-fancybox href="${BASE}/video/6ad7440737fac5daa40bdac5.mp4"><img src="${BASE}/video/x.jpg"></a>
    <a data-fancybox href="${BASE}/full/a1.jpg?gt=r"></a>
    <a data-fancybox href="${BASE}/full/a2.jpg"></a>
    <a data-fancybox href="${BASE}/full/a1.jpg"></a>`);
  assert.deepEqual(extractPhotoUrls(cheerio.load(html)), [`${BASE}/full/a1.jpg`, `${BASE}/full/a2.jpg`]);
});

test("iDNES galerie bez odkazů: miniatury z <img>, videa a cizí obrázky stranou", () => {
  const html = GALLERY(`
    <img src="${BASE}/video/v.jpg"><img src="${BASE}/m/a.jpg"><img data-src="${BASE}/m/b.jpg"><img src="https://jine.cdn/c.jpg">`);
  // `/thumbs/video/` je video i u miniatury (náhled videa není fotka bytu)
  assert.deepEqual(extractPhotoUrls(cheerio.load(html)), [`${BASE}/m/a.jpg`, `${BASE}/m/b.jpg`]);
});
