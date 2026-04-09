/**
 * Wraps sentences in chapter HTML with <span data-sid="N"> using Polly speech marks.
 * Marks: [{ time, type, start, end, value }, ...] — start/end are char offsets in chapter.text.
 *
 * Approach: walk DOM text nodes, accumulate char offset, split at sentence boundaries.
 * chapter.text ≈ body.textContent (minor whitespace normalization only), so offsets align.
 *
 * skipSelector: optional CSS selector — text nodes inside matching elements are skipped
 * (used in polyglot mode to skip <i class="pw-original"> tooltip text).
 */
export function wrapSentencesInHtml(html, marks, skipSelector = null) {
  if (!marks || marks.length === 0) return html;

  const doc = new DOMParser().parseFromString(html, 'text/html');
  const root = doc.body;

  // 1. Collect all text nodes with their cumulative offsets
  const textNodes = [];
  const state = { pos: 0 };
  collectTextNodes(root, textNodes, state, skipSelector);

  // 2. Build sentence ranges: [{ sid, start, end }]
  //    "end" of sentence i = start of sentence i+1 (or Infinity)
  const sentRanges = marks.map((m, i) => ({
    sid: i,
    start: m.start,
    end: marks[i + 1] ? marks[i + 1].start : state.pos,
  }));

  // 3. Process text nodes in REVERSE to avoid invalidating offsets after splits
  for (let ni = textNodes.length - 1; ni >= 0; ni--) {
    const { node, start: nStart, end: nEnd } = textNodes[ni];

    // Sentence ranges overlapping this text node
    const overlapping = sentRanges.filter(s => s.start < nEnd && s.end > nStart);
    if (overlapping.length === 0) continue;

    // Build segments: [{text, sid|null}]
    const segments = [];
    let cur = nStart;
    const raw = node.textContent;

    for (const s of overlapping) {
      const segStart = Math.max(s.start, nStart);
      const segEnd   = Math.min(s.end, nEnd);

      if (segStart > cur) {
        // Gap before this sentence (belongs to previous or no sentence)
        segments.push({ text: raw.slice(cur - nStart, segStart - nStart), sid: null });
      }
      segments.push({ text: raw.slice(segStart - nStart, segEnd - nStart), sid: s.sid });
      cur = segEnd;
    }
    if (cur < nEnd) {
      segments.push({ text: raw.slice(cur - nStart), sid: null });
    }

    // Replace text node with fragments
    const frag = doc.createDocumentFragment();
    for (const seg of segments) {
      if (!seg.text) continue;
      if (seg.sid !== null) {
        const span = doc.createElement('span');
        span.dataset.sid = String(seg.sid);
        span.textContent = seg.text;
        frag.appendChild(span);
      } else {
        frag.appendChild(doc.createTextNode(seg.text));
      }
    }
    node.parentNode.replaceChild(frag, node);
  }

  return root.innerHTML;
}

function collectTextNodes(node, result, state, skipSelector) {
  if (node.nodeType === Node.TEXT_NODE) {
    const len = node.textContent.length;
    if (len > 0) {
      result.push({ node, start: state.pos, end: state.pos + len });
      state.pos += len;
    }
  } else {
    if (skipSelector && node.nodeType === Node.ELEMENT_NODE && node.matches(skipSelector)) return;
    for (const child of [...node.childNodes]) {
      collectTextNodes(child, result, state, skipSelector);
    }
  }
}
