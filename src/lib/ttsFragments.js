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

/**
 * Web Speech API TTS player.
 * Reads text fragments in sourceLang, word fragments in targetLang.
 */
export class TtsPlayer {
  constructor({ fragments, sourceLang, targetLang, onFragment, onDone }) {
    this.fragments = fragments;
    this.sourceLang = sourceLang;
    this.targetLang = targetLang;
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
    const utt = new SpeechSynthesisUtterance(
      frag.type === 'word' ? frag.target : frag.text
    );
    utt.lang = frag.type === 'word' ? this.targetLang : this.sourceLang;
    utt.onend = () => { if (!this._stopped) { this._fid++; this._next(); } };
    utt.onerror = () => { if (!this._stopped) { this._fid++; this._next(); } };
    window.speechSynthesis.speak(utt);
  }
}
