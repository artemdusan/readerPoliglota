import {
  applySentencePatchPayloadToHtml,
  buildChapterStructure,
  normalizeTranslatedLayout,
} from "./chapterStructure";

export { normalizeTranslatedLayout };

export function buildSentencePatchSource(html, lang = "en") {
  return buildChapterStructure(html, lang);
}

export { applySentencePatchPayloadToHtml };
