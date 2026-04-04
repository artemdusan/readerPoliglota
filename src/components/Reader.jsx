import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  db,
  getBook, getChapter, getPolyglotCache, savePolyglotCache,
  getReadingPosition, saveReadingPosition,
} from '../db';
import { generatePolyglot } from '../lib/polyglotApi';
import { PROVIDERS } from '../hooks/useSettings';
import { parsePolyglotHtml } from '../lib/polyglotParser';
import { buildTTSSegments, buildPlainTTSSegments, buildTTSFromHtmlParas, getLangBCP47, sentencesOrFull } from '../lib/ttsSegments';
import { MODEL_PRICING } from '../lib/polyglotApi';
import { useTTS } from '../hooks/useTTS';
import TTSBar from './TTSBar';
import { scheduleBookSync } from '../sync/syncManager';

/* ═══════════════════════════════════════════
   Helpers
═══════════════════════════════════════════ */

function flattenToc(items, depth = 0) {
  const result = [];
  for (const item of items) {
    result.push({ ...item, depth });
    if (item.children?.length) result.push(...flattenToc(item.children, depth + 1));
  }
  return result;
}

/** Keep only one entry per unique base file — deduplicates sub-anchors. */
function navigableTocItems(toc) {
  const seen = new Set();
  return flattenToc(toc).filter(item => {
    const base = (item.href || '').split('#')[0];
    if (!base || seen.has(base)) return false;
    seen.add(base);
    return true;
  });
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* ═══════════════════════════════════════════
   Reader component
═══════════════════════════════════════════ */

export default function Reader({ bookId, settings, onUpdateSetting, onBack, onOpenSettings }) {
  // Book metadata
  const [book, setBook]               = useState(null);
  const [toc, setToc]                 = useState([]);
  const [chapterCount, setChapterCount] = useState(0);

  // Chapter state
  const [chapterIdx, setChapterIdx]       = useState(0);
  const [chapter, setChapter]             = useState(null);
  const [chapterLoading, setChapterLoading] = useState(true);

  // Polyglot state
  // polyState: 'idle' | 'confirm' | 'loading' | 'done' | 'error'
  const [polyMode, setPolyMode]           = useState(false);
  const [polyState, setPolyState]         = useState('idle');
  const [polyHtml, setPolyHtml]           = useState('');
  const [polyWordCount, setPolyWordCount] = useState(0);
  const [polyError, setPolyError]         = useState('');
  const [polyProgress, setPolyProgress]   = useState({ done: 0, total: 0, cost: 0, secs: 0 });
  const [polyRawText, setPolyRawText]     = useState('');

  // TTS
  const tts = useTTS();
  const [ttsActive, setTtsActive]     = useState(false);
  const ttsParaStartsRef              = useRef([]);
  const ttsSegmentsRef                = useRef([]);

  // UI state
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [fs, setFs]                   = useState(settings.fontSize ?? 19);

  // Page mode
  const [viewMode, setViewMode]       = useState('scroll'); // 'scroll' | 'pages'
  const [currentPage, setCurrentPage] = useState(0);
  const [totalPages, setTotalPages]   = useState(1);

  // Refs
  const chScrollRef      = useRef(null);
  const chInnerRef       = useRef(null);
  const animKeyRef       = useRef(0);
  const saveTimerRef     = useRef(null);
  const genTokenRef      = useRef(0);
  const tooltipTimerRef  = useRef(null);
  const openPwRef        = useRef(null);
  const polyModeRef      = useRef(false);
  const posRestoredRef   = useRef(false);
  const activeParagraphRef = useRef(-1);
  const activeSentenceRef  = useRef(-1);
  const pendingPositionRef = useRef(null); // { sentenceIdx, scrollTop } — set before render, consumed by sentence effect
  const viewModeRef        = useRef('scroll');
  const currentPageRef     = useRef(0);

  /* ── Plain HTML with data-para ids for TTS highlighting ── */
  const plainHtmlWithParaIds = useMemo(() => {
    if (!chapter?.html) return '';
    const div = document.createElement('div');
    div.innerHTML = chapter.html;
    let pi = 0;
    for (const el of div.querySelectorAll('p')) {
      if (el.textContent.trim()) el.setAttribute('data-para', pi++);
    }
    return div.innerHTML;
  }, [chapter?.id]);

  /* ── Load book metadata ── */
  useEffect(() => {
    if (!bookId) return;
    getBook(bookId).then(b => {
      if (!b) return;
      setBook(b);
      setToc(JSON.parse(b.tocJson || '[]'));
      setChapterCount(b.chapterCount || 0);
    });
  }, [bookId]);

  /* ── Load chapter when index changes ── */
  useEffect(() => {
    if (!bookId) return;
    genTokenRef.current++;
    setChapterLoading(true);
    setPolyMode(false);
    setPolyState('idle');
    setPolyHtml('');
    setPolyError('');
    setPolyRawText('');
    setTtsActive(false);
    window.speechSynthesis?.cancel();
    clearTimeout(tooltipTimerRef.current);
    openPwRef.current = null;
    setCurrentPage(0);

    getChapter(bookId, chapterIdx).then(async ch => {
      // Read position BEFORE triggering re-render to avoid race with sentence effect
      const pos = await getReadingPosition(bookId);
      if (pos && pos.chapterIndex === chapterIdx) {
        pendingPositionRef.current = { sentenceIdx: pos.sentenceIdx ?? -1, scrollTop: pos.scrollTop ?? 0 };
      } else {
        pendingPositionRef.current = null;
      }
      posRestoredRef.current = true;

      setChapter(ch || null);
      setChapterLoading(false);
      animKeyRef.current += 1;

      // Restore polyglot mode if it was active and cache exists
      if (pos?.polyMode && ch?.id && settings.targetLang) {
        const cached = await getPolyglotCache(ch.id, settings.targetLang);
        if (cached) {
          const { html, count } = parsePolyglotHtml(cached.rawText);
          setPolyHtml(html);
          setPolyWordCount(count);
          setPolyRawText(cached.rawText);
          setPolyState('done');
          setPolyMode(true);
        }
      }
    });
  }, [bookId, chapterIdx]);

  /* ── Add sentence spans to DOM + restore reading position ── */
  useEffect(() => {
    const container = chScrollRef.current;
    if (!container || !chapter?.id) return;

    if (!polyMode) {
      let si = 0;
      for (const para of container.querySelectorAll('[data-para]')) {
        const text = para.textContent.trim();
        if (!text) continue;
        const sentences = sentencesOrFull(text);
        if (para.querySelector('a')) {
          // Preserve links — mark paragraph with sentence range instead of splitting
          para.dataset.sentenceStart = si;
          si += sentences.length;
        } else {
          para.innerHTML = sentences
            .map(s => `<span data-sentence="${si++}">${escapeHtml(s)}</span>`)
            .join(' ');
        }
      }
    }

    // Restore saved position
    const pos = pendingPositionRef.current;
    pendingPositionRef.current = null;
    if (pos) {
      requestAnimationFrame(() => {
        if (!container) return;
        if (!polyMode && pos.sentenceIdx >= 0) {
          const el = container.querySelector(`[data-sentence="${pos.sentenceIdx}"]`);
          if (el) { el.scrollIntoView({ block: 'start' }); return; }
        }
        if (pos.scrollTop > 0) container.scrollTop = pos.scrollTop;
      });
    }
  }, [chapter?.id, polyMode]);

  /* ── Page mode: calculate total pages ── */
  useEffect(() => {
    if (viewMode !== 'pages' || !chInnerRef.current || !chScrollRef.current) return;
    requestAnimationFrame(() => {
      if (!chInnerRef.current || !chScrollRef.current) return;
      const ph = chScrollRef.current.clientHeight;
      setTotalPages(Math.max(1, Math.ceil(chInnerRef.current.scrollHeight / ph)));
    });
  }, [viewMode, chapter?.id]);

  /* ── Page mode: apply translateY transform to inner div ── */
  useEffect(() => {
    const inner = chInnerRef.current;
    if (!inner) return;
    if (viewMode === 'pages') {
      const ph = chScrollRef.current?.clientHeight || 0;
      inner.style.transform = `translateY(-${currentPage * ph}px)`;
      inner.style.transition = currentPage === 0 ? '' : 'transform 0.28s ease';
      currentPageRef.current = currentPage;
    } else {
      inner.style.transform = '';
      inner.style.transition = '';
      currentPageRef.current = 0;
    }
  }, [viewMode, currentPage, chapter?.id]);

  /* ── Keep viewModeRef in sync ── */
  useEffect(() => {
    viewModeRef.current = viewMode;
    // Reset currentPage to 0 when leaving page mode
    if (viewMode === 'scroll') setCurrentPage(0);
  }, [viewMode]);

  /* ── Keep polyModeRef in sync and save when polyMode changes ── */
  useEffect(() => {
    polyModeRef.current = polyMode;
    if (!bookId || !posRestoredRef.current) return;
    const sentenceIdx = getCurrentSentenceIdx();
    const scrollTop = chScrollRef.current?.scrollTop ?? 0;
    saveReadingPosition(bookId, chapterIdx, scrollTop, polyMode, sentenceIdx);
  }, [bookId, chapterIdx, polyMode]);

  /* ── Save reading position (debounced) ── */
  const persistPosition = useCallback(() => {
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      const sentenceIdx = getCurrentSentenceIdx();
      const scrollTop = chScrollRef.current?.scrollTop ?? 0;
      saveReadingPosition(bookId, chapterIdx, scrollTop, polyModeRef.current, sentenceIdx);
      scheduleBookSync(bookId);
    }, 800);
  }, [bookId, chapterIdx]);

  function getCurrentSentenceIdx() {
    if (polyModeRef.current) return -1;
    const container = chScrollRef.current;
    if (!container) return -1;

    if (viewModeRef.current === 'pages') {
      const ph = container.clientHeight;
      const pageTop = currentPageRef.current * ph;
      for (const el of container.querySelectorAll('[data-sentence]')) {
        if (el.offsetTop >= pageTop) return parseInt(el.dataset.sentence, 10);
      }
      for (const el of container.querySelectorAll('[data-sentence-start]')) {
        if (el.offsetTop >= pageTop) return parseInt(el.dataset.sentenceStart, 10);
      }
      return -1;
    }

    // Scroll mode: find topmost visible sentence
    const containerTop = container.getBoundingClientRect().top;
    for (const el of container.querySelectorAll('[data-sentence]')) {
      if (el.getBoundingClientRect().bottom >= containerTop) return parseInt(el.dataset.sentence, 10);
    }
    for (const el of container.querySelectorAll('[data-sentence-start]')) {
      if (el.getBoundingClientRect().bottom >= containerTop) return parseInt(el.dataset.sentenceStart, 10);
    }
    return -1;
  }

  /* ── TTS sentence highlight + auto-scroll / page flip ── */
  useEffect(() => {
    const container = chScrollRef.current;
    if (!container) return;

    const clearHighlight = () => {
      if (activeSentenceRef.current >= 0) {
        container.querySelector(`[data-sentence="${activeSentenceRef.current}"]`)
          ?.classList.remove('tts-active-para');
        activeSentenceRef.current = -1;
      }
      if (activeParagraphRef.current >= 0) {
        container.querySelector(`[data-para="${activeParagraphRef.current}"]`)
          ?.classList.remove('tts-active-para');
        activeParagraphRef.current = -1;
      }
    };

    if (!ttsActive) { clearHighlight(); return; }

    const segIdx = tts.progress.idx;

    if (!polyMode) {
      // Plain mode: TTS segment index = sentence index
      let el = container.querySelector(`[data-sentence="${segIdx}"]`);
      if (!el) {
        // Fallback: link-containing paragraph (has data-sentence-start)
        const paras = [...container.querySelectorAll('[data-sentence-start]')];
        for (let i = paras.length - 1; i >= 0; i--) {
          if (parseInt(paras[i].dataset.sentenceStart) <= segIdx) { el = paras[i]; break; }
        }
      }
      if (!el || activeSentenceRef.current === segIdx) return;
      clearHighlight();
      el.classList.add('tts-active-para');
      activeSentenceRef.current = segIdx;

      // Auto-scroll or page flip
      if (viewModeRef.current === 'pages') {
        const ph = container.clientHeight;
        const page = Math.floor(el.offsetTop / ph);
        if (page !== currentPageRef.current) setCurrentPage(page);
      } else {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    } else {
      // Polyglot mode: paragraph-level highlight
      const paraStarts = ttsParaStartsRef.current;
      if (!paraStarts?.length) return;
      let pi = 0;
      for (let i = 0; i < paraStarts.length; i++) {
        if (paraStarts[i] <= segIdx) pi = i;
        else break;
      }
      if (pi === activeParagraphRef.current) return;
      clearHighlight();
      const el = container.querySelector(`[data-para="${pi}"]`);
      if (el) {
        el.classList.add('tts-active-para');
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        activeParagraphRef.current = pi;
      }
    }
  }, [ttsActive, polyMode, tts.progress.idx]);

  /* ── TTS word highlight (polyglot mode only) ── */
  useEffect(() => {
    const container = chScrollRef.current;
    if (!container) return;

    const prev = container.querySelector('.pw.tts-word-active');
    if (prev) prev.classList.remove('tts-word-active');

    if (!ttsActive || !polyMode) return;

    const seg = ttsSegmentsRef.current[tts.progress.idx];
    if (seg?.wordIdx !== undefined) {
      const pw = container.querySelector(`[data-word-idx="${seg.wordIdx}"]`);
      pw?.classList.add('tts-word-active');
    }
  }, [ttsActive, polyMode, tts.progress.idx]);

  /* ── Font size sync ── */
  useEffect(() => {
    document.documentElement.style.setProperty('--fs', fs + 'px');
  }, [fs]);

  /* ── Preferred TTS voice sync ── */
  useEffect(() => {
    tts.setPreferredVoice('pl-PL', settings.ttsVoiceName ?? '');
  }, [settings.ttsVoiceName]);

  useEffect(() => {
    tts.setPreferredVoice(getLangBCP47(settings.targetLang), settings.ttsVoiceNameForeign ?? '');
  }, [settings.ttsVoiceNameForeign, settings.targetLang]);

  /* ── Keyboard navigation ── */
  useEffect(() => {
    function onKey(e) {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (viewModeRef.current === 'pages') {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); prevPage(); }
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); nextPage(); }
      } else {
        if (e.key === 'ArrowLeft'  && chapterIdx > 0) navigate(chapterIdx - 1);
        if (e.key === 'ArrowRight' && chapterIdx < chapterCount - 1) navigate(chapterIdx + 1);
      }
      if (e.key === 'Escape') setSidebarOpen(false);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [chapterIdx, chapterCount]);

  function navigate(idx) {
    persistPosition();
    setChapterIdx(Math.max(0, Math.min(idx, chapterCount - 1)));
  }

  function prevPage() {
    setCurrentPage(p => Math.max(0, p - 1));
  }

  function nextPage() {
    setCurrentPage(p => Math.min(totalPages - 1, p + 1));
  }

  /* ─────────────────────────────────────────
     POLYGLOT
  ───────────────────────────────────────── */

  async function togglePolyglot() {
    if (polyMode) {
      setPolyMode(false);
      return;
    }

    if (!settings.apiKey) { onOpenSettings(); return; }
    if (!chapter?.text) return;

    const cached = await getPolyglotCache(chapter.id, settings.targetLang);
    if (cached) {
      const { html, count } = parsePolyglotHtml(cached.rawText);
      setPolyHtml(html);
      setPolyWordCount(count);
      setPolyRawText(cached.rawText);
      setPolyState('done');
      setPolyMode(true);
      return;
    }

    setPolyMode(true);
    setPolyState('confirm');
  }

  async function startGeneration() {
    if (!chapter?.text) return;
    const token = ++genTokenRef.current;
    setPolyState('loading');
    setPolyProgress({ done: 0, total: 0, cost: 0, secs: 0 });
    setPolyError('');

    try {
      const provider = PROVIDERS.find(p => p.id === settings.provider) ?? PROVIDERS[0];
      const { rawText, cost, elapsedMs } = await generatePolyglot(
        chapter.text,
        { apiKey: settings.apiKey, baseURL: provider.baseURL, targetLangName: settings.targetLangName, model: settings.polyglotModel },
        (done, total, cost, secs) => {
          if (token === genTokenRef.current) setPolyProgress({ done, total, cost, secs });
        }
      );

      if (token !== genTokenRef.current) return;

      await savePolyglotCache(chapter.id, settings.targetLang, rawText);
      const { html, count } = parsePolyglotHtml(rawText);
      setPolyHtml(html);
      setPolyWordCount(count);
      setPolyRawText(rawText);
      setPolyState('done');
    } catch (err) {
      if (token !== genTokenRef.current) return;
      setPolyError(err.message || 'Błąd API.');
      setPolyState('error');
    }
  }

  /* ─────────────────────────────────────────
     TOOLTIP — auto-close after 2s
  ───────────────────────────────────────── */

  function openTooltip(pw) {
    if (openPwRef.current && openPwRef.current !== pw) {
      openPwRef.current.classList.remove('open');
    }
    clearTimeout(tooltipTimerRef.current);

    if (pw.classList.contains('open') && openPwRef.current === pw) {
      pw.classList.remove('open');
      openPwRef.current = null;
      return;
    }

    pw.classList.add('open');
    openPwRef.current = pw;
    tooltipTimerRef.current = setTimeout(() => {
      pw.classList.remove('open');
      if (openPwRef.current === pw) openPwRef.current = null;
    }, 2000);
  }

  /* ─────────────────────────────────────────
     EPUB INTERNAL LINK RESOLVER
  ───────────────────────────────────────── */

  function resolveEpubHref(linkHref) {
    if (!linkHref) return null;
    if (/^https?:\/\/localhost/.test(linkHref)) {
      try { linkHref = new URL(linkHref).pathname.slice(1); } catch { return null; }
    } else if (/^https?:\/\//.test(linkHref) || linkHref.startsWith('mailto:')) {
      return null;
    }
    const withoutAnchor = linkHref.split('#')[0];
    if (!withoutAnchor) return null;
    if (withoutAnchor.startsWith('/')) return withoutAnchor.slice(1);
    const dir = chapter?.href?.includes('/') ? chapter.href.slice(0, chapter.href.lastIndexOf('/') + 1) : '';
    const parts = (dir + withoutAnchor).split('/');
    const out = [];
    for (const p of parts) {
      if (p === '..') out.pop();
      else if (p && p !== '.') out.push(p);
    }
    return out.join('/') || null;
  }

  /* ─────────────────────────────────────────
     CONTENT CLICK — tooltip + TTS jump
  ───────────────────────────────────────── */

  function handleContentClick(e) {
    const anchor = e.target.closest('a[href]');
    if (anchor) {
      const target = resolveEpubHref(anchor.getAttribute('href') || '');
      if (target) {
        e.preventDefault();
        goToHref(target);
      }
      return;
    }

    const pw = e.target.closest('.pw');
    if (pw) {
      openTooltip(pw);
      if (ttsActive) {
        const para = pw.closest('[data-para]');
        if (para) {
          const pi = parseInt(para.dataset.para, 10);
          const segIdx = ttsParaStartsRef.current[pi] ?? 0;
          tts.jumpTo(segIdx);
        }
      }
      return;
    }

    if (ttsActive && !polyMode) {
      // Jump to clicked sentence
      const sentenceEl = e.target.closest('[data-sentence]');
      if (sentenceEl) {
        tts.jumpTo(parseInt(sentenceEl.dataset.sentence, 10));
        return;
      }
      // Fallback for link-containing paragraphs
      const para = e.target.closest('[data-sentence-start]');
      if (para) {
        tts.jumpTo(parseInt(para.dataset.sentenceStart, 10));
        return;
      }
    }

    if (ttsActive && polyMode) {
      const para = e.target.closest('[data-para]');
      if (para) {
        const pi = parseInt(para.dataset.para, 10);
        const segIdx = ttsParaStartsRef.current[pi] ?? 0;
        tts.jumpTo(segIdx);
      }
    }
  }

  /* ─────────────────────────────────────────
     TTS
  ───────────────────────────────────────── */

  function toggleTTS() {
    if (ttsActive) {
      tts.stop();
      setTtsActive(false);
      return;
    }
    let result;
    if (polyMode && polyState === 'done' && polyRawText) {
      result = buildTTSSegments(polyRawText, settings.targetLang);
    } else if (plainHtmlWithParaIds) {
      result = buildTTSFromHtmlParas(plainHtmlWithParaIds);
    }
    if (!result?.segments?.length) return;
    ttsParaStartsRef.current = result.paraStarts;
    ttsSegmentsRef.current = result.segments;
    tts.loadAndPlay(result.segments);
    setTtsActive(true);
  }

  function closeTTS() {
    tts.stop();
    setTtsActive(false);
  }

  /* ── TOC navigation ── */
  function goToHref(href) {
    if (!href || !book) return;
    const clean = href.split('#')[0];
    db.chapters.where('bookId').equals(bookId).toArray().then(chs => {
      const found = chs.find(c => c.href.split('#')[0] === clean);
      if (found) navigate(found.chapterIndex);
    });
    setSidebarOpen(false);
  }

  const progressPct = chapterCount
    ? `${Math.round(((chapterIdx + 1) / chapterCount) * 100)}%`
    : '0%';

  const estimatedBatches = chapter?.text ? Math.ceil(chapter.text.length / 3500) : 0;
  const estimatedCost = (() => {
    if (!chapter?.text) return 0;
    const p = MODEL_PRICING[settings.polyglotModel] ?? { input: 0, output: 0 };
    const inputK  = (chapter.text.length / 4) / 1000;
    const outputK = (chapter.text.length / 3.5) / 1000;
    return inputK * p.input + outputK * p.output;
  })();
  const estimatedSecs = estimatedBatches * (settings.polyglotModel?.includes('reasoner') ? 45 : 12);

  if (!book && !chapterLoading) {
    return (
      <div className="loading-screen">
        <div style={{ color: 'var(--red)' }}>Nie znaleziono książki.</div>
        <button className="btn-ghost" onClick={onBack}>← Biblioteka</button>
      </div>
    );
  }

  return (
    <div className="reader-layout">

      {/* ── Sidebar ── */}
      <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`}>
        <div className="sb-top">
          <button className="btn-back" onClick={() => { persistPosition(); onBack(); }}>
            ← Biblioteka
          </button>
          <div className="sb-cover">
            {book?.cover
              ? <img src={book.cover} alt="okładka" />
              : <span className="cover-ph">📖</span>
            }
          </div>
          <div className="sb-title">{book?.title || '…'}</div>
          {book?.author && <div className="sb-author">{book.author}</div>}
          <div className="sb-stats">{chapterCount} rozdziałów</div>
        </div>
        <div className="toc-label">Spis treści</div>
        <div className="toc-scroll">
          <ul className="toc-list">
            {navigableTocItems(toc).map((item, i) => (
              <li
                key={i}
                className={`toc-entry${
                  chapter?.href?.split('#')[0] === item.href ? ' active' : ''
                }`}
                onClick={() => goToHref(item.href)}
              >
                {item.title || '—'}
              </li>
            ))}
          </ul>
        </div>
      </aside>

      <div className={`sb-overlay ${sidebarOpen ? 'open' : ''}`} onClick={() => setSidebarOpen(false)} />

      {/* ── Main content ── */}
      <div className="reader-main">

        {/* Top bar */}
        <div className="topbar">
          <div className="tb-chapter">
            {chapter ? `Rozdział ${chapterIdx + 1}${chapter.title ? ' · ' + chapter.title : ''}` : ''}
          </div>
          <div className="tb-controls">
            <button
              className={`ctl ${polyMode ? 'ctl-active' : 'ctl-gold'}`}
              onClick={togglePolyglot}
              title="Tryb Poligloty"
            >
              {settings.targetLangFlag} Poliglota
              {polyState === 'loading' && ' …'}
            </button>
            <div className="tb-sep" />
            <button
              className={`ctl ${viewMode === 'pages' ? 'ctl-active' : ''}`}
              onClick={() => setViewMode(v => v === 'scroll' ? 'pages' : 'scroll')}
              title="Tryb stron"
            >
              Strony
            </button>
            <div className="tb-sep" />
            <button className="ctl" onClick={() => setFs(f => Math.max(13, f - 1))}>A−</button>
            <span className="fs-val">{fs}</span>
            <button className="ctl" onClick={() => setFs(f => Math.min(30, f + 1))}>A+</button>
            <div className="tb-sep" />
            <button
              className={`ctl ${ttsActive ? 'ctl-active' : ''}`}
              onClick={toggleTTS}
              title="Czytaj na głos"
              disabled={chapterLoading}
            >
              🔊
            </button>
            <div className="tb-sep" />
            <button className="ctl ctl-icon" onClick={onOpenSettings} title="Ustawienia">⚙</button>
          </div>
        </div>

        {/* TTS player bar */}
        {ttsActive && (
          <TTSBar
            isPlaying={tts.isPlaying}
            toggle={tts.toggle}
            onStop={closeTTS}
            rate={tts.rate}
            setRate={tts.setRate}
            progress={tts.progress}
            voiceName={settings.ttsVoiceName ?? ''}
            onVoiceChange={name => onUpdateSetting('ttsVoiceName', name)}
            foreignLang={getLangBCP47(settings.targetLang)}
            foreignVoiceName={settings.ttsVoiceNameForeign ?? ''}
            onForeignVoiceChange={name => onUpdateSetting('ttsVoiceNameForeign', name)}
          />
        )}

        {/* Chapter scroll area */}
        <div
          className={`ch-scroll${viewMode === 'pages' ? ' ch-pages' : ''}`}
          ref={chScrollRef}
          onScroll={viewMode === 'scroll' ? persistPosition : undefined}
        >
          <div className="ch-inner" ref={chInnerRef} key={animKeyRef.current}>

            {chapterLoading ? (
              <div className="poly-loading"><div className="spin-ring" /></div>
            ) : !chapter ? (
              <div style={{ color: 'var(--txt-3)', fontStyle: 'italic', fontSize: 14 }}>
                Nie można wczytać rozdziału.
              </div>
            ) : (
              <>
                {chapter.title && <div className="ch-title ch-anim">{chapter.title}</div>}

                {/* Ask to generate */}
                {polyMode && polyState === 'confirm' && (
                  <div className="poly-confirm ch-anim">
                    <div className="poly-confirm-icon">🌍</div>
                    <p className="poly-confirm-title">Brak tekstu poligloty dla tego rozdziału</p>
                    <p className="poly-confirm-hint">
                      <strong>{estimatedBatches} {estimatedBatches === 1 ? 'partia' : estimatedBatches < 5 ? 'partie' : 'partii'}</strong>
                      {' · ~'}{estimatedSecs < 60 ? `${estimatedSecs}s` : `${Math.round(estimatedSecs / 60)} min`}
                      {estimatedCost > 0 && <>{' · ~$'}{estimatedCost.toFixed(4)}</>}
                      {' · '}<strong>{settings.provider}</strong>
                    </p>
                    <div className="poly-confirm-btns">
                      <button className="btn-primary" onClick={startGeneration}>Generuj</button>
                      <button className="btn-ghost" onClick={() => { setPolyMode(false); setPolyState('idle'); }}>Anuluj</button>
                    </div>
                  </div>
                )}

                {/* Loading */}
                {polyMode && polyState === 'loading' && (
                  <div className="poly-loading">
                    <div className="spin-ring" />
                    <div className="poly-loading-text">
                      {polyProgress.total > 0
                        ? `Partia ${polyProgress.done} / ${polyProgress.total}…`
                        : 'Łączenie z API…'}
                    </div>
                    {polyProgress.total > 0 && (
                      <>
                        <div className="poly-progress-bar">
                          <div className="poly-progress-fill" style={{ width: `${(polyProgress.done / polyProgress.total) * 100}%` }} />
                        </div>
                        <div className="poly-gen-stats">
                          {polyProgress.secs > 0 && <span>{polyProgress.secs.toFixed(1)}s</span>}
                          {polyProgress.cost > 0
                            ? <span>~${polyProgress.cost.toFixed(4)}</span>
                            : <span style={{ color: 'var(--txt-3)' }}>koszt nieznany</span>
                          }
                        </div>
                      </>
                    )}
                    <p className="poly-loading-hint">
                      Możesz zmienić rozdział — tekst zostanie zapisany w tle.
                    </p>
                  </div>
                )}

                {/* Error */}
                {polyMode && polyState === 'error' && (
                  <div className="poly-error">
                    <div>⚠ {polyError}</div>
                    <button className="btn-ghost" onClick={() => { setPolyMode(false); setPolyState('idle'); }}>Wróć</button>
                  </div>
                )}

                {/* Polyglot content */}
                {polyMode && polyState === 'done' && (
                  <div
                    className={`ch-body ch-anim${ttsActive ? ' tts-cursor tts-poly' : ''}`}
                    dangerouslySetInnerHTML={{ __html: polyHtml }}
                    onClick={handleContentClick}
                  />
                )}

                {/* Normal content */}
                {!polyMode && (
                  <div
                    className={`ch-body ch-anim${ttsActive ? ' tts-cursor' : ''}`}
                    dangerouslySetInnerHTML={{
                      __html: plainHtmlWithParaIds ||
                        '<p style="color:var(--txt-3);font-style:italic">Ten rozdział nie zawiera tekstu.</p>',
                    }}
                    onClick={handleContentClick}
                  />
                )}
              </>
            )}
          </div>
        </div>

        {/* Bottom navigation */}
        {viewMode === 'pages' ? (
          <div className="bottombar">
            <button className="nav-btn" onClick={prevPage} disabled={currentPage === 0}>
              ← <span>Strona</span>
            </button>
            <div className="prog-wrap">
              <div className="prog-lbl">Strona {currentPage + 1} / {totalPages}</div>
              <div className="prog-track">
                <div className="prog-fill" style={{ width: `${((currentPage + 1) / totalPages) * 100}%` }} />
              </div>
            </div>
            <button className="nav-btn" onClick={nextPage} disabled={currentPage >= totalPages - 1}>
              <span>Strona</span> →
            </button>
          </div>
        ) : (
          <div className="bottombar">
            <button className="nav-btn" onClick={() => navigate(chapterIdx - 1)} disabled={chapterIdx === 0}>
              ← <span>Poprzedni</span>
            </button>
            <div className="prog-wrap">
              <div className="prog-lbl">{chapterIdx + 1} / {chapterCount}</div>
              <div className="prog-track">
                <div className="prog-fill" style={{ width: progressPct }} />
              </div>
            </div>
            <button className="nav-btn" onClick={() => navigate(chapterIdx + 1)} disabled={chapterIdx >= chapterCount - 1}>
              <span>Następny</span> →
            </button>
          </div>
        )}
      </div>

      <button className="sb-tog" onClick={() => setSidebarOpen(s => !s)} title="Spis treści">☰</button>
    </div>
  );
}
