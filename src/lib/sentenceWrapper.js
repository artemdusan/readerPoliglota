import {
  annotateOriginalChapterHtml,
  buildChapterStructure,
} from "./chapterStructure";

/**
 * Annotate chapter HTML with stable block ids and sentence wrappers.
 * The returned fragments are sentence-based: TTS reads one sentence per
 * utterance so pages follow long paragraphs and pause/resume restarts at most
 * the current sentence, not the whole paragraph.
 */
export function annotateParagraphsInHtml(html, lang = "en") {
  const { html: annotatedHtml, sentences } = annotateOriginalChapterHtml(
    html,
    lang,
  );
  const fragments = sentences.map((sentence, index) => ({
    id: index,
    sentenceId: sentence.id,
    blockId: sentence.blockId,
    text: sentence.text,
  }));
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
