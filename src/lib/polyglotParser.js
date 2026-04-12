import { applySentencePatchPayloadToHtml } from "./polyglotStructure";

export function parseStoredPolyglot(entry, chapterHtml = "") {
  if (
    entry?.format === "sentence-word-select-v2" &&
    entry?.payload?.version === 2 &&
    entry?.payload &&
    chapterHtml
  ) {
    return applySentencePatchPayloadToHtml(chapterHtml, entry.payload);
  }

  throw new Error(
    "Obslugiwany jest tylko format sentence-word-select-v2. Wygeneruj tlumaczenie ponownie.",
  );
}
