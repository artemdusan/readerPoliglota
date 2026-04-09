/**
 * Annotate chapter HTML with <span data-sid="N"> sentence wrappers and
 * return the extracted sentence fragments for local Web Speech playback.
 */
export function annotateSentencesInHtml(html, lang = 'en') {
  if (!html) return { html, fragments: [] };

  const doc = new DOMParser().parseFromString(html, 'text/html');
  const root = doc.body;
  const textNodes = [];
  const state = { pos: 0, text: '' };

  collectTextNodes(root, textNodes, state);

  const ranges = buildSentenceRanges(state.text, lang);
  if (!ranges.length) return { html: root.innerHTML, fragments: [] };

  for (let ni = textNodes.length - 1; ni >= 0; ni--) {
    const { node, start: nodeStart, end: nodeEnd } = textNodes[ni];
    const overlapping = ranges.filter(range => range.start < nodeEnd && range.end > nodeStart);
    if (!overlapping.length) continue;

    const raw = node.textContent;
    const segments = [];
    let cursor = nodeStart;

    for (const range of overlapping) {
      const segStart = Math.max(range.start, nodeStart);
      const segEnd = Math.min(range.end, nodeEnd);

      if (segStart > cursor) {
        segments.push({ text: raw.slice(cursor - nodeStart, segStart - nodeStart), sid: null });
      }

      segments.push({
        text: raw.slice(segStart - nodeStart, segEnd - nodeStart),
        sid: range.sid,
      });
      cursor = segEnd;
    }

    if (cursor < nodeEnd) {
      segments.push({ text: raw.slice(cursor - nodeStart), sid: null });
    }

    const fragment = doc.createDocumentFragment();
    for (const segment of segments) {
      if (!segment.text) continue;
      if (segment.sid === null) {
        fragment.appendChild(doc.createTextNode(segment.text));
        continue;
      }
      const span = doc.createElement('span');
      span.dataset.sid = String(segment.sid);
      span.textContent = segment.text;
      fragment.appendChild(span);
    }

    node.parentNode.replaceChild(fragment, node);
  }

  return {
    html: root.innerHTML,
    fragments: ranges.map(({ sid, start, end }) => ({
      id: sid,
      type: 'sentence',
      text: state.text.slice(start, end).trim(),
    })),
  };
}

function collectTextNodes(node, result, state) {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent || '';
    if (!text.length) return;
    result.push({ node, start: state.pos, end: state.pos + text.length });
    state.text += text;
    state.pos += text.length;
    return;
  }

  for (const child of [...node.childNodes]) {
    collectTextNodes(child, result, state);
  }
}

function buildSentenceRanges(text, lang) {
  if (!text.trim()) return [];

  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter(lang || 'en', { granularity: 'sentence' });
    const ranges = Array.from(segmenter.segment(text), segment => toTrimmedRange(text, segment.index, segment.index + segment.segment.length))
      .filter(Boolean)
      .map((range, sid) => ({ ...range, sid }));
    if (ranges.length) return ranges;
  }

  const ranges = [];
  const regex = /[\s\S]*?(?:[.!?]+(?=\s|$)|$)/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    if (!match[0]) break;
    const range = toTrimmedRange(text, match.index, match.index + match[0].length);
    if (range) ranges.push({ ...range, sid: ranges.length });
    if (match.index + match[0].length >= text.length) break;
  }
  return ranges;
}

function toTrimmedRange(text, start, end) {
  while (start < end && /\s/.test(text[start])) start++;
  while (end > start && /\s/.test(text[end - 1])) end--;
  return start < end ? { start, end } : null;
}
