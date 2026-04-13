import {
  annotateOriginalChapterHtml,
  buildChapterStructure,
} from "./chapterStructure";

/**
 * Annotate chapter HTML with stable block ids and sentence wrappers.
 * The returned fragments remain paragraph-based for TTS/navigation.
 */
export function annotateParagraphsInHtml(html, lang = "en") {
  const { html: annotatedHtml, fragments } = annotateOriginalChapterHtml(
    html,
    lang,
  );
  return { html: annotatedHtml, fragments };
}

/**
 * Backward-compatible sentence extraction built on top of the shared structure.
 */
function annotateSentencesInHtml(html, lang = "en") {
  const { html: annotatedHtml, sentences } = annotateOriginalChapterHtml(
    html,
    lang,
  );
  return {
    html: annotatedHtml,
    fragments: sentences.map((sentence, index) => ({
      id: index,
      sentenceId: sentence.id,
      blockId: sentence.blockId,
      type: "sentence",
      text: sentence.text,
    })),
  };
}

function buildSentenceFragmentsFromHtml(html, lang = "en") {
  return buildChapterStructure(html, lang).sentences.map((sentence, index) => ({
    id: index,
    sentenceId: sentence.id,
    blockId: sentence.blockId,
    type: "sentence",
    text: sentence.text,
  }));
}
