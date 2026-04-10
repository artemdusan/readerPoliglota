/**
 * Extract ordered TTS fragments from polyglot HTML.
 * Text nodes → { type:'text', text } wrapped in <span class="tf" data-fid="N">
 * .pw elements → { type:'word', target, original } with data-fid="N" added
 * Returns { html: annotated HTML, fragments: [...] }
 */
export function extractFragments(polyHtml) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(polyHtml, 'text/html');
  const fragments = [];
  let fid = 0;

  function walk(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent;
      if (!text.trim()) return;
      const span = doc.createElement('span');
      span.className = 'tf';
      span.dataset.fid = String(fid);
      span.textContent = text;
      node.parentNode.replaceChild(span, node);
      fragments.push({ id: fid++, type: 'text', text });
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      if (node.classList.contains('pw')) {
        const target = node.querySelector('.pw-target')?.textContent || '';
        const original = node.querySelector('.pw-original')?.textContent || '';
        node.dataset.fid = String(fid);
        fragments.push({ id: fid++, type: 'word', target, original });
      } else {
        for (const child of [...node.childNodes]) walk(child);
      }
    }
  }

  for (const child of [...doc.body.childNodes]) walk(child);
  return { html: doc.body.innerHTML, fragments };
}

export class SentenceTtsPlayer {
  constructor({ fragments, lang, voice, onSentence, onDone }) {
    this.fragments = fragments;
    this.lang = lang;
    this.voice = voice || null;
    this.onSentence = onSentence;
    this.onDone = onDone;
    this._stopped = false;
    this._sid = 0;
  }

  play(fromSid = 0, stopAfterSid = Infinity) {
    this._stopped = false;
    this._sid = fromSid;
    this._stopAfterSid = stopAfterSid;
    window.speechSynthesis.cancel();
    this._next();
  }

  stop() {
    this._stopped = true;
    window.speechSynthesis.cancel();
  }

  _next() {
    if (this._stopped || this._sid >= this.fragments.length || this._sid > this._stopAfterSid) {
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
    utt.lang = this.lang;
    if (this.voice) utt.voice = this.voice;
    utt.onend = () => {
      if (this._stopped) return;
      this._sid++;
      this._next();
    };
    utt.onerror = () => {
      if (this._stopped) return;
      this._sid++;
      this._next();
    };
    window.speechSynthesis.speak(utt);
  }
}

/**
 * Web Speech API TTS player.
 * Reads text fragments in sourceLang, word fragments in targetLang.
 * sourceVoice / targetVoice are SpeechSynthesisVoice objects (optional).
 */
export class TtsPlayer {
  constructor({ fragments, sourceLang, targetLang, sourceVoice, targetVoice, onFragment, onDone }) {
    this.fragments = fragments;
    this.sourceLang = sourceLang;
    this.targetLang = targetLang;
    this.sourceVoice = sourceVoice || null;
    this.targetVoice = targetVoice || null;
    this.onFragment = onFragment;
    this.onDone = onDone;
    this._stopped = false;
    this._fid = 0;
  }

  play(fromFid = 0) {
    this._stopped = false;
    this._fid = fromFid;
    window.speechSynthesis.cancel();
    this._next();
  }

  pause() { window.speechSynthesis.pause(); }
  resume() { window.speechSynthesis.resume(); }

  stop() {
    this._stopped = true;
    window.speechSynthesis.cancel();
  }

  _next() {
    if (this._stopped || this._fid >= this.fragments.length) {
      if (!this._stopped) this.onDone?.();
      return;
    }
    const frag = this.fragments[this._fid];
    this.onFragment(this._fid);
    let text, lang;
    if (frag.type === 'word') {
      text = frag.target;
      lang = this.targetLang;
    } else {
      // Append the next word's translation so TTS reads e.g. "This isn't a house"
      const next = this.fragments[this._fid + 1];
      text = (next?.type === 'word' && next.original) ? frag.text + next.original : frag.text;
      lang = this.sourceLang;
    }
    const utt = new SpeechSynthesisUtterance(text);
    utt.lang = lang;
    const voice = frag.type === 'word' ? this.targetVoice : this.sourceVoice;
    if (voice) utt.voice = voice;
    utt.onend = () => { if (!this._stopped) { this._fid++; this._next(); } };
    utt.onerror = () => { if (!this._stopped) { this._fid++; this._next(); } };
    window.speechSynthesis.speak(utt);
  }
}
