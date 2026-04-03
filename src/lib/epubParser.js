// epub-parser — converted from vanilla inline script to ES module

async function readZip(source) {
  let buffer;
  if (source instanceof ArrayBuffer)             buffer = source;
  else if (source instanceof Uint8Array)         buffer = source.buffer;
  else if (typeof source.arrayBuffer === 'function') buffer = await source.arrayBuffer();
  else throw new TypeError('EpubParser: nieobsługiwany typ źródła.');

  const view = new DataView(buffer), bytes = new Uint8Array(buffer);
  const maxScan = Math.min(bytes.length, 65558);
  let eocdOff = -1;
  for (let i = bytes.length - 22; i >= bytes.length - maxScan; i--)
    if (view.getUint32(i, true) === 0x06054b50) { eocdOff = i; break; }
  if (eocdOff < 0) throw new Error('Nieprawidłowy plik ZIP/EPUB – brak rekordu EOCD.');

  const entriesTotal = view.getUint16(eocdOff + 8, true);
  const cdOffset    = view.getUint32(eocdOff + 16, true);
  const entries = {};
  let pos = cdOffset;

  for (let n = 0; n < entriesTotal; n++) {
    if (view.getUint32(pos, true) !== 0x02014b50) break;
    const method    = view.getUint16(pos + 10, true);
    const compSize  = view.getUint32(pos + 20, true);
    const uncompSize = view.getUint32(pos + 24, true);
    const nameLen   = view.getUint16(pos + 28, true);
    const extraLen  = view.getUint16(pos + 30, true);
    const commentLen = view.getUint16(pos + 32, true);
    const localOff  = view.getUint32(pos + 42, true);
    const name = new TextDecoder('utf-8').decode(bytes.subarray(pos + 46, pos + 46 + nameLen));
    entries[name] = { name, method, compSize, uncompSize, localOff };
    pos += 46 + nameLen + extraLen + commentLen;
  }

  for (const e of Object.values(entries)) {
    const lnLen = view.getUint16(e.localOff + 26, true);
    const leLen = view.getUint16(e.localOff + 28, true);
    const start = e.localOff + 30 + lnLen + leLen;
    const raw   = bytes.slice(start, start + e.compSize);
    if (e.method === 0)      e.getData = () => Promise.resolve(raw);
    else if (e.method === 8) e.getData = () => inflateRaw(raw);
    else e.getData = () => Promise.reject(new Error(`Nieobsługiwana metoda kompresji ${e.method}.`));
  }
  return entries;
}

async function inflateRaw(compressed) {
  const ds = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  writer.write(compressed);
  writer.close();
  const chunks = [], reader = ds.readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

function zipEntry(zip, path) {
  return zip[path] || zip[path.replace(/^\/+/, '')] || null;
}
async function readText(zip, path) {
  const e = zipEntry(zip, path);
  if (!e) return null;
  return new TextDecoder('utf-8').decode(await e.getData());
}
async function readBytes(zip, path) {
  const e = zipEntry(zip, path);
  if (!e) return null;
  return e.getData();
}

function resolvePath(dir, rel) {
  if (!rel) return '';
  if (/^[a-z][a-z\d+\-.]*:/i.test(rel)) return rel;
  if (rel.startsWith('/')) return rel.slice(1);
  const parts = (dir + rel).split('/'), out = [];
  for (const p of parts) {
    if (p === '..') out.pop();
    else if (p && p !== '.') out.push(p);
  }
  return out.join('/');
}

function byLocalName(root, n) { return [...root.getElementsByTagNameNS('*', n)]; }
function firstByLocalName(root, n) { return byLocalName(root, n)[0] ?? null; }

function getOpfPath(containerXml) {
  const doc = new DOMParser().parseFromString(containerXml, 'application/xml');
  const rf = doc.querySelector('rootfile') || firstByLocalName(doc, 'rootfile');
  if (!rf) throw new Error('Brak <rootfile> w META-INF/container.xml.');
  return rf.getAttribute('full-path');
}
function dcMeta(opfDoc, name) {
  const el = opfDoc.getElementsByTagNameNS('http://purl.org/dc/elements/1.1/', name)[0];
  return el ? el.textContent.trim() : '';
}
function buildManifest(opfDoc, opfDir) {
  const map = new Map(), base = opfDir ? opfDir + '/' : '';
  for (const item of byLocalName(opfDoc, 'item')) {
    const id         = item.getAttribute('id') || '';
    const rel        = item.getAttribute('href') || '';
    const mediaType  = item.getAttribute('media-type') || '';
    const properties = item.getAttribute('properties') || '';
    if (!id) continue;
    map.set(id, { id, href: resolvePath(base, decodeURIComponent(rel)), mediaType, properties });
  }
  return map;
}
function buildSpine(opfDoc) {
  return byLocalName(opfDoc, 'itemref').map(r => r.getAttribute('idref')).filter(Boolean);
}

async function extractCover(zip, opfDoc, manifest) {
  let item = null;
  for (const m of manifest.values())
    if (m.properties.split(/\s+/).includes('cover-image')) { item = m; break; }
  if (!item) {
    const meta = byLocalName(opfDoc, 'meta').find(
      m => (m.getAttribute('name') || '').toLowerCase() === 'cover'
    );
    if (meta) item = manifest.get(meta.getAttribute('content') || '') ?? null;
  }
  if (!item) {
    for (const m of manifest.values())
      if (/cover/i.test(m.id + ' ' + m.href) && /^image\//i.test(m.mediaType)) { item = m; break; }
  }
  if (!item) return null;
  const data = await readBytes(zip, item.href);
  if (!data) return null;
  const CHUNK = 8192; let bin = '';
  for (let i = 0; i < data.length; i += CHUNK) bin += String.fromCharCode(...data.subarray(i, i + CHUNK));
  return `data:${item.mediaType};base64,${btoa(bin)}`;
}

async function extractToc(zip, opfDoc, manifest) {
  for (const item of manifest.values()) {
    if (item.properties.split(/\s+/).includes('nav')) {
      const html = await readText(zip, item.href);
      if (html) return parseTocNav(html, item.href);
    }
  }
  const ncxItem = [...manifest.values()].find(i => i.mediaType === 'application/x-dtbncx+xml');
  if (ncxItem) {
    const xml = await readText(zip, ncxItem.href);
    if (xml) return parseTocNcx(xml, ncxItem.href);
  }
  for (const key of Object.keys(zip)) {
    if (/toc\.ncx$/i.test(key)) {
      const xml = await readText(zip, key);
      if (xml) return parseTocNcx(xml, key);
    }
  }
  return [];
}

function parseTocNav(html, navHref) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const navDir = navHref.includes('/') ? navHref.slice(0, navHref.lastIndexOf('/') + 1) : '';
  let navEl = [...doc.querySelectorAll('nav')].find(n => {
    const t = (
      n.getAttribute('epub:type') ||
      n.getAttributeNS('http://www.idpf.org/2007/ops', 'type') ||
      n.getAttribute('type') || ''
    ).trim();
    return t === 'toc' || t.includes('toc');
  });
  if (!navEl) navEl = doc.querySelector('nav[id="toc"],nav.toc,nav');
  if (!navEl) return [];
  const ol = navEl.querySelector('ol');
  return ol ? parseNavOl(ol, navDir) : [];
}
function parseNavOl(ol, baseDir) {
  return [...ol.children].filter(li => li.tagName === 'LI').map(li => {
    const a = li.querySelector('a'), span = li.querySelector('span');
    const label = (a || span)?.textContent.trim() ?? '';
    const rawHref = a?.getAttribute('href') ?? '';
    const href = rawHref ? resolvePath(baseDir, rawHref.split('#')[0]) : '';
    const childOl = li.querySelector(':scope > ol') || li.querySelector('ol');
    return { title: label, href, children: childOl ? parseNavOl(childOl, baseDir) : [] };
  });
}
function parseTocNcx(xml, ncxHref) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const navMap = firstByLocalName(doc, 'navMap');
  if (!navMap) return [];
  const baseDir = ncxHref.includes('/') ? ncxHref.slice(0, ncxHref.lastIndexOf('/') + 1) : '';
  return parseNavPoints(navMap, baseDir);
}
function parseNavPoints(parent, baseDir) {
  return [...parent.children].filter(n => n.localName === 'navPoint').map(pt => {
    const labelEl = firstByLocalName(pt, 'navLabel');
    const textEl  = labelEl ? firstByLocalName(labelEl, 'text') : null;
    const title   = textEl ? textEl.textContent.trim() : '';
    const contentEl = firstByLocalName(pt, 'content');
    const src = contentEl ? (contentEl.getAttribute('src') ?? '') : '';
    const href = src ? resolvePath(baseDir, src.split('#')[0]) : '';
    return { title, href, children: parseNavPoints(pt, baseDir) };
  });
}

async function extractChapters(zip, spine, manifest, toc) {
  const titleByHref = new Map();
  (function idx(items) {
    for (const i of items) {
      if (i.href && !titleByHref.has(i.href)) titleByHref.set(i.href, i.title);
      idx(i.children);
    }
  })(toc);

  const seen = new Set(), chapters = [];
  for (const id of spine) {
    const item = manifest.get(id);
    if (!item || !/xhtml|html/i.test(item.mediaType)) continue;
    const key = item.href.split('#')[0];
    if (seen.has(key)) continue;
    seen.add(key);
    const rawHtml = await readText(zip, item.href);
    if (rawHtml == null) continue;
    const chapterDir = item.href.includes('/') ? item.href.slice(0, item.href.lastIndexOf('/')) : '';
    const { title, text, html } = await parseChapterHtml(rawHtml, titleByHref.get(key) ?? '', zip, chapterDir);
    chapters.push({ id, href: item.href, title, text, html });
  }
  return chapters;
}

const IMG_MIMES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp' };

/**
 * Inline image references in raw HTML *before* DOM parsing so the browser
 * never gets a chance to resolve relative paths to localhost.
 * Handles both <img src="..."> and <image xlink:href="..."> (SVG in EPUBs).
 */
async function inlineImageSrcs(rawHtml, zip, chapterDir) {
  const IMG_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'svg', 'webp']);
  // Match xlink:href="..." and src="..." with relative values
  const rx = /\b(xlink:href|src)="([^"]+)"/g;

  // Collect unique relative image paths
  const toLoad = new Map(); // originalSrc → { path, mime }
  let m;
  while ((m = rx.exec(rawHtml)) !== null) {
    const src = m[2];
    if (src.startsWith('data:') || src.startsWith('#') || /^https?:\/\//.test(src)) continue;
    const ext = src.split('.').pop().toLowerCase().split('?')[0];
    if (!IMG_EXTS.has(ext)) continue;
    if (toLoad.has(src)) continue;
    const path = resolvePath(chapterDir ? chapterDir + '/' : '', src);
    toLoad.set(src, { path, mime: IMG_MIMES[ext] || 'image/jpeg' });
  }

  if (toLoad.size === 0) return rawHtml;

  // Load all images in parallel
  const inlined = new Map(); // originalSrc → data URL
  await Promise.all([...toLoad.entries()].map(async ([src, { path, mime }]) => {
    const data = await readBytes(zip, path);
    if (!data) return;
    const CHUNK = 8192; let bin = '';
    for (let i = 0; i < data.length; i += CHUNK) bin += String.fromCharCode(...data.subarray(i, i + CHUNK));
    inlined.set(src, `data:${mime};base64,${btoa(bin)}`);
  }));

  if (inlined.size === 0) return rawHtml;

  // Replace in raw string — before DOMParser ever sees the relative paths
  return rawHtml.replace(/\b(xlink:href|src)="([^"]+)"/g, (match, attr, src) => {
    const dataUrl = inlined.get(src);
    return dataUrl ? `${attr}="${dataUrl}"` : match;
  });
}

async function parseChapterHtml(rawHtml, tocTitle, zip, chapterDir) {
  const htmlWithImages = await inlineImageSrcs(rawHtml, zip, chapterDir);
  const doc  = new DOMParser().parseFromString(htmlWithImages, 'text/html');
  const body = doc.body;
  for (const el of body.querySelectorAll('script,style,link,meta')) el.remove();
  const headingEl = body.querySelector('h1,h2,h3,h4');
  const title = headingEl?.textContent.trim() || tocTitle;
  const html  = body.innerHTML.trim();
  const text  = (body.textContent ?? '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return { title, html, text };
}

export const EpubParser = {
  async parse(source) {
    const zip = await readZip(source);
    const containerXml = await readText(zip, 'META-INF/container.xml');
    if (!containerXml) throw new Error('Brak META-INF/container.xml — to nie jest prawidłowy EPUB.');
    const opfPath = getOpfPath(containerXml);
    if (!opfPath) throw new Error('Nie można ustalić ścieżki OPF z container.xml.');
    const opfXml = await readText(zip, opfPath);
    if (!opfXml) throw new Error(`Nie można odczytać pliku OPF: "${opfPath}".`);
    const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')) : '';
    const opfDoc = new DOMParser().parseFromString(opfXml, 'application/xml');
    const title  = dcMeta(opfDoc, 'title');
    const author = dcMeta(opfDoc, 'creator');
    const manifest = buildManifest(opfDoc, opfDir);
    const spine    = buildSpine(opfDoc);
    const [cover, toc] = await Promise.all([
      extractCover(zip, opfDoc, manifest),
      extractToc(zip, opfDoc, manifest),
    ]);
    const chapters = await extractChapters(zip, spine, manifest, toc);
    return { title, author, cover, toc, chapters };
  },
};
