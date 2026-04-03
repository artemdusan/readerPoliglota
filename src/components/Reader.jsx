import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  db,
  getBook, getChapter, getPolyglotCache, savePolyglotCache,
  getReadingPosition, saveReadingPosition,
} from '../db';
import { generatePolyglot } from '../lib/polyglotApi';
import { PROVIDERS } from '../hooks/useSettings';
import { parsePolyglotHtml } from '../lib/polyglotParser';
import { buildTTSSegments, buildPlainTTSSegments, buildTTSFromHtmlParas, getLangBCP47 } from '../lib/ttsSegments';
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

  // UI state
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [fs, setFs]                   = useState(settings.fontSize ?? 19);

  // Refs
  const chScrollRef      = useRef(null);
  const animKeyRef       = useRef(0);
  const saveTimerRef     = useRef(null);
  const genTokenRef      = useRef(0);       // incremented per generation to cancel stale results
  const tooltipTimerRef  = useRef(null);    // auto-close tooltip timer
  const openPwRef        = useRef(null);    // currently open .pw element
  const polyModeRef      = useRef(false);   // kept in sync with polyMode state for save callbacks
  const posRestoredRef   = useRef(false);   // true once initial reading position has been loaded
  const activeParagraphRef = useRef(-1);    // data-para index of currently highlighted paragraph

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

  /* ── Restore reading position (chapter index only) ── */
  useEffect(() => {
    if (!bookId) return;
    posRestoredRef.current = false; // reset guard when book changes
    getReadingPosition(bookId).then(pos => {
      if (pos) setChapterIdx(pos.chapterIndex ?? 0);
      posRestoredRef.current = true; // allow saves from now on
    });
  }, [bookId]);

  /* ── Load chapter when index changes ── */
  useEffect(() => {
    if (!bookId) return;
    genTokenRef.current++;           // invalidate any in-flight generation
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

    getChapter(bookId, chapterIdx).then(async ch => {
      setChapter(ch || null);
      setChapterLoading(false);
      animKeyRef.current += 1;

      // Restore scroll — only when this chapter matches the saved position
      const pos = await getReadingPosition(bookId);
      if (chScrollRef.current) {
        if (pos && pos.chapterIndex === chapterIdx && pos.scrollTop > 0) {
          requestAnimationFrame(() => requestAnimationFrame(() => {
            if (chScrollRef.current) chScrollRef.current.scrollTop = pos.scrollTop;
          }));
        } else {
          chScrollRef.current.scrollTop = 0;
        }
      }

      // Restore polyglot mode if it was active and cache exists for this chapter
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

  /* ── Keep polyModeRef in sync and save when polyMode changes ── */
  useEffect(() => {
    polyModeRef.current = polyMode;
    if (!bookId || !posRestoredRef.current) return;
    const scrollTop = chScrollRef.current?.scrollTop ?? 0;
    saveReadingPosition(bookId, chapterIdx, scrollTop, polyMode);
  }, [bookId, chapterIdx, polyMode]);

  /* ── Save reading position (debounced) ── */
  const persistPosition = useCallback(() => {
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      const scrollTop = chScrollRef.current?.scrollTop ?? 0;
      saveReadingPosition(bookId, chapterIdx, scrollTop, polyModeRef.current);
    }, 800);
  }, [bookId, chapterIdx]);

  /* ── TTS paragraph highlight + auto-scroll ── */
  useEffect(() => {
    const container = chScrollRef.current;
    if (!container) return;

    const clearHighlight = () => {
      if (activeParagraphRef.current >= 0) {
        container.querySelector(`[data-para="${activeParagraphRef.current}"]`)
          ?.classList.remove('tts-active-para');
        activeParagraphRef.current = -1;
      }
    };

    if (!ttsActive) { clearHighlight(); return; }

    const paraStarts = ttsParaStartsRef.current;
    if (!paraStarts?.length) return;
    const segIdx = tts.progress.idx;

    // Find largest paraStarts index ≤ segIdx
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
  }, [ttsActive, tts.progress.idx]);

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
      if (e.key === 'ArrowLeft'  && chapterIdx > 0) navigate(chapterIdx - 1);
      if (e.key === 'ArrowRight' && chapterIdx < chapterCount - 1) navigate(chapterIdx + 1);
      if (e.key === 'Escape') setSidebarOpen(false);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [chapterIdx, chapterCount]);

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

    if (!settings.apiKey) { onOpenSettings(); return; }
    if (!chapter?.text) return;

    // Check cache first
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

    // No cache — ask user before generating
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

      if (token !== genTokenRef.current) return; // chapter changed during generation — result saved to cache but UI not updated

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
    // Close previously open one
    if (openPwRef.current && openPwRef.current !== pw) {
      openPwRef.current.classList.remove('open');
    }
    clearTimeout(tooltipTimerRef.current);

    if (pw.classList.contains('open') && openPwRef.current === pw) {
      // Same word clicked again — close immediately
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

  /** Resolve an epub href (possibly relative or absolute localhost) to a root-relative chapter path. */
  function resolveEpubHref(linkHref) {
    if (!linkHref) return null;
    // Absolute localhost URL — extract path portion
    if (/^https?:\/\/localhost/.test(linkHref)) {
      try { linkHref = new URL(linkHref).pathname.slice(1); } catch { return null; }
    } else if (/^https?:\/\//.test(linkHref) || linkHref.startsWith('mailto:')) {
      return null; // true external link — don't intercept
    }
    const withoutAnchor = linkHref.split('#')[0];
    if (!withoutAnchor) return null;
    if (withoutAnchor.startsWith('/')) return withoutAnchor.slice(1);
    // Relative — resolve against current chapter's directory
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
    // Internal EPUB navigation links
    const anchor = e.target.closest('a[href]');
    if (anchor) {
      const target = resolveEpubHref(anchor.getAttribute('href') || '');
      if (target) {
        e.preventDefault();
        goToHref(target);
      }
      // external links: don't preventDefault, let browser open them
      return;
    }

    const pw = e.target.closest('.pw');
    if (pw) {
      openTooltip(pw);
      // If TTS active, jump to the paragraph containing this word
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

    // Click on plain paragraph — jump TTS
    if (ttsActive) {
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
        <div className="ch-scroll" ref={chScrollRef} onScroll={persistPosition}>
          <div className="ch-inner" key={animKeyRef.current}>

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
                    className={`ch-body ch-anim${ttsActive ? ' tts-cursor' : ''}`}
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
      </div>

      <button className="sb-tog" onClick={() => setSidebarOpen(s => !s)} title="Spis treści">☰</button>
    </div>
  );
}
