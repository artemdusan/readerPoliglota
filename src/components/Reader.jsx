import { useState, useEffect, useRef, useCallback } from 'react';
import {
  db,
  getBook, getChapter, getPolyglotCache, savePolyglotCache,
  getChapterCachedLangs, getReadingPosition, saveReadingPosition,
  getAudioCache, saveAudioCache,
} from '../db';
import { LANGUAGES } from '../hooks/useSettings';
import { generatePolyglot } from '../lib/polyglotApi';
import { isLoggedIn, getToken } from '../sync/cfAuth';
import { triggerSync } from '../sync/cfSync';
import { parsePolyglotHtml } from '../lib/polyglotParser';
import { MODEL_PRICING } from '../lib/polyglotApi';
import { wrapSentencesInHtml } from '../lib/sentenceWrapper';

const WORKER_URL = import.meta.env.VITE_WORKER_URL || '';

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

function navigableTocItems(toc) {
  const seen = new Set();
  return flattenToc(toc).filter(item => {
    const base = (item.href || '').split('#')[0];
    if (!base || seen.has(base)) return false;
    seen.add(base);
    return true;
  });
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
  const [chapterIdx, setChapterIdx]       = useState(null); // null until reading position loaded
  const [chapter, setChapter]             = useState(null);
  const [chapterLoading, setChapterLoading] = useState(true);

  // Polyglot state
  const [activeLang, setActiveLang]       = useState(null); // null = original
  const [cachedLangs, setCachedLangs]     = useState([]);
  const [polyState, setPolyState]         = useState('idle');
  const [polyHtml, setPolyHtml]           = useState('');
  const [polyError, setPolyError]         = useState('');
  const [polyProgress, setPolyProgress]   = useState({ done: 0, total: 0, cost: 0, secs: 0 });
  const [polyRawText, setPolyRawText]     = useState('');
  const [confirmLang, setConfirmLang]     = useState('');
  // derived
  const polyMode = activeLang !== null;

  // Audio state
  const [audioState, setAudioState]   = useState('idle'); // 'idle'|'loading'|'ready'|'error'
  const [audioError, setAudioError]   = useState('');
  const [audioMarks, setAudioMarks]   = useState(null);   // flat Polly sentence marks array
  const [audioVoiceId, setAudioVoiceId] = useState('');
  const [audioChunkCount, setAudioChunkCount] = useState(1);
  const [activeSid, setActiveSid]     = useState(-1);
  const [isPlaying, setIsPlaying]     = useState(false);
  const [htmlWithSids, setHtmlWithSids] = useState('');   // chapter.html with <span data-sid>
  const audioRef       = useRef(null);
  const audioBlobsRef  = useRef([]);   // ObjectURLs per chunk
  const audioChunkRef  = useRef(0);    // current chunk index
  const audioVoiceRef  = useRef('');
  const audioMarksRef  = useRef(null);
  const activeSidRef   = useRef(-1);
  const chapterBodyRef = useRef(null);

  // UI state
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [fs, setFs]                   = useState(settings.fontSize ?? 19);

  // Page state
  const [currentPage, setCurrentPage] = useState(0);
  const [totalPages, setTotalPages]   = useState(1);

  // Refs
  const chScrollRef    = useRef(null);
  const chInnerRef     = useRef(null);
  const animKeyRef     = useRef(0);
  const saveTimerRef   = useRef(null);
  const genTokenRef    = useRef(0);
  const tooltipTimerRef = useRef(null);
  const openPwRef      = useRef(null);
  const activeLangRef  = useRef(null);
  const pendingProgressRef = useRef(null);  // progress (0-1) to restore after layout (null = no pending restore)
  const userChangedLangRef = useRef(false); // true only when user explicitly switched lang
  const currentPageRef = useRef(0);
  const totalPagesRef  = useRef(1);
  const flippingRef    = useRef(false);

  /* ── Load book metadata + restore starting chapter ── */
  useEffect(() => {
    if (!bookId) return;
    getBook(bookId).then(async b => {
      if (!b) return;
      setBook(b);
      setToc(JSON.parse(b.tocJson || '[]'));
      setChapterCount(b.chapterCount || 0);
      const pos = await getReadingPosition(bookId);
      setChapterIdx(pos?.chapterIndex ?? 0);
    });
  }, [bookId]);

  /* ── Load chapter when index changes ── */
  useEffect(() => {
    if (!bookId || chapterIdx === null) return;
    genTokenRef.current++;
    userChangedLangRef.current = false;
    setChapterLoading(true);
    setActiveLang(null);
    setCachedLangs([]);
    setPolyState('idle');
    setPolyHtml('');
    setPolyError('');
    setPolyRawText('');
    clearTimeout(tooltipTimerRef.current);
    openPwRef.current = null;
    setCurrentPage(0);
    currentPageRef.current = 0;
    totalPagesRef.current = 1;
    flippingRef.current = false;
    // Reset audio
    stopAudio();
    setAudioState('idle');
    setAudioError('');
    setAudioMarks(null);
    setAudioVoiceId('');
    setHtmlWithSids('');
    setActiveSid(-1);
    activeSidRef.current = -1;

    getChapter(bookId, chapterIdx).then(async ch => {
      const pos = await getReadingPosition(bookId);
      pendingProgressRef.current = (pos && pos.chapterIndex === chapterIdx)
        ? (pos.progress ?? 0)
        : 0;

      setChapter(ch || null);
      setChapterLoading(false);
      animKeyRef.current += 1;

      if (ch?.id) {
        const cached_codes = await getChapterCachedLangs(ch.id);
        const langs = cached_codes.map(c => LANGUAGES.find(l => l.code === c)).filter(Boolean);
        setCachedLangs(langs);

        // Restore saved version (if still cached), else prefer first cached lang
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
        }
      }
    });
  }, [bookId, chapterIdx]);

  /* ── Refresh cached langs when BatchGenModal saves a translation ── */
  useEffect(() => {
    function onPolyglotSaved(e) {
      if (!chapter?.id || e.detail.chapterId !== chapter.id) return;
      getChapterCachedLangs(chapter.id).then(codes => {
        setCachedLangs(codes.map(c => LANGUAGES.find(l => l.code === c)).filter(Boolean));
      });
    }
    window.addEventListener('polyglot-saved', onPolyglotSaved);
    return () => window.removeEventListener('polyglot-saved', onPolyglotSaved);
  }, [chapter?.id]);

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

      inner.style.columnWidth = pw + 'px';
      inner.style.height = ph + 'px';

      requestAnimationFrame(() => {
        if (!container || !inner) return;
        const total = Math.max(1, Math.round(inner.scrollWidth / pw));
        totalPagesRef.current = total;
        setTotalPages(total);

        if (pendingProgressRef.current !== null) {
          // Initial load or chapter navigation — restore saved progress (device-independent)
          const targetPage = Math.min(Math.round(pendingProgressRef.current * (total - 1)), total - 1);
          pendingProgressRef.current = null;
          setCurrentPage(targetPage);
          currentPageRef.current = targetPage;
          inner.style.transition = '';
          inner.style.transform = targetPage > 0 ? `translateX(-${targetPage * pw}px)` : '';
        } else {
          // Re-layout only (font change or polyMode switch) — keep current page
          const cur = Math.min(currentPageRef.current, total - 1);
          if (cur !== currentPageRef.current) { setCurrentPage(cur); currentPageRef.current = cur; }
          inner.style.transition = '';
          inner.style.transform = cur > 0 ? `translateX(-${cur * pw}px)` : '';
        }
      });
    });
  }, [chapter?.id, polyMode, fs, polyHtml]);

  /* ── Keep activeLangRef in sync; save position only on explicit user lang switch ── */
  useEffect(() => {
    activeLangRef.current = activeLang;
    if (!bookId || !userChangedLangRef.current) return;
    userChangedLangRef.current = false;
    saveReadingPosition(bookId, chapterIdx, currentPageRef.current / Math.max(1, totalPagesRef.current - 1), activeLang);
  }, [bookId, chapterIdx, activeLang]);

  /* ── Save reading position (debounced) ── */
  const persistPosition = useCallback(() => {
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveReadingPosition(bookId, chapterIdx, currentPageRef.current / Math.max(1, totalPagesRef.current - 1), activeLangRef.current);
    }, 800);
  }, [bookId, chapterIdx]);

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

  /* ── Font size sync ── */
  useEffect(() => {
    document.documentElement.style.setProperty('--fs', fs + 'px');
  }, [fs]);

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
    if (chapterIdx === null) return;
    persistPosition();
    setChapterIdx(Math.max(0, Math.min(idx, chapterCount - 1)));
  }

  /* ─────────────────────────────────────────
     VERSION SWITCHING
  ───────────────────────────────────────── */

  function switchToLang(lang) {
    if (lang === activeLang) return;
    userChangedLangRef.current = true;
    pendingProgressRef.current = 0;
    if (lang === null) {
      setActiveLang(null);
      setPolyState('idle');
      return;
    }
    if (!chapter?.id) return;
    getPolyglotCache(chapter.id, lang).then(entry => {
      if (entry) {
        const { html } = parsePolyglotHtml(entry.rawText);
        setPolyHtml(html);
        setPolyRawText(entry.rawText);
        setPolyState('done');
        setActiveLang(lang);
      }
    });
  }

  function requestGenerate() {
    if (!isLoggedIn()) { onOpenSettings(); return; }
    if (!chapter?.text) return;
    const lastCode = localStorage.getItem('vocabapp:lastLang');
    const initialCode = (lastCode && LANGUAGES.some(l => l.code === lastCode)) ? lastCode : LANGUAGES[0].code;
    userChangedLangRef.current = true;
    setConfirmLang(initialCode);
    setActiveLang(initialCode);
    setPolyState('confirm');
  }

  async function startGeneration() {
    if (!chapter?.text) return;
    const token = ++genTokenRef.current;
    const langCode = confirmLang;
    const langObj = LANGUAGES.find(l => l.code === langCode) ?? LANGUAGES[0];
    setPolyState('loading');
    setPolyProgress({ done: 0, total: 0, cost: 0, secs: 0 });
    setPolyError('');

    try {
      const { rawText, cost, elapsedMs } = await generatePolyglot(
        chapter.text,
        { targetLangName: langObj.name, model: settings.polyglotModel },
        (done, total, cost, secs) => {
          if (token === genTokenRef.current) setPolyProgress({ done, total, cost, secs });
        }
      );

      if (token !== genTokenRef.current) return;

      localStorage.setItem('vocabapp:lastLang', langCode);
      await savePolyglotCache(chapter.id, langCode, rawText);
      triggerSync();

      const { html } = parsePolyglotHtml(rawText);
      setPolyHtml(html);
      setPolyRawText(rawText);
      setPolyState('done');

      // Refresh cached langs list
      const cached_codes = await getChapterCachedLangs(chapter.id);
      setCachedLangs(cached_codes.map(c => LANGUAGES.find(l => l.code === c)).filter(Boolean));
    } catch (err) {
      if (token !== genTokenRef.current) return;
      setPolyError(err.message || 'Błąd API.');
      setPolyState('error');
    }
  }

  /* ─────────────────────────────────────────
     AUDIO — generate, play, highlight
  ───────────────────────────────────────── */

  function stopAudio() {
    const el = audioRef.current;
    if (el) { el.pause(); el.src = ''; }
    audioBlobsRef.current.forEach(u => URL.revokeObjectURL(u));
    audioBlobsRef.current = [];
    audioChunkRef.current = 0;
    audioVoiceRef.current = '';
    setIsPlaying(false);
    setActiveSid(-1);
    activeSidRef.current = -1;
  }

  async function generateAudio() {
    if (!isLoggedIn()) { onOpenSettings(); return; }
    if (!chapter?.text) return;
    setAudioState('loading');
    setAudioError('');
    try {
      // Check local cache
      const lang = book?.lang || 'pl';
      const voice = lang.startsWith('pl') ? 'Ola' : lang.startsWith('es') ? 'Lupe' : 'Joanna';
      const cached = await getAudioCache(chapter.id, voice);
      let marks, chunkCount;

      if (cached) {
        marks = cached.marks;
        chunkCount = cached.chunkCount || 1;
      } else {
        const resp = await fetch(
          `${WORKER_URL}/books/${bookId}/chapters/${chapter.id}/audio`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
            body: JSON.stringify({ text: chapter.text, lang }),
          }
        );
        if (!resp.ok) {
          const body = await resp.json().catch(() => ({}));
          throw new Error(body.error || `HTTP ${resp.status}`);
        }
        const data = await resp.json();
        marks = data.marks;
        chunkCount = data.chunkCount || 1;
        await saveAudioCache(chapter.id, voice, marks, chunkCount);
      }

      audioVoiceRef.current = voice;
      audioMarksRef.current = marks;

      // Pre-fetch all audio chunks as blobs
      const blobs = await Promise.all(
        Array.from({ length: chunkCount }, (_, ci) =>
          fetch(`${WORKER_URL}/books/${bookId}/chapters/${chapter.id}/audio?voiceId=${voice}&chunk=${ci}`, {
            headers: { Authorization: `Bearer ${getToken()}` },
          }).then(r => r.blob()).then(b => URL.createObjectURL(b))
        )
      );
      audioBlobsRef.current = blobs;
      audioChunkRef.current = 0;

      // Process HTML with sentence spans
      const processed = wrapSentencesInHtml(chapter.html, marks);
      setHtmlWithSids(processed);
      setAudioMarks(marks);
      setAudioVoiceId(voice);
      setAudioChunkCount(chunkCount);
      setAudioState('ready');

      // Auto-start playback
      if (audioRef.current) {
        audioRef.current.src = blobs[0];
        audioRef.current.play().catch(() => {});
        setIsPlaying(true);
      }
    } catch (e) {
      setAudioError(e.message || 'Błąd generowania audio');
      setAudioState('error');
    }
  }

  function handleTimeUpdate() {
    const el = audioRef.current;
    const marks = audioMarksRef.current;
    if (!el || !marks) return;

    const chunkIdx = audioChunkRef.current;
    const localMs  = el.currentTime * 1000;

    // Use localTime (ms within this chunk's audio) to find current sentence
    const chunkMarks = marks.filter(m => (m.chunkIndex ?? 0) === chunkIdx);
    let active = null;
    for (let i = chunkMarks.length - 1; i >= 0; i--) {
      if (chunkMarks[i].localTime <= localMs) { active = chunkMarks[i]; break; }
    }
    const sid = active?.sid ?? -1;

    if (sid !== activeSidRef.current) {
      activeSidRef.current = sid;
      setActiveSid(sid);
      highlightSentence(sid);
    }
  }

  function highlightSentence(sid) {
    const body = chapterBodyRef.current;
    if (!body) return;
    // Remove previous highlight
    body.querySelectorAll('.sentence-active').forEach(el => el.classList.remove('sentence-active'));
    if (sid < 0) return;
    const el = body.querySelector(`[data-sid="${sid}"]`);
    if (el) {
      el.classList.add('sentence-active');
      // Scroll to sentence if not on current page (column layout)
      // The element's offsetLeft tells us which column it's in
      const scrollEl = chScrollRef.current;
      const innerEl  = chInnerRef.current;
      if (scrollEl && innerEl) {
        const pw = scrollEl.clientWidth;
        const targetPage = Math.floor(el.offsetLeft / pw);
        if (targetPage !== currentPageRef.current) {
          goToPage(targetPage, false);
        }
      }
    }
  }

  function handleAudioEnded() {
    const nextChunk = audioChunkRef.current + 1;
    if (nextChunk < audioBlobsRef.current.length) {
      audioChunkRef.current = nextChunk;
      audioRef.current.src = audioBlobsRef.current[nextChunk];
      audioRef.current.play().catch(() => {});
    } else {
      setIsPlaying(false);
      setActiveSid(-1);
      activeSidRef.current = -1;
      if (chapterBodyRef.current)
        chapterBodyRef.current.querySelectorAll('.sentence-active').forEach(el => el.classList.remove('sentence-active'));
    }
  }

  function togglePlayPause() {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) { el.play().catch(() => {}); setIsPlaying(true); }
    else           { el.pause(); setIsPlaying(false); }
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
     CONTENT CLICK — tooltip + internal links
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
    }
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
    ? `${Math.round((((chapterIdx ?? 0) + 1) / chapterCount) * 100)}%`
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
          <button className="sb-tog-inline ctl ctl-icon" onClick={() => setSidebarOpen(s => !s)} title="Spis treści">☰</button>
          <div className="tb-chapter">
            {chapter ? (
              <select
                className="tb-ver-select"
                value={activeLang ?? ''}
                onChange={e => {
                  if (e.target.value === '__generate__') { e.target.value = activeLang ?? ''; requestGenerate(); }
                  else switchToLang(e.target.value || null);
                }}
              >
                <option value="">
                  {`Rozdział ${(chapterIdx ?? 0) + 1}${chapter.title ? ' · ' + chapter.title : ''} — Oryginał`}
                </option>
                {cachedLangs.map(l => (
                  <option key={l.code} value={l.code}>
                    {`Rozdział ${(chapterIdx ?? 0) + 1}${chapter.title ? ' · ' + chapter.title : ''} — ${l.name}`}
                  </option>
                ))}
                <option value="__generate__">+ Dodaj tłumaczenie</option>
              </select>
            ) : ''}
          </div>
          <div className="tb-controls">
            <div className="tb-sep" />
            <button className="ctl" onClick={() => setFs(f => Math.max(13, f - 1))}>A−</button>
            <span className="fs-val">{fs}</span>
            <button className="ctl" onClick={() => setFs(f => Math.min(30, f + 1))}>A+</button>
            <div className="tb-sep" />
            {audioState === 'idle' && (
              <button className="ctl ctl-icon" onClick={generateAudio} title="Generuj audio" disabled={!chapter?.text}>
                ▶
              </button>
            )}
            {audioState === 'loading' && (
              <span className="ctl ctl-icon audio-loading" title="Generowanie audio…">
                <span className="spin-ring spin-ring--sm" />
              </span>
            )}
            {audioState === 'ready' && (
              <button className="ctl ctl-icon" onClick={togglePlayPause} title={isPlaying ? 'Pauza' : 'Odtwórz'}>
                {isPlaying ? '⏸' : '▶'}
              </button>
            )}
            {audioState === 'error' && (
              <button className="ctl ctl-icon audio-err" onClick={() => setAudioState('idle')} title={`Błąd: ${audioError}. Kliknij aby spróbować ponownie.`}>
                ⚠
              </button>
            )}
            <div className="tb-sep" />
            <button className="ctl ctl-icon" onClick={onOpenSettings} title="Ustawienia">⚙</button>
          </div>
        </div>

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
                    <p className="poly-confirm-title">Wybierz język tłumaczenia</p>
                    <select
                      className="form-select"
                      value={confirmLang}
                      onChange={e => { setConfirmLang(e.target.value); setActiveLang(e.target.value); }}
                      style={{ marginBottom: 12, alignSelf: 'stretch' }}
                    >
                      {LANGUAGES.map(l => (
                        <option key={l.code} value={l.code}>{l.flag} {l.label} ({l.name})</option>
                      ))}
                    </select>
                    <p className="poly-confirm-hint">
                      <strong>{estimatedBatches} {estimatedBatches === 1 ? 'partia' : estimatedBatches < 5 ? 'partie' : 'partii'}</strong>
                      {' · ~'}{estimatedSecs < 60 ? `${estimatedSecs}s` : `${Math.round(estimatedSecs / 60)} min`}
                      {estimatedCost > 0 && <>{' · ~$'}{estimatedCost.toFixed(4)}</>}
                    </p>
                    <div className="poly-confirm-btns">
                      <button className="btn-primary" onClick={startGeneration}>Generuj tłumaczenia</button>
                      <button className="btn-ghost" onClick={() => { setActiveLang(null); setPolyState('idle'); }}>Anuluj</button>
                    </div>
                  </div>
                )}

                {polyMode && polyState === 'loading' && (
                  <div className="poly-loading">
                    <div className="spin-ring" />
                    <div className="poly-loading-text">
                      {polyProgress.total > 0
                        ? polyProgress.done === 0
                          ? `Wysyłam ${polyProgress.total} fragmentów…`
                          : `Przetworzono ${polyProgress.done} / ${polyProgress.total} fragmentów`
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
                    key={activeLang}
                    ref={chapterBodyRef}
                    className="ch-body ch-anim"
                    dangerouslySetInnerHTML={{ __html: polyHtml }}
                    onClick={handleContentClick}
                  />
                )}

                {!polyMode && (
                  <div
                    ref={chapterBodyRef}
                    className="ch-body ch-anim"
                    dangerouslySetInnerHTML={{
                      __html: audioState === 'ready' && htmlWithSids
                        ? htmlWithSids
                        : (chapter.html ||
                            '<p style="color:var(--txt-3);font-style:italic">Ten rozdział nie zawiera tekstu.</p>'),
                    }}
                    onClick={handleContentClick}
                  />
                )}
              </>
            )}
          </div>
          </div>
        </div>

        {/* Bottom navigation */}
        <div className="bottombar">
          <button
            className="nav-btn"
            onClick={() => currentPage === 0 ? navigate((chapterIdx ?? 0) - 1) : prevPage()}
            disabled={currentPage === 0 && (chapterIdx ?? 0) === 0}
          >
            ←
          </button>
          <div className="prog-wrap">
            <div className="prog-lbl">
              {(chapterIdx ?? 0) + 1}/{chapterCount} · {currentPage + 1}/{totalPages}
            </div>
            <div className="prog-track">
              <div className="prog-fill" style={{ width: progressPct }} />
            </div>
          </div>
          <button
            className="nav-btn"
            onClick={() => currentPage >= totalPages - 1 ? navigate((chapterIdx ?? 0) + 1) : nextPage()}
            disabled={currentPage >= totalPages - 1 && (chapterIdx ?? 0) >= chapterCount - 1}
          >
            →
          </button>
        </div>
      </div>

      {/* Hidden audio element */}
      <audio
        ref={audioRef}
        onTimeUpdate={handleTimeUpdate}
        onEnded={handleAudioEnded}
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        style={{ display: 'none' }}
      />

    </div>
  );
}
