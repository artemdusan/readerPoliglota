// Minimal ZIP builder (store method — no compression, no external deps)
// CRC32 lookup table
const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(data) {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC32_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const ENC = new TextEncoder();
function toBytes(s) { return typeof s === 'string' ? ENC.encode(s) : s; }

function buildZip(files) {
  const entries = [];
  const chunks = [];
  let offset = 0;

  for (const { name, data } of files) {
    const nameBytes = ENC.encode(name);
    const dataBytes = toBytes(data);
    const checksum = crc32(dataBytes);
    const localOffset = offset;

    const lh = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true); // local file header signature
    lv.setUint16(4, 20, true);         // version needed
    lv.setUint16(6, 0, true);          // flags
    lv.setUint16(8, 0, true);          // method: stored (no compression)
    lv.setUint16(10, 0, true);         // mod time
    lv.setUint16(12, 0, true);         // mod date
    lv.setUint32(14, checksum, true);  // CRC-32
    lv.setUint32(18, dataBytes.length, true); // compressed size
    lv.setUint32(22, dataBytes.length, true); // uncompressed size
    lv.setUint16(26, nameBytes.length, true); // filename length
    lv.setUint16(28, 0, true);         // extra field length
    lh.set(nameBytes, 30);
    chunks.push(lh, dataBytes);
    offset += lh.length + dataBytes.length;
    entries.push({ nameBytes, dataBytes, checksum, localOffset });
  }

  const cdStart = offset;
  let cdSize = 0;
  for (const e of entries) {
    const cd = new Uint8Array(46 + e.nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true); // central dir signature
    cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
    cv.setUint16(8, 0, true);  cv.setUint16(10, 0, true);
    cv.setUint16(12, 0, true); cv.setUint16(14, 0, true);
    cv.setUint32(16, e.checksum, true);
    cv.setUint32(20, e.dataBytes.length, true);
    cv.setUint32(24, e.dataBytes.length, true);
    cv.setUint16(28, e.nameBytes.length, true);
    cv.setUint16(30, 0, true); cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true); cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, e.localOffset, true);
    cd.set(e.nameBytes, 46);
    chunks.push(cd);
    cdSize += cd.length;
  }

  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true); // end of central dir signature
  ev.setUint16(4, 0, true); ev.setUint16(6, 0, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, cdStart, true);
  ev.setUint16(20, 0, true);
  chunks.push(eocd);

  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) { out.set(c, pos); pos += c.length; }
  return out;
}

// XML escape
function x(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function chFile(i) {
  return `chapter_${String(i + 1).padStart(3, '0')}.xhtml`;
}

function buildContainer() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;
}

function buildOpf(book, chs) {
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  return `<?xml version="1.0" encoding="UTF-8"?>
<package version="3.0" xmlns="http://www.idpf.org/2007/opf" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>${x(book.title)}</dc:title>
    <dc:creator>${x(book.author || '')}</dc:creator>
    <dc:language>${x(book.lang || 'und')}</dc:language>
    <dc:identifier id="uid">${x(book.id)}</dc:identifier>
    <meta property="dcterms:modified">${now}</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="css" href="style.css" media-type="text/css"/>
${chs.map((_, i) => `    <item id="ch${i + 1}" href="${chFile(i)}" media-type="application/xhtml+xml"/>`).join('\n')}
  </manifest>
  <spine toc="ncx">
${chs.map((_, i) => `    <itemref idref="ch${i + 1}"/>`).join('\n')}
  </spine>
</package>`;
}

function buildNcx(book, chs) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ncx version="2005-1" xmlns="http://www.daisy.org/z3986/2005/ncx/">
  <head>
    <meta name="dtb:uid" content="${x(book.id)}"/>
    <meta name="dtb:depth" content="1"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNormalValue" content="0"/>
  </head>
  <docTitle><text>${x(book.title)}</text></docTitle>
  <navMap>
${chs.map((ch, i) => `    <navPoint id="np${i + 1}" playOrder="${i + 1}">
      <navLabel><text>${x(ch.title || `Rozdział ${i + 1}`)}</text></navLabel>
      <content src="${chFile(i)}"/>
    </navPoint>`).join('\n')}
  </navMap>
</ncx>`;
}

function buildNav(book, chs) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><meta charset="utf-8"/><title>${x(book.title)}</title></head>
<body>
  <nav epub:type="toc">
    <ol>
${chs.map((ch, i) => `      <li><a href="${chFile(i)}">${x(ch.title || `Rozdział ${i + 1}`)}</a></li>`).join('\n')}
    </ol>
  </nav>
</body>
</html>`;
}

// Kindle-safe CSS — no flex/grid/vars, basic typography only
function buildCss() {
  return `body { font-family: serif; font-size: 1em; line-height: 1.6; margin: 0.5em 1em; }
p { margin: 0.3em 0; text-indent: 1.2em; }
h1, h2, h3, h4, h5, h6 { margin: 1em 0 0.4em; text-indent: 0; font-weight: bold; }
ruby { display: inline; }
rt { font-size: 0.65em; }`;
}

// Convert a chapter's HTML to an EPUB XHTML page.
// If polyHtml is provided it contains .pw spans with inline translations;
// those are converted to <ruby> elements with <rp> fallback for non-ruby readers.
function chapterToXhtml(html, title, polyHtml) {
  const src = polyHtml ?? html ?? '';
  const doc = new DOMParser().parseFromString(src || '<p> </p>', 'text/html');

  if (polyHtml) {
    // Convert .pw spans → <ruby>original<rp>(</rp><rt>translation</rt><rp>)</rp></ruby>
    doc.body.querySelectorAll('.pw').forEach(pw => {
      const orig = pw.querySelector('.pw-original')?.textContent?.trim() || '';
      const tgt  = pw.querySelector('.pw-target')?.textContent?.trim()  || '';
      if (!orig && !tgt) { pw.replaceWith(doc.createTextNode('')); return; }
      const ruby = doc.createElement('ruby');
      ruby.textContent = orig || tgt;
      if (orig && tgt) {
        const rpO = doc.createElement('rp'); rpO.textContent = '(';
        const rt  = doc.createElement('rt'); rt.textContent  = tgt;
        const rpC = doc.createElement('rp'); rpC.textContent = ')';
        ruby.appendChild(rpO);
        ruby.appendChild(rt);
        ruby.appendChild(rpC);
      }
      pw.replaceWith(ruby);
    });
  }

  // Unwrap sentence-annotation spans added by the reader (not present in stored HTML,
  // but may appear in polyHtml after applySentencePatchPayloadToHtml)
  doc.body.querySelectorAll('.ch-sentence').forEach(s => s.replaceWith(...s.childNodes));

  // Strip classes, data-* attributes, scripts, and styles
  doc.body.querySelectorAll('script, style').forEach(el => el.remove());
  doc.body.querySelectorAll('*').forEach(el => {
    el.removeAttribute('class');
    [...el.attributes]
      .filter(a => a.name.startsWith('data-'))
      .forEach(a => el.removeAttribute(a.name));
  });

  // XMLSerializer produces valid XHTML (self-closing void elements, proper escaping)
  const xs = new XMLSerializer();
  const bodyXml = xs.serializeToString(doc.body);
  // Strip outer <body ...> wrapper; the xmlns will be declared on <html> instead
  const inner = bodyXml.replace(/^<body[^>]*>/, '').replace(/<\/body>\s*$/, '');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="utf-8"/>
  <title>${x(title)}</title>
  <link rel="stylesheet" type="text/css" href="style.css"/>
</head>
<body>
${inner.trim()}
</body>
</html>`;
}

/**
 * Build an EPUB file and return it as a Uint8Array.
 *
 * @param {object} book - {id, title, author, lang}
 * @param {Array<{chapter: object, polyHtml: string|null}>} items
 *   chapter must have {title, html, chapterIndex}
 *   polyHtml is the already-rendered polyglot HTML (from parseStoredPolyglot), or null for original
 * @returns {Uint8Array}
 */
export function buildEpub(book, items) {
  const chs = items.map(it => it.chapter);
  const files = [
    { name: 'mimetype',               data: 'application/epub+zip' },
    { name: 'META-INF/container.xml', data: buildContainer() },
    { name: 'OEBPS/content.opf',      data: buildOpf(book, chs) },
    { name: 'OEBPS/toc.ncx',          data: buildNcx(book, chs) },
    { name: 'OEBPS/nav.xhtml',        data: buildNav(book, chs) },
    { name: 'OEBPS/style.css',        data: buildCss() },
    ...items.map(({ chapter, polyHtml }, i) => ({
      name: `OEBPS/${chFile(i)}`,
      data: chapterToXhtml(chapter.html, chapter.title || `Rozdział ${i + 1}`, polyHtml || null),
    })),
  ];
  return buildZip(files);
}
