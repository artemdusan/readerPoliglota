import { extractRenderedPolyglotData } from "./chapterStructure";

/**
 * Backward-compatible helper for already-rendered polyglot HTML.
 */
function extractPolyglotTtsData(polyHtml) {
  return extractRenderedPolyglotData(polyHtml);
}

export class SentenceTtsPlayer {
  constructor({ fragments, lang, voice, onSentence, onDone }) {
    this.fragments = fragments;
    this.lang = lang;
    this.voice = voice || null;
    this.onSentence = onSentence;
    this.onDone = onDone;
    this._stopped = false;
    this._paused = false;
    this._needsRestartOnResume = false;
    this._sid = 0;
    this._utteranceToken = 0;
  }

  play(fromSid = 0, stopAfterSid = Infinity) {
    this._stopped = false;
    this._paused = false;
    this._needsRestartOnResume = false;
    this._sid = fromSid;
    this._stopAfterSid = stopAfterSid;
    this._utteranceToken += 1;
    window.speechSynthesis.cancel();
    this._next();
  }

  pause() {
    if (this._stopped || this._paused) return;
    this._paused = true;
    window.speechSynthesis.pause();
  }

  resume() {
    if (this._stopped || !this._paused) return;
    this._paused = false;
    if (this._needsRestartOnResume) {
      this._needsRestartOnResume = false;
      this._next();
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

    this._next();
  }

  stop() {
    this._stopped = true;
    this._paused = false;
    this._needsRestartOnResume = false;
    this._utteranceToken += 1;
    window.speechSynthesis.cancel();
  }

  _next() {
    if (this._stopped || this._paused) {
      return;
    }

    if (this._sid >= this.fragments.length || this._sid > this._stopAfterSid) {
      if (!this._stopped) this.onDone?.();
      return;
    }

    const fragment = this.fragments[this._sid];
    if (!fragment?.text?.trim()) {
      this._sid++;
      this._next();
      return;
    }

    this.onSentence?.(this._sid);

    const utt = new SpeechSynthesisUtterance(fragment.text);
    const utteranceToken = ++this._utteranceToken;
    utt.lang = this.lang;
    if (this.voice) utt.voice = this.voice;
    utt.onend = () => {
      if (this._stopped || utteranceToken !== this._utteranceToken) return;
      this._sid++;
      this._next();
    };
    utt.onerror = () => {
      if (this._stopped || utteranceToken !== this._utteranceToken) return;
      this._sid++;
      this._next();
    };
    window.speechSynthesis.speak(utt);
  }
}
