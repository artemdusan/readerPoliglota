function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Convert LLM output with [word::original] markers into interactive HTML.
 * Returns { html, count } where count is the number of polyglot words.
 */
export function parsePolyglotHtml(raw) {
  let count = 0;

  function processLine(line) {
    const rx = /\[([^\]]+?)::([^\]]+?)\]/g;
    let html = '', last = 0, m;
    while ((m = rx.exec(line)) !== null) {
      html += escapeHtml(line.slice(last, m.index));
      const target   = escapeHtml(m[1].trim());
      const original = escapeHtml(m[2].trim());
      html += `<span class="pw" title="${original}"><b class="pw-target">${target}</b><i class="pw-original">${original}</i></span>`;
      last = m.index + m[0].length;
      count++;
    }
    return html + escapeHtml(line.slice(last));
  }

  const paragraphs = raw.split(/\n\n+/).filter(p => p.trim());
  const html = paragraphs
    .map((para, pi) => {
      const lines = para.split('\n').map(processLine);
      return `<p data-para="${pi}">${lines.join('<br>')}</p>`;
    })
    .join('\n');

  return { html, count };
}
