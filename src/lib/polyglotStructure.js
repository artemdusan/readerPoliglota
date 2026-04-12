import {
  applySentencePatchPayloadToHtml,
  buildChapterStructure,
  normalizeTranslatedLayout,
  stripPolyglotMarkers,
} from "./chapterStructure";

export { normalizeTranslatedLayout, stripPolyglotMarkers };

export function buildSentencePatchSource(html, lang = "en") {
  return buildChapterStructure(html, lang);
}

export { applySentencePatchPayloadToHtml };
