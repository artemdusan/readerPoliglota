const BLOCK_SELECTOR = 'p, li, blockquote, td, dd';

function collapseWhitespace(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function toTrimmedRange(text, start, end) {
  while (start < end && /\s/.test(text[start])) start++;
  while (end > start && /\s/.test(text[end - 1])) end--;
  return start < end ? { start, end } : null;
}

function buildSentenceRanges(text, lang = 'en') {
  if (!text.trim()) return [];

  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter(lang || 'en', { granularity: 'sentence' });
    const ranges = Array.from(segmenter.segment(text), segment =>
      toTrimmedRange(text, segment.index, segment.index + segment.segment.length)
    )
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

function getOverrideValue(overrides, wordId) {
  if (!overrides) return null;
  if (overrides instanceof Map) return overrides.get(wordId) ?? null;
  return overrides[wordId] ?? null;
}

function processMarkers(text, counter, overrides = null) {
  const rx = /\[([^\]]+?)::([^\]]+?)\]/g;
  let html = '';
  let last = 0;
  let match;

  while ((match = rx.exec(text)) !== null) {
    html += escapeHtml(text.slice(last, match.index));
    const wordId = counter.value;
    const overrideTarget = collapseWhitespace(getOverrideValue(overrides, wordId) ?? '');
    const baseTarget = collapseWhitespace(match[1]);
    const target = escapeHtml(overrideTarget || baseTarget);
    const original = escapeHtml(collapseWhitespace(match[2]));
    html += `<span class="pw" data-word-idx="${wordId}"><b class="pw-target">${target}</b><i class="pw-original">${original}</i></span>`;
    last = match.index + match[0].length;
    counter.value += 1;
  }

  html += escapeHtml(text.slice(last));
  return html;
}

function stripMarkers(text) {
  return String(text ?? '').replace(/\[([^\]]+?)::([^\]]+?)\]/g, (_, target) => target);
}

function getReadableBlocks(root) {
  return [...root.querySelectorAll(BLOCK_SELECTOR)].filter(node => collapseWhitespace(node.textContent).length > 0);
}

function cleanupEmptyStyleAttribute(node) {
  if (!node?.getAttribute) return;
  if ((node.getAttribute('style') || '').trim()) return;
  node.removeAttribute('style');
}

function normalizeTranslatedLayout(root) {
  if (!root?.querySelectorAll) return;

  const elements = [root, ...root.querySelectorAll('*')];
  elements.forEach((node) => {
    if (!node?.getAttribute) return;

    const align = (node.getAttribute('align') || '').trim().toLowerCase();
    if (align === 'justify') node.removeAttribute('align');

    if (!node.style) return;

    const textAlign = node.style.getPropertyValue('text-align').trim().toLowerCase();
    const textAlignLast = node.style.getPropertyValue('text-align-last').trim().toLowerCase();

    if (textAlign === 'justify') {
      node.style.removeProperty('text-align');
      node.style.removeProperty('text-justify');
    }

    if (textAlignLast === 'justify') {
      node.style.removeProperty('text-align-last');
    }

    cleanupEmptyStyleAttribute(node);
  });
}

export function buildSentencePatchSource(html, lang = 'en') {
  if (!html) return { blocks: [], sentences: [] };

  const doc = new DOMParser().parseFromString(html, 'text/html');
  const blocks = [];
  const sentences = [];
  let sentenceIdx = 0;

  getReadableBlocks(doc.body).forEach((node, blockIdx) => {
    const text = collapseWhitespace(node.textContent || '');
    const ranges = buildSentenceRanges(text, lang);
    if (!ranges.length) return;

    const blockId = `b${blockIdx}`;
    const block = {
      id: blockId,
      text,
      sentences: [],
    };

    for (const range of ranges) {
      const id = `s${sentenceIdx++}`;
      const sentenceText = text.slice(range.start, range.end);
      const sentence = {
        id,
        blockId,
        text: sentenceText,
        start: range.start,
        end: range.end,
      };
      block.sentences.push(sentence);
      sentences.push({ id, blockId, text: sentenceText });
    }

    blocks.push(block);
  });

  return { blocks, sentences };
}

export function applySentencePatchPayloadToHtml(html, payload, lang = 'en', overrides = null) {
  if (!html) return { html: '', textForAudio: '', count: 0 };

  const doc = new DOMParser().parseFromString(html, 'text/html');
  normalizeTranslatedLayout(doc.body);
  const changeMap = new Map(
    (payload?.changes ?? [])
      .filter(change => change && typeof change.id === 'string' && typeof change.text === 'string')
      .map(change => [change.id.trim(), collapseWhitespace(change.text)])
  );
  const counter = { value: 0 };
  const audioParagraphs = [];
  let sentenceIdx = 0;

  getReadableBlocks(doc.body).forEach(node => {
    const originalText = collapseWhitespace(node.textContent || '');
    const ranges = buildSentenceRanges(originalText, lang);
    if (!ranges.length) return;

    let rebuiltText = '';
    let rebuiltHtml = '';
    let cursor = 0;

    for (const range of ranges) {
      const sentenceId = `s${sentenceIdx++}`;
      const originalSentence = originalText.slice(range.start, range.end);
      const sentenceText = changeMap.get(sentenceId) || originalSentence;
      const between = originalText.slice(cursor, range.start);
      rebuiltText += between + sentenceText;
      rebuiltHtml += escapeHtml(between) + processMarkers(sentenceText, counter, overrides);
      cursor = range.end;
    }

    const tail = originalText.slice(cursor);
    rebuiltText += tail;
    rebuiltHtml += escapeHtml(tail);

    node.innerHTML = rebuiltHtml;
    const speechText = collapseWhitespace(stripMarkers(rebuiltText));
    if (speechText) audioParagraphs.push(speechText);
  });

  return {
    html: doc.body.innerHTML,
    textForAudio: audioParagraphs.join('\n\n'),
    count: counter.value,
  };
}

export function stripPolyglotMarkers(text, overrides = null) {
  let wordId = 0;
  const plain = String(text ?? '').replace(/\[([^\]]+?)::([^\]]+?)\]/g, (_, target) => {
    const overrideTarget = collapseWhitespace(getOverrideValue(overrides, wordId) ?? '');
    wordId += 1;
    return overrideTarget || target;
  });
  return collapseWhitespace(plain);
}
