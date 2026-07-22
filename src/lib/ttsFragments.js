import { extractRenderedPolyglotData } from "./chapterStructure";

/**
 * Backward-compatible helper for already-rendered polyglot HTML.
 */
function extractPolyglotTtsData(polyHtml) {
  return extractRenderedPolyglotData(polyHtml);
}

// Group several short sentences into one utterance for natural prosody, but
// keep chunks small: Android/Chrome silently cuts long utterances off and one
// giant utterance would also make pages/pause lag a whole paragraph. ~220 chars
// flows naturally, stays under the cutoff, and still turns pages inside long
// paragraphs.
const DEFAULT_CHUNK_MAX_LEN = 220;

/**
 * Build one utterance chunk starting at `startIndex`: consecutive sentence
 * fragments joined with spaces, up to maxLen, never crossing a paragraph
 * (blockId) boundary so paragraph breaks keep their natural pause.
 * Returns the chunk text, per-sentence char ranges inside that text (for
 * onboundary → sentence mapping) and the index the next chunk starts at.
 */
function buildChunk(fragments, startIndex, maxLen) {
  let text = "";
  let firstBlockId = null;
  const ranges = [];
  let i = startIndex;

  for (; i < fragments.length; i++) {
    const fragment = fragments[i];
    const fragText = (fragment?.text || "").trim();
    if (!fragText) continue;

    if (text) {
      if (fragment.blockId !== firstBlockId) break;
      if (text.length + 1 + fragText.length > maxLen) break;
    } else {
      firstBlockId = fragment.blockId;
    }

    const sep = text ? " " : "";
    const start = text.length + sep.length;
    text += sep + fragText;
    ranges.push({ sid: i, start, end: text.length });
  }

  return { text, ranges, nextIndex: i };
}

export class SentenceTtsPlayer {
  constructor({
    fragments,
    lang,
    voice,
    onSentence,
    onDone,
    onError,
    chunkMaxLen = DEFAULT_CHUNK_MAX_LEN,
  }) {
    this.fragments = fragments;
    this.lang = lang;
    this.voice = voice || null;
    this.onSentence = onSentence;
    this.onDone = onDone;
    this.onError = onError;
    this.maxLen = chunkMaxLen;
    this._stopped = false;
    this._paused = false;
    this._needsRestartOnResume = false;
    this._sid = 0;
    this._chunkNextIndex = 0;
    this._ranges = [];
    this._utteranceToken = 0;
    this._consecutiveErrors = 0;
  }

  play(fromSid = 0, stopAfterSid = Infinity) {
    this._stopped = false;
    this._paused = false;
    this._needsRestartOnResume = false;
    this._sid = fromSid;
    this._stopAfterSid = stopAfterSid;
    this._utteranceToken += 1;
    window.speechSynthesis.cancel();
    this._speakFrom(fromSid);
  }

  pause() {
    if (this._stopped || this._paused) return;
    this._paused = true;
    // speechSynthesis.pause() bywa ignorowane (Android/Chrome, głosy sieciowe),
    // więc pauzujemy przez cancel() i przy wznowieniu startujemy od bieżącego
    // zdania (nie od początku akapitu).
    this._needsRestartOnResume = true;
    this._utteranceToken += 1;
    window.speechSynthesis.cancel();
  }

  resume() {
    if (this._stopped || !this._paused) return;
    this._paused = false;
    if (this._needsRestartOnResume) {
      this._needsRestartOnResume = false;
      this._speakFrom(this._sid);
      return;
    }
    window.speechSynthesis.resume();
  }

  setVoice(voice) {
    this.voice = voice || null;
    if (this._stopped) return;

    const wasPaused = this._paused;
    this._utteranceToken += 1;
    window.speechSynthesis.cancel();

    if (wasPaused) {
      this._needsRestartOnResume = true;
      return;
    }

    this._speakFrom(this._sid);
  }

  stop() {
    this._stopped = true;
    this._paused = false;
    this._needsRestartOnResume = false;
    this._utteranceToken += 1;
    window.speechSynthesis.cancel();
  }

  _speakFrom(index) {
    if (this._stopped || this._paused) return;

    if (index >= this.fragments.length || index > this._stopAfterSid) {
      if (!this._stopped) this.onDone?.();
      return;
    }

    const chunk = buildChunk(this.fragments, index, this.maxLen);
    if (!chunk.ranges.length) {
      // Only empty fragments remained.
      if (!this._stopped) this.onDone?.();
      return;
    }

    this._ranges = chunk.ranges;
    this._chunkNextIndex = chunk.nextIndex;
    this._sid = chunk.ranges[0].sid;
    // Baseline highlight at the chunk start; onboundary refines it per sentence
    // when the voice supports boundaries.
    this.onSentence?.(this._sid);

    const utt = new SpeechSynthesisUtterance(chunk.text);
    const utteranceToken = ++this._utteranceToken;
    utt.lang = this.lang;
    if (this.voice) utt.voice = this.voice;

    utt.onboundary = (event) => {
      if (this._stopped || utteranceToken !== this._utteranceToken) return;
      const charIndex = event.charIndex ?? 0;
      const range =
        this._ranges.find((r) => charIndex >= r.start && charIndex < r.end) ||
        this._ranges[this._ranges.length - 1];
      if (range && range.sid !== this._sid) {
        this._sid = range.sid;
        this.onSentence?.(range.sid);
      }
    };

    utt.onend = () => {
      if (this._stopped || utteranceToken !== this._utteranceToken) return;
      this._consecutiveErrors = 0;
      this._speakFrom(this._chunkNextIndex);
    };

    utt.onerror = () => {
      if (this._stopped || utteranceToken !== this._utteranceToken) return;
      this._consecutiveErrors++;
      if (this._consecutiveErrors >= 3) {
        this.stop();
        this.onError?.();
        return;
      }
      // Skip the failing chunk and keep going.
      this._speakFrom(this._chunkNextIndex);
    };

    window.speechSynthesis.speak(utt);
  }
}
