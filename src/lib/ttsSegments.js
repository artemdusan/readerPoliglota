const LANG_BCP47 = {
  pl: 'pl-PL',
  es: 'es-ES',
  fr: 'fr-FR',
  de: 'de-DE',
  it: 'it-IT',
  pt: 'pt-PT',
  en: 'en-GB',
};

export function getLangBCP47(code) {
  return LANG_BCP47[code] ?? 'pl-PL';
}

function splitSentences(text) {
  const parts = text.split(/(?<=[.!?…])\s+/);
  return parts.map(s => s.trim()).filter(s => s.length > 1);
}

function sentencesOrFull(text) {
  const s = splitSentences(text);
  return s.length > 0 ? s : (text.trim() ? [text.trim()] : []);
}

/**
 * Mode "mixed": reads Polish text up to a marker, then the Polish equivalent,
 * then the foreign word in the target language.
 * e.g. "to była [madre::matka]" → "to była matka" (pl) → "madre" (es)
 * Returns { segments: [{text, lang}], paraStarts: number[] }
 * paraStarts[i] = first segment index for paragraph i (matches data-para="i" in HTML).
 */
function buildMixedSegments(rawText, targetLang) {
  const segments = [];
  const paraStarts = [];
  const rx = /\[([^\]]+?)::([^\]]+?)\]/g;

  for (const para of rawText.split(/\n\n+/)) {
    if (!para.trim()) continue;
    paraStarts.push(segments.length);
    let last = 0;
    rx.lastIndex = 0;
    let m;
    while ((m = rx.exec(para)) !== null) {
      const before = para.slice(last, m.index);
      const foreignWord = m[1].trim();
      const polishWord  = m[2].trim();

      // Sentence-split the "before" text; merge the Polish equivalent into the last fragment
      const beforeSentences = sentencesOrFull(before);
      if (beforeSentences.length > 0) {
        for (let i = 0; i < beforeSentences.length - 1; i++) {
          segments.push({ text: beforeSentences[i], lang: 'pl-PL' });
        }
        const merged = (beforeSentences[beforeSentences.length - 1] + ' ' + polishWord).trim();
        if (merged) segments.push({ text: merged, lang: 'pl-PL' });
      } else if (polishWord) {
        segments.push({ text: polishWord, lang: 'pl-PL' });
      }

      if (foreignWord) segments.push({ text: foreignWord, lang: targetLang });
      last = m.index + m[0].length;
    }
    const after = para.slice(last).trim();
    if (after) sentencesOrFull(after).forEach(s => segments.push({ text: s, lang: 'pl-PL' }));
  }

  return { segments: segments.filter(s => s.text.length > 0), paraStarts };
}

/**
 * Build TTS segments from raw polyglot text (with [word::original] markers).
 * Always uses mixed mode: Polish text inline with foreign words.
 */
export function buildTTSSegments(rawText, targetLangCode) {
  const targetLang = getLangBCP47(targetLangCode);
  return buildMixedSegments(rawText, targetLang);
}

/**
 * Build TTS segments from plain Polish chapter text (normal reader mode).
 */
export function buildPlainTTSSegments(plainText) {
  const segments = [];
  const paraStarts = [];
  for (const para of plainText.split(/\n\n+/)) {
    const trimmed = para.trim();
    if (!trimmed) continue;
    paraStarts.push(segments.length);
    sentencesOrFull(trimmed).forEach(s => segments.push({ text: s, lang: 'pl-PL' }));
  }
  return { segments: segments.filter(s => s.text.length > 0), paraStarts };
}

/**
 * Build TTS segments from chapter HTML that already has data-para attributes on <p> elements.
 * Segment indices align with data-para values so TTS highlight works.
 */
export function buildTTSFromHtmlParas(html) {
  const div = document.createElement('div');
  div.innerHTML = html;
  const segments = [], paraStarts = [];
  for (const el of div.querySelectorAll('[data-para]')) {
    const text = el.textContent.trim();
    if (!text) continue;
    paraStarts.push(segments.length);
    sentencesOrFull(text).forEach(s => segments.push({ text: s, lang: 'pl-PL' }));
  }
  return { segments: segments.filter(s => s.text.length > 0), paraStarts };
}
