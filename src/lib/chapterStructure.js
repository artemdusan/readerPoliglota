export const READABLE_BLOCK_SELECTOR =
  "p, li, blockquote, h1, h2, h3, h4, h5, h6, td, dd";

export function collapseWhitespace(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

export function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function toTrimmedRange(text, start, end) {
  while (start < end && /\s/.test(text[start])) start += 1;
  while (end > start && /\s/.test(text[end - 1])) end -= 1;
  return start < end ? { start, end } : null;
}

export function buildSentenceRanges(text, lang = "en") {
  if (!String(text ?? "").trim()) return [];

  if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
    const segmenter = new Intl.Segmenter(lang || "en", {
      granularity: "sentence",
    });
    const ranges = Array.from(
      segmenter.segment(String(text)),
      (segment) =>
        toTrimmedRange(
          String(text),
          segment.index,
          segment.index + segment.segment.length,
        ),
    )
      .filter(Boolean)
      .map((range, sid) => ({ ...range, sid }));
    if (ranges.length) return ranges;
  }

  const ranges = [];
  const regex = /[\s\S]*?(?:[.!?]+(?=\s|$)|$)/g;
  let match;
  while ((match = regex.exec(String(text))) !== null) {
    if (!match[0]) break;
    const range = toTrimmedRange(
      String(text),
      match.index,
      match.index + match[0].length,
    );
    if (range) ranges.push({ ...range, sid: ranges.length });
    if (match.index + match[0].length >= String(text).length) break;
  }
  return ranges;
}

function normalizeGapText(text) {
  if (!text) return "";
  return /^\s+$/.test(text) ? " " : collapseWhitespace(text);
}

function getReadableBlocks(root) {
  return [...root.querySelectorAll(READABLE_BLOCK_SELECTOR)].filter(
    (node) => collapseWhitespace(node.textContent).length > 0,
  );
}

function buildBlockRecord(node, blockIndex, sentenceCounter, lang = "en") {
  const rawText = String(node?.textContent ?? "");
  const ranges = buildSentenceRanges(rawText, lang);
  if (!ranges.length) return null;

  const blockId = `b${blockIndex}`;
  const sentences = [];
  let cursor = 0;

  ranges.forEach((range, sentenceIndex) => {
    const id = `s${sentenceCounter.value++}`;
    const leadingRaw = rawText.slice(cursor, range.start);
    const rawSentence = rawText.slice(range.start, range.end);
    sentences.push({
      id,
      blockId,
      blockIndex,
      sentenceIndex,
      start: range.start,
      end: range.end,
      leading: normalizeGapText(leadingRaw),
      rawText: rawSentence,
      text: collapseWhitespace(rawSentence),
    });
    cursor = range.end;
  });

  return {
    id: blockId,
    blockIndex,
    rawText,
    text: collapseWhitespace(rawText),
    tail: normalizeGapText(rawText.slice(cursor)),
    sentences,
  };
}

export function buildChapterStructure(html, lang = "en") {
  if (!html) return { blocks: [], sentences: [] };
  const doc = new DOMParser().parseFromString(html, "text/html");
  return buildChapterStructureFromRoot(doc.body, lang);
}

export function buildChapterStructureFromRoot(root, lang = "en") {
  if (!root) return { blocks: [], sentences: [] };

  const blocks = [];
  const sentences = [];
  const sentenceCounter = { value: 0 };

  getReadableBlocks(root).forEach((node, blockIndex) => {
    const block = buildBlockRecord(node, blockIndex, sentenceCounter, lang);
    if (!block) return;
    blocks.push(block);
    sentences.push(
      ...block.sentences.map((sentence) => ({
        id: sentence.id,
        blockId: sentence.blockId,
        text: sentence.text,
      })),
    );
  });

  return { blocks, sentences };
}

function appendAnnotatedText(parent, text, state, sentences, blockId, doc) {
  const source = String(text ?? "");
  if (!source) return;

  const nodeStart = state.pos;
  const nodeEnd = nodeStart + source.length;
  const overlaps = sentences.filter(
    (sentence) => sentence.start < nodeEnd && sentence.end > nodeStart,
  );

  if (!overlaps.length) {
    parent.appendChild(doc.createTextNode(source));
    state.pos = nodeEnd;
    return;
  }

  let cursor = nodeStart;

  overlaps.forEach((sentence) => {
    const segmentStart = Math.max(sentence.start, nodeStart);
    const segmentEnd = Math.min(sentence.end, nodeEnd);

    if (segmentStart > cursor) {
      parent.appendChild(
        doc.createTextNode(source.slice(cursor - nodeStart, segmentStart - nodeStart)),
      );
    }

    const textSlice = source.slice(
      segmentStart - nodeStart,
      segmentEnd - nodeStart,
    );
    if (textSlice) {
      const span = doc.createElement("span");
      span.className = "ch-sentence";
      span.dataset.sentenceId = sentence.id;
      span.dataset.blockId = blockId;
      span.textContent = textSlice;
      parent.appendChild(span);
    }

    cursor = segmentEnd;
  });

  if (cursor < nodeEnd) {
    parent.appendChild(doc.createTextNode(source.slice(cursor - nodeStart)));
  }

  state.pos = nodeEnd;
}

function appendAnnotatedNode(parent, node, state, sentences, blockId, doc) {
  if (node.nodeType === Node.TEXT_NODE) {
    appendAnnotatedText(parent, node.textContent || "", state, sentences, blockId, doc);
    return;
  }

  if (node.nodeType === Node.ELEMENT_NODE) {
    const clone = node.cloneNode(false);
    [...node.childNodes].forEach((child) => {
      appendAnnotatedNode(clone, child, state, sentences, blockId, doc);
    });
    parent.appendChild(clone);
    return;
  }

  parent.appendChild(node.cloneNode(true));
}

function annotateReadableBlocks(root, blocks, doc) {
  const nodes = getReadableBlocks(root);

  nodes.forEach((node, index) => {
    const block = blocks[index];
    if (!block) return;

    node.dataset.blockId = block.id;
    node.dataset.pid = String(index);

    const fragment = doc.createDocumentFragment();
    const state = { pos: 0 };
    [...node.childNodes].forEach((child) => {
      appendAnnotatedNode(fragment, child, state, block.sentences, block.id, doc);
    });
    node.replaceChildren(fragment);
  });
}

export function annotateOriginalChapterHtml(html, lang = "en") {
  if (!html) return { html, fragments: [], sentences: [] };

  const doc = new DOMParser().parseFromString(html, "text/html");
  const structure = buildChapterStructureFromRoot(doc.body, lang);
  annotateReadableBlocks(doc.body, structure.blocks, doc);

  return {
    html: doc.body.innerHTML,
    fragments: structure.blocks.map((block, index) => ({
      id: index,
      blockId: block.id,
      type: "paragraph",
      text: block.text,
    })),
    sentences: structure.sentences,
  };
}

function cleanupEmptyStyleAttribute(node) {
  if (!node?.getAttribute) return;
  if ((node.getAttribute("style") || "").trim()) return;
  node.removeAttribute("style");
}

export function normalizeTranslatedLayout(root) {
  if (!root?.querySelectorAll) return;

  const elements = [root, ...root.querySelectorAll("*")];
  elements.forEach((node) => {
    if (!node?.getAttribute) return;

    const align = (node.getAttribute("align") || "").trim().toLowerCase();
    if (align === "justify") node.removeAttribute("align");

    if (!node.style) return;

    const textAlign = node.style.getPropertyValue("text-align").trim().toLowerCase();
    const textAlignLast = node.style
      .getPropertyValue("text-align-last")
      .trim()
      .toLowerCase();

    if (textAlign === "justify") {
      node.style.removeProperty("text-align");
      node.style.removeProperty("text-justify");
    }

    if (textAlignLast === "justify") {
      node.style.removeProperty("text-align-last");
    }

    cleanupEmptyStyleAttribute(node);
  });
}

function getOverrideValue(overrides, wordId) {
  if (!overrides) return null;
  if (overrides instanceof Map) return overrides.get(wordId) ?? null;
  return overrides[wordId] ?? null;
}

function normalizeWordMatchText(text) {
  return String(text ?? "")
    .normalize("NFKC")
    .replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/\u00A0/g, " ")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function extractLexicalWordTokens(text) {
  const source = String(text ?? "");
  const tokens = [];
  const rx = /[\p{L}\p{N}]+(?:['\u2019-][\p{L}\p{N}]+)*/gu;
  let match;

  while ((match = rx.exec(source)) !== null) {
    tokens.push({
      raw: match[0],
      normalized: normalizeWordMatchText(match[0]),
      start: match.index,
      end: match.index + match[0].length,
    });
  }

  return tokens;
}

function normalizeSelectionWord(word) {
  if (!word || typeof word !== "object" || Array.isArray(word)) return null;
  const target =
    typeof word.target === "string" && word.target.trim()
      ? word.target.trim()
      : "";
  const original =
    typeof word.original === "string" && word.original.trim()
      ? word.original.trim()
      : "";
  if (!target || !original) return null;
  return { target, original };
}

function renderSentenceTextWithWordSelections(
  sourceText,
  sentenceWords,
  { blockId, sentenceId, nextWordId, overrides = null },
) {
  const source = String(sourceText ?? "");
  const tokens = extractLexicalWordTokens(source);
  const selections = Array.isArray(sentenceWords)
    ? sentenceWords.map(normalizeSelectionWord).filter(Boolean)
    : [];

  if (!selections.length || !tokens.length) {
    return {
      html: `<span class="ch-sentence" data-sentence-id="${sentenceId}" data-block-id="${blockId}">${escapeHtml(source)}</span>`,
      words: [],
      nextWordId,
    };
  }

  const availableByOriginal = new Map();
  tokens.forEach((token, index) => {
    const indexes = availableByOriginal.get(token.normalized) ?? [];
    indexes.push(index);
    availableByOriginal.set(token.normalized, indexes);
  });

  const matchedSelections = [];
  const usedIndexes = new Set();
  selections.forEach((word) => {
    const originalNormalized = normalizeWordMatchText(word.original);
    const availableIndexes = availableByOriginal.get(originalNormalized) ?? [];
    const tokenIndex = availableIndexes.find((index) => !usedIndexes.has(index));
    if (!Number.isInteger(tokenIndex)) return;
    usedIndexes.add(tokenIndex);
    matchedSelections.push({
      tokenIndex,
      original: tokens[tokenIndex].raw,
      target: word.target,
    });
  });

  if (!matchedSelections.length) {
    return {
      html: `<span class="ch-sentence" data-sentence-id="${sentenceId}" data-block-id="${blockId}">${escapeHtml(source)}</span>`,
      words: [],
      nextWordId,
    };
  }

  matchedSelections.sort((a, b) => a.tokenIndex - b.tokenIndex);

  let html = `<span class="ch-sentence" data-sentence-id="${sentenceId}" data-block-id="${blockId}">`;
  let last = 0;
  let currentWordId = nextWordId;
  const words = [];

  matchedSelections.forEach((selection) => {
    const token = tokens[selection.tokenIndex];
    html += escapeHtml(source.slice(last, token.start));
    const overrideTarget = collapseWhitespace(
      getOverrideValue(overrides, currentWordId) ?? "",
    );
    const target = overrideTarget || collapseWhitespace(selection.target);
    const original = collapseWhitespace(selection.original);
    html += `<span class="pw" data-word-id="${currentWordId}" data-word-idx="${currentWordId}" data-sentence-id="${sentenceId}" data-block-id="${blockId}"><b class="pw-target">${escapeHtml(target)}</b><i class="pw-original">${escapeHtml(original)}</i></span>`;
    words.push({
      id: currentWordId,
      blockId,
      sentenceId,
      target,
      original,
    });
    currentWordId += 1;
    last = token.end;
  });

  html += `${escapeHtml(source.slice(last))}</span>`;
  return {
    html,
    words,
    nextWordId: currentWordId,
  };
}

function buildRenderedParagraphSpeechText(node) {
  const clone = node.cloneNode(true);

  clone.querySelectorAll("br").forEach((lineBreak) => {
    lineBreak.replaceWith(clone.ownerDocument.createTextNode(" "));
  });

  clone.querySelectorAll(".pw").forEach((token) => {
    const original =
      collapseWhitespace(token.querySelector(".pw-original")?.textContent || "") ||
      collapseWhitespace(token.querySelector(".pw-target")?.textContent || "");
    token.replaceWith(clone.ownerDocument.createTextNode(original));
  });

  return collapseWhitespace(clone.textContent || "");
}

export function applySentencePatchPayloadToHtml(
  html,
  payload,
  lang = "en",
  overrides = null,
) {
  if (!html) {
    return { html: "", textForAudio: "", count: 0, paragraphs: [], words: [] };
  }

  const doc = new DOMParser().parseFromString(html, "text/html");
  normalizeTranslatedLayout(doc.body);
  const structure = buildChapterStructureFromRoot(doc.body, lang);
  const nodes = getReadableBlocks(doc.body);
  const payloadVersion = Number(payload?.version);
  if (payloadVersion !== 2) {
    throw new Error("Obslugiwany jest tylko payload sentence-word-select-v2.");
  }
  const changeMap = new Map(
    (payload?.changes ?? [])
      .filter((change) => change && typeof change.id === "string")
      .map((change) => [change.id.trim(), change]),
  );

  const paragraphs = [];
  const words = [];
  let nextWordId = 0;

  nodes.forEach((node, index) => {
    const block = structure.blocks[index];
    if (!block) return;

    node.dataset.blockId = block.id;
    node.dataset.pid = String(index);

    let rebuiltHtml = "";
    block.sentences.forEach((sentence) => {
      if (sentence.leading) {
        rebuiltHtml += escapeHtml(sentence.leading);
      }

      const sentenceChange = changeMap.get(sentence.id);
      const rendered = renderSentenceTextWithWordSelections(
        sentence.rawText || sentence.text,
        sentenceChange?.words ?? [],
        {
          blockId: block.id,
          sentenceId: sentence.id,
          nextWordId,
          overrides,
        },
      );
      rebuiltHtml += rendered.html;
      words.push(...rendered.words);
      nextWordId = rendered.nextWordId;
    });

    if (block.tail) {
      rebuiltHtml += escapeHtml(block.tail);
    }

    node.innerHTML = rebuiltHtml;

    const speechText = buildRenderedParagraphSpeechText(node);
    if (speechText) {
      paragraphs.push({
        id: index,
        blockId: block.id,
        type: "paragraph",
        text: speechText,
      });
    }
  });

  return {
    html: doc.body.innerHTML,
    textForAudio: paragraphs.map((paragraph) => paragraph.text).join("\n\n"),
    count: words.length,
    paragraphs,
    words,
  };
}

export function extractRenderedPolyglotData(polyHtml) {
  const doc = new DOMParser().parseFromString(polyHtml || "", "text/html");
  const paragraphs = [];
  const words = [];

  doc.body.querySelectorAll(".pw").forEach((node) => {
    const id = Number.parseInt(node.dataset.wordId ?? node.dataset.wordIdx ?? "-1", 10);
    if (!Number.isInteger(id) || id < 0) return;
    words.push({
      id,
      blockId: node.dataset.blockId || "",
      sentenceId: node.dataset.sentenceId || "",
      target: collapseWhitespace(node.querySelector(".pw-target")?.textContent || ""),
      original: collapseWhitespace(
        node.querySelector(".pw-original")?.textContent || "",
      ),
    });
  });

  doc.body.querySelectorAll("[data-pid]").forEach((node) => {
    const id = Number.parseInt(node.dataset.pid ?? "-1", 10);
    if (!Number.isInteger(id) || id < 0) return;
    const text = buildRenderedParagraphSpeechText(node);
    if (!text) return;
    paragraphs.push({
      id,
      blockId: node.dataset.blockId || "",
      type: "paragraph",
      text,
    });
  });

  return {
    html: doc.body.innerHTML,
    paragraphs,
    words: words.sort((a, b) => a.id - b.id),
  };
}
