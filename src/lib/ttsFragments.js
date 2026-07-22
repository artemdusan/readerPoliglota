import { extractRenderedPolyglotData } from "./chapterStructure";

/**
 * Backward-compatible helper for already-rendered polyglot HTML.
 */
function extractPolyglotTtsData(polyHtml) {
  return extractRenderedPolyglotData(polyHtml);
}

// Keep at most this many utterances in the engine queue at once. One sentence
// speaks while the next is already queued, so the engine plays them back-to-back
// (natural flow) instead of leaving a gap after every sentence.
const QUEUE_AHEAD = 2;

/**
 * Speaks a chapter one sentence per utterance.
 *
 * Why one sentence per utterance: on Android/Chrome `onboundary` is unreliable
 * (Google voices often fire only word boundaries, or none), so it can't be
 * trusted to tell which sentence is being read. `onstart`, however, is
 * reliable — so highlighting driven by `onstart` always matches the audio
 * exactly, and the page turns precisely when a sentence on a new page begins.
 * Queueing one sentence ahead keeps playback continuous, and pause/resume
 * restarts only the current sentence, never the whole paragraph.
 */
export class SentenceTtsPlayer {
  constructor({ fragments, lang, voice, onSentence, onDone, onError }) {
    this.fragments = fragments;
    this.lang = lang;
    this.voice = voice || null;
    this.onSentence = onSentence;
    this.onDone = onDone;
    this.onError = onError;
    this._stopped = false;
    this._paused = false;
    this._needsRestartOnResume = false;
    this._sid = 0; // sentence currently being spoken (updated on onstart)
    this._nextToQueue = 0; // next fragment index to enqueue
    this._stopAfterSid = Infinity;
    this._inFlight = 0;
    this._token = 0;
    this._consecutiveErrors = 0;
    this._keepAlive = null;
  }

  play(fromSid = 0, stopAfterSid = Infinity) {
    this._stopped = false;
    this._paused = false;
    this._needsRestartOnResume = false;
    this._sid = fromSid;
    this._nextToQueue = fromSid;
    this._stopAfterSid = stopAfterSid;
    this._inFlight = 0;
    this._consecutiveErrors = 0;
    this._token += 1;
    window.speechSynthesis.cancel();
    this._startKeepAlive();
    this._pump();
  }

  pause() {
    if (this._stopped || this._paused) return;
    this._paused = true;
    // speechSynthesis.pause() bywa ignorowane (Android/Chrome, głosy sieciowe),
    // więc pauzujemy przez cancel() i wznawiamy od bieżącego zdania.
    this._needsRestartOnResume = true;
    this._token += 1;
    this._inFlight = 0;
    window.speechSynthesis.cancel();
  }

  resume() {
    if (this._stopped || !this._paused) return;
    this._paused = false;
    if (!this._needsRestartOnResume) {
      window.speechSynthesis.resume();
      return;
    }
    this._needsRestartOnResume = false;
    this._restartFrom(this._sid);
  }

  setVoice(voice) {
    this.voice = voice || null;
    if (this._stopped) return;

    const wasPaused = this._paused;
    this._token += 1;
    this._inFlight = 0;
    window.speechSynthesis.cancel();

    if (wasPaused) {
      this._needsRestartOnResume = true;
      return;
    }
    this._restartFrom(this._sid);
  }

  stop() {
    this._stopped = true;
    this._paused = false;
    this._needsRestartOnResume = false;
    this._token += 1;
    this._inFlight = 0;
    this._stopKeepAlive();
    window.speechSynthesis.cancel();
  }

  _restartFrom(index) {
    this._nextToQueue = index;
    this._sid = index;
    this._consecutiveErrors = 0;
    this._inFlight = 0;
    this._token += 1;
    window.speechSynthesis.cancel();
    this._pump();
  }

  // Keep the engine queue topped up to QUEUE_AHEAD utterances.
  _pump() {
    while (this._inFlight < QUEUE_AHEAD && this._enqueueNext()) {
      /* keep queueing */
    }
  }

  // Queue the next non-empty fragment; return true if one was queued.
  _enqueueNext() {
    let i = this._nextToQueue;
    while (
      i < this.fragments.length &&
      i <= this._stopAfterSid &&
      !this.fragments[i]?.text?.trim()
    ) {
      i += 1;
    }
    if (i >= this.fragments.length || i > this._stopAfterSid) {
      this._nextToQueue = i;
      return false;
    }
    this._nextToQueue = i + 1;

    const token = this._token;
    const utt = new SpeechSynthesisUtterance(this.fragments[i].text);
    utt.lang = this.lang;
    if (this.voice) utt.voice = this.voice;

    utt.onstart = () => {
      if (this._stopped || token !== this._token) return;
      this._sid = i;
      this.onSentence?.(i);
    };

    utt.onend = () => {
      if (token !== this._token) return;
      this._inFlight = Math.max(0, this._inFlight - 1);
      if (this._stopped || this._paused) return;
      this._consecutiveErrors = 0;
      this._pump();
      if (this._inFlight === 0) {
        this._stopKeepAlive();
        this.onDone?.();
      }
    };

    utt.onerror = () => {
      if (token !== this._token) return;
      this._inFlight = Math.max(0, this._inFlight - 1);
      if (this._stopped || this._paused) return;
      this._consecutiveErrors += 1;
      if (this._consecutiveErrors >= 3) {
        this.stop();
        this.onError?.();
        return;
      }
      // Skip the failing sentence and keep going.
      this._pump();
      if (this._inFlight === 0) {
        this._stopKeepAlive();
        this.onDone?.();
      }
    };

    this._inFlight += 1;
    window.speechSynthesis.speak(utt);
    return true;
  }

  // Chrome silently pauses synthesis after ~15s of continuous speech; nudging
  // resume() keeps a long chapter playing. No-op while our own (cancel-based)
  // pause is active, since nothing is speaking then.
  _startKeepAlive() {
    this._stopKeepAlive();
    this._keepAlive = window.setInterval(() => {
      if (this._stopped || this._paused) return;
      const synth = window.speechSynthesis;
      if (synth?.speaking && !synth.paused) synth.resume();
    }, 8000);
  }

  _stopKeepAlive() {
    if (this._keepAlive) {
      window.clearInterval(this._keepAlive);
      this._keepAlive = null;
    }
  }
}
