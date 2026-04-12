export const SEARCH_BLOCK_SELECTOR = "p, h1, h2, h3, h4, h5, h6, li";
export const FONT_SIZE_MIN = 13;
export const FONT_SIZE_MAX = 30;

function flattenToc(items, depth = 0) {
  const result = [];
  for (const item of items) {
    result.push({ ...item, depth });
    if (item.children?.length) {
      result.push(...flattenToc(item.children, depth + 1));
    }
  }
  return result;
}

export function navigableTocItems(toc) {
  const seen = new Set();
  return flattenToc(toc).filter((item) => {
    const base = (item.href || "").split("#")[0];
    if (!base || seen.has(base)) return false;
    seen.add(base);
    return true;
  });
}

export function getVoiceId(voice) {
  if (!voice) return "";
  return voice.voiceURI || `${voice.name}__${voice.lang}`;
}

export function findVoiceById(voices, id) {
  if (!id) return null;
  return voices.find((voice) => getVoiceId(voice) === id) || null;
}

export function getVoicesForLang(voices, lang) {
  const code = (lang || "").split("-")[0].toLowerCase();
  return voices.filter(
    (voice) => (voice.lang || "").toLowerCase().split("-")[0] === code,
  );
}

export function resetTooltipPosition(pw) {
  if (!pw) return;
  pw.style.removeProperty("--pw-tooltip-left");
  pw.style.removeProperty("--pw-tooltip-top");
  pw.style.removeProperty("--pw-tooltip-arrow-left");
  delete pw.dataset.tooltipPlacement;
  delete pw.dataset.tooltipPending;
}

export function normalizeInlineText(value) {
  return (value || "").replace(/\s+/g, " ").trim();
}

export function buildSearchSnippet(text, query) {
  const normalizedText = normalizeInlineText(text);
  const normalizedQuery = normalizeInlineText(query).toLowerCase();
  if (!normalizedText || !normalizedQuery) return normalizedText;

  const idx = normalizedText.toLowerCase().indexOf(normalizedQuery);
  if (idx === -1) return normalizedText.slice(0, 120);

  const start = Math.max(0, idx - 36);
  const end = Math.min(
    normalizedText.length,
    idx + normalizedQuery.length + 56,
  );
  return `${start > 0 ? "..." : ""}${normalizedText.slice(start, end)}${
    end < normalizedText.length ? "..." : ""
  }`;
}

export function getBookmarkPageIndex(bookmark, totalPages) {
  if (!totalPages || totalPages <= 1) return 0;
  return Math.max(
    0,
    Math.min(
      totalPages - 1,
      Math.round((bookmark?.progress ?? 0) * (totalPages - 1)),
    ),
  );
}

export function formatBookmarkPage(bookmark) {
  if (
    Number.isFinite(bookmark?.page) &&
    Number.isFinite(bookmark?.totalPages) &&
    bookmark.totalPages > 0
  ) {
    return `${bookmark.page + 1}/${bookmark.totalPages}`;
  }
  return `${Math.round(((bookmark?.progress ?? 0) + Number.EPSILON) * 100)}%`;
}
