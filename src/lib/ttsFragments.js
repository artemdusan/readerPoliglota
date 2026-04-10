/**
 * Prepare polyglot HTML for paragraph-based TTS:
 * - adds data-pid to each readable block
 * - adds data-word-id to each foreign-word token
 * - extracts paragraph speech text using the original/source words
 */
export function extractPolyglotTtsData(polyHtml) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(polyHtml, 'text/html');
  const paragraphs = [];
  const words = [];
  let pid = 0;
  let wordId = 0;

  doc.body.querySelectorAll('.pw').forEach(node => {
    const target = collapseWhitespace(node.querySelector('.pw-target')?.textContent || '');
    const original = collapseWhitespace(node.querySelector('.pw-original')?.textContent || '');
    node.dataset.wordId = String(wordId);
    words.push({ id: wordId++, target, original });
  });

  doc.body.querySelectorAll('p, li, blockquote, h1, h2, h3, h4, h5, h6, td, dd').forEach(node => {
    const text = buildParagraphSpeechText(node);
    if (!text) return;
    node.dataset.pid = String(pid);
    paragraphs.push({ id: pid++, type: 'paragraph', text });
  });

  return { html: doc.body.innerHTML, paragraphs, words };
}

function buildParagraphSpeechText(node) {
  const clone = node.cloneNode(true);

  clone.querySelectorAll('br').forEach(br => {
    br.replaceWith(clone.ownerDocument.createTextNode(' '));
  });

  clone.querySelectorAll('.pw').forEach(token => {
    const original = collapseWhitespace(token.querySelector('.pw-original')?.textContent || '')
      || collapseWhitespace(token.querySelector('.pw-target')?.textContent || '');
    token.replaceWith(clone.ownerDocument.createTextNode(original));
  });

  return collapseWhitespace(clone.textContent || '');
}

function collapseWhitespace(text) {
  return String(text).replace(/\s+/g, ' ').trim();
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
