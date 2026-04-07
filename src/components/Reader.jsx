import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  db,
  getBook, getChapter, getPolyglotCache, savePolyglotCache,
  getChapterCachedLangs, getReadingPosition, saveReadingPosition,
} from '../db';
import { LANGUAGES } from '../hooks/useSettings';
import { generatePolyglot } from '../lib/polyglotApi';
import { isLoggedIn } from '../sync/cfAuth';
import { uploadPolyglot } from '../sync/cfSync';
import { parsePolyglotHtml } from '../lib/polyglotParser';
import { buildTTSSegments, buildPlainTTSSegments, buildTTSFromHtmlParas, getLangBCP47, sentencesOrFull } from '../lib/ttsSegments';
import { MODEL_PRICING } from '../lib/polyglotApi';
import { useTTS } from '../hooks/useTTS';
import TTSBar from './TTSBar';

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
  const [activeLang, setActiveLang]       = useState(null); // null = original, 'es'/'de'/... = translation
  const [cachedLangs, setCachedLangs]     = useState([]);   // lang codes cached for current chapter
  const [confirmLang, setConfirmLang]     = useState('');   // language selected in confirm dialog
  const [polyState, setPolyState]         = useState('idle');
  const [polyHtml, setPolyHtml]           = useState('');
  const [polyError, setPolyError]         = useState('');
  const [polyProgress, setPolyProgress]   = useState({ done: 0, total: 0, cost: 0, secs: 0 });
  const [polyRawText, setPolyRawText]     = useState('');
  // derived
  const polyMode = activeLang !== null;

  // TTS
  const tts = useTTS();
  const [ttsActive, setTtsActive]     = useState(false);
  const ttsParaStartsRef              = useRef([]);
  const ttsSegmentsRef                = useRef([]);

  // UI state
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [fs, setFs]                   = useState(settings.fontSize ?? 19);

  // Page state (always page mode)
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
  const activeLangRef    = useRef(null);
  const posRestoredRef   = useRef(false);
  const activeParagraphRef = useRef(-1);
  const activeSentenceRef  = useRef(-1);
  const pendingPositionRef = useRef(null);
  const currentPageRef     = useRef(0);
  const totalPagesRef      = useRef(1);
  const flippingRef        = useRef(false);

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
    setActiveLang(null);
    setCachedLangs([]);
    setPolyState('idle');
    setPolyHtml('');
    setPolyError('');
    setPolyRawText('');
    setTtsActive(false);
    window.speechSynthesis?.cancel();
    clearTimeout(tooltipTimerRef.current);
    openPwRef.current = null;
    setCurrentPage(0);
    currentPageRef.current = 0;
    totalPagesRef.current = 1;
    flippingRef.current = false;

    getChapter(bookId, chapterIdx).then(async ch => {
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

      if (ch?.id) {
        const cached_codes = await getChapterCachedLangs(ch.id);
        const langs = cached_codes.map(c => LANGUAGES.find(l => l.code === c)).filter(Boolean);
        setCachedLangs(langs);

        // Restore saved version, else prefer first cached lang
        const savedLang = (pos?.chapterIndex === chapterIdx && pos?.activeLang) ? pos.activeLang : null;
        const langToLoad = (savedLang && cached_codes.includes(savedLang))
          ? savedLang
          : cached_codes[0] ?? null;

        if (langToLoad) {
          const entry = await getPolyglotCache(ch.id, langToLoad);
          if (entry) {
            const { html } = parsePolyglotHtml(entry.rawText);
            setPolyHtml(html);
            setPolyRawText(entry.rawText);
            setPolyState('done');
            setActiveLang(langToLoad);
          }
        } else if (isLoggedIn()) {
          setConfirmLang(settings.targetLang);
          setPolyState('confirm');
        }
      }
    });
  }, [bookId, chapterIdx]);

  /* ── Add sentence spans to DOM ── */
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
          para.dataset.sentenceStart = si;
          si += sentences.length;
        } else {
          para.innerHTML = sentences
            .map(s => `<span data-sentence="${si++}">${escapeHtml(s)}</span>`)
            .join(' ');
        }
      }
    }
  }, [chapter?.id, polyMode]);

  /* ── Page break calculation + position restore ── */
  useEffect(() => {
    const container = chScrollRef.current;
    const inner = chInnerRef.current;
    if (!container || !inner || !chapter?.id) return;

    requestAnimationFrame(() => {
      if (!container || !inner) return;
      const pw = container.clientWidth;
      const ph = container.clientHeight;
      if (!pw || !ph) return;

      // Set up CSS multi-column layout (one column per page)
      inner.style.columnWidth = pw + 'px';
      inner.style.height = ph + 'px';

      // Need a second rAF so browser has reflowed the columns before measuring
      requestAnimationFrame(() => {
        if (!container || !inner) return;
        const total = Math.max(1, Math.round(inner.scrollWidth / pw));
        totalPagesRef.current = total;
        setTotalPages(total);

        // Restore position if pending (chapter just loaded)
        const pos = pendingPositionRef.current;
        pendingPositionRef.current = null;

        if (pos) {
          let targetPage = 0;
          if (!polyMode && pos.sentenceIdx >= 0) {
            const el = container.querySelector(`[data-sentence="${pos.sentenceIdx}"]`);
            if (el && inner) {
              const elLeftFromInner = el.getBoundingClientRect().left - inner.getBoundingClientRect().left;
              targetPage = Math.floor(elLeftFromInner / pw);
            }
          } else if (pos.scrollTop > 0) {
            targetPage = Math.round(pos.scrollTop / pw);
          }
          targetPage = Math.max(0, Math.min(targetPage, total - 1));
          setCurrentPage(targetPage);
          currentPageRef.current = targetPage;
          inner.style.transition = '';
          inner.style.transform = `translateX(-${targetPage * pw}px)`;
        } else {
          setCurrentPage(0);
          currentPageRef.current = 0;
          inner.style.transition = '';
          inner.style.transform = '';
        }
      });
    });
  }, [chapter?.id, polyMode, fs]);

  /* ── Keep activeLangRef in sync and save when activeLang changes ── */
  useEffect(() => {
    activeLangRef.current = activeLang;
    if (!bookId || !posRestoredRef.current) return;
    const sentenceIdx = getCurrentSentenceIdx();
    const pw = chScrollRef.current?.clientWidth ?? 0;
    const scrollTop = currentPageRef.current * pw;
    saveReadingPosition(bookId, chapterIdx, scrollTop, activeLang, sentenceIdx);
  }, [bookId, chapterIdx, activeLang]);

  /* ── Save reading position (debounced) ── */
  const persistPosition = useCallback(() => {
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      const sentenceIdx = getCurrentSentenceIdx();
      const pw = chScrollRef.current?.clientWidth ?? 0;
      const scrollTop = currentPageRef.current * pw;
      saveReadingPosition(bookId, chapterIdx, scrollTop, activeLangRef.current, sentenceIdx);
    }, 800);
  }, [bookId, chapterIdx]);

  function getCurrentSentenceIdx() {
    if (activeLangRef.current !== null) return -1;
    const container = chScrollRef.current;
    if (!container) return -1;

    const containerRect = container.getBoundingClientRect();
    for (const el of container.querySelectorAll('[data-sentence]')) {
      if (el.getBoundingClientRect().right >= containerRect.left) return parseInt(el.dataset.sentence, 10);
    }
    for (const el of container.querySelectorAll('[data-sentence-start]')) {
      if (el.getBoundingClientRect().right >= containerRect.left) return parseInt(el.dataset.sentenceStart, 10);
    }
    return -1;
  }

  /* ── Page navigation with Kindle flash ── */
  function goToPage(page, animate = true) {
    const inner = chInnerRef.current;
    const container = chScrollRef.current;
    if (!inner || !container) return;
    const total = totalPagesRef.current;
    const clampedPage = Math.max(0, Math.min(page, total - 1));

    if (animate && !flippingRef.current) {
      flippingRef.current = true;
      container.classList.add('page-turning');
      setTimeout(() => {
        if (!chInnerRef.current || !chScrollRef.current) { flippingRef.current = false; return; }
        const pw = chScrollRef.current.clientWidth;
        chInnerRef.current.style.transition = '';
        chInnerRef.current.style.transform = `translateX(-${clampedPage * pw}px)`;
        chScrollRef.current.classList.remove('page-turning');
        setCurrentPage(clampedPage);
        currentPageRef.current = clampedPage;
        flippingRef.current = false;
        persistPosition();
      }, 90);
    } else {
      const pw = container.clientWidth;
      inner.style.transition = '';
      inner.style.transform = `translateX(-${clampedPage * pw}px)`;
      setCurrentPage(clampedPage);
      currentPageRef.current = clampedPage;
    }
  }

  function prevPage() { goToPage(currentPageRef.current - 1); }
  function nextPage() { goToPage(currentPageRef.current + 1); }

  /* ── TTS sentence highlight + auto page flip ── */
  useEffect(() => {
    const container = chScrollRef.current;
    const inner = chInnerRef.current;
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
      let el = container.querySelector(`[data-sentence="${segIdx}"]`);
      if (!el) {
        const paras = [...container.querySelectorAll('[data-sentence-start]')];
        for (let i = paras.length - 1; i >= 0; i--) {
          if (parseInt(paras[i].dataset.sentenceStart) <= segIdx) { el = paras[i]; break; }
        }
      }
      if (!el || activeSentenceRef.current === segIdx) return;
      clearHighlight();
      el.classList.add('tts-active-para');
      activeSentenceRef.current = segIdx;

      // Auto page flip for TTS
      if (inner) {
        const elLeftFromInner = el.getBoundingClientRect().left - inner.getBoundingClientRect().left;
        const pw = container.clientWidth;
        const page = Math.floor(elLeftFromInner / pw);
        if (page !== currentPageRef.current) goToPage(page, false);
      }
    } else {
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
      if (el && inner) {
        el.classList.add('tts-active-para');
        const elLeftFromInner = el.getBoundingClientRect().left - inner.getBoundingClientRect().left;
        const pw = container.clientWidth;
        const page = Math.floor(elLeftFromInner / pw);
        if (page !== currentPageRef.current) goToPage(page, false);
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
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); goToPage(currentPageRef.current - 1); }
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); goToPage(currentPageRef.current + 1); }
      if (e.key === 'Escape') setSidebarOpen(false);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  function navigate(idx) {
    persistPosition();
    setChapterIdx(Math.max(0, Math.min(idx, chapterCount - 1)));
  }

  /* ─────────────────────────────────────────
     POLYGLOT
  ───────────────────────────────────────── */

  async function togglePolyglot() {
    if (polyMode) {
      setPolyMode(false);
      return;
    }

    if (!isLoggedIn()) { onOpenSettings(); return; }
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
      const { rawText, cost, elapsedMs } = await generatePolyglot(
        chapter.text,
        { targetLangName: settings.targetLangName, model: settings.polyglotModel },
        (done, total, cost, secs) => {
          if (token === genTokenRef.current) setPolyProgress({ done, total, cost, secs });
        }
      );

      if (token !== genTokenRef.current) return;

      await savePolyglotCache(chapter.id, settings.targetLang, rawText);
      uploadPolyglot(chapter.bookId, chapter.chapterIndex, settings.targetLang, rawText);
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
      const sentenceEl = e.target.closest('[data-sentence]');
      if (sentenceEl) {
        tts.jumpTo(parseInt(sentenceEl.dataset.sentence, 10));
        return;
      }
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
              className={`ctl ${polyMode ? 'ctl-active' : ''}`}
              onClick={togglePolyglot}
              title={polyMode ? 'Wyłącz tłumaczenia' : 'Włącz tłumaczenia'}
            >
              {settings.targetLangFlag}{polyState === 'loading' ? ' …' : ''}
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

        {/* Chapter page area */}
        <div className="ch-scroll" ref={chScrollRef}>
          <div className="ch-columns" ref={chInnerRef} key={animKeyRef.current}>
          <div className="ch-inner">

            {chapterLoading ? (
              <div className="poly-loading"><div className="spin-ring" /></div>
            ) : !chapter ? (
              <div style={{ color: 'var(--txt-3)', fontStyle: 'italic', fontSize: 14 }}>
                Nie można wczytać rozdziału.
              </div>
            ) : (
              <>
                {chapter.title && <div className="ch-title ch-anim">{chapter.title}</div>}

                {polyMode && polyState === 'confirm' && (
                  <div className="poly-confirm ch-anim">
                    <div className="poly-confirm-icon">{settings.targetLangFlag}</div>
                    <p className="poly-confirm-title">Czytaj z tłumaczeniami {settings.targetLangName ? `(${settings.targetLangName})` : ''}</p>
                    <p className="poly-confirm-hint">
                      <strong>{estimatedBatches} {estimatedBatches === 1 ? 'partia' : estimatedBatches < 5 ? 'partie' : 'partii'}</strong>
                      {' · ~'}{estimatedSecs < 60 ? `${estimatedSecs}s` : `${Math.round(estimatedSecs / 60)} min`}
                      {estimatedCost > 0 && <>{' · ~$'}{estimatedCost.toFixed(4)}</>}
                    </p>
                    <div className="poly-confirm-btns">
                      <button className="btn-primary" onClick={startGeneration}>Generuj tłumaczenia</button>
                      <button className="btn-ghost" onClick={() => { setActiveLang(null); setPolyState('idle'); }}>Czytaj bez tłumaczeń</button>
                    </div>
                  </div>
                )}

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

                {polyMode && polyState === 'error' && (
                  <div className="poly-error">
                    <div>⚠ {polyError}</div>
                    <button className="btn-ghost" onClick={() => { setActiveLang(null); setPolyState('idle'); }}>Wróć</button>
                  </div>
                )}

                {polyMode && polyState === 'done' && (
                  <div
                    className={`ch-body ch-anim${ttsActive ? ' tts-cursor tts-poly' : ''}`}
                    dangerouslySetInnerHTML={{ __html: polyHtml }}
                    onClick={handleContentClick}
                  />
                )}

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
        </div>

        {/* Bottom navigation — always page mode */}
        <div className="bottombar">
          <button
            className="nav-btn"
            onClick={() => currentPage === 0 ? navigate(chapterIdx - 1) : prevPage()}
            disabled={currentPage === 0 && chapterIdx === 0}
          >
            ←
          </button>
          <div className="prog-wrap">
            <div className="prog-lbl">
              {chapterIdx + 1}/{chapterCount} · {currentPage + 1}/{totalPages}
            </div>
            <div className="prog-track">
              <div className="prog-fill" style={{ width: progressPct }} />
            </div>
          </div>
          <button
            className="nav-btn"
            onClick={() => currentPage >= totalPages - 1 ? navigate(chapterIdx + 1) : nextPage()}
            disabled={currentPage >= totalPages - 1 && chapterIdx >= chapterCount - 1}
          >
            →
          </button>
        </div>
      </div>

      <button className="sb-tog" onClick={() => setSidebarOpen(s => !s)} title="Spis treści">☰</button>
    </div>
  );
}
