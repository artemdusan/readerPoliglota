import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  db,
  getBook,
  getChapter,
  getPolyglotCache,
  savePolyglotCache,
  getChapterCachedLangs,
  getReadingPosition,
  saveReadingPosition,
  saveChapterLang,
  getChapterStatusMap,
} from "../db";
import { LANGUAGES } from "../hooks/useSettings";
import { useWakeLock } from "../hooks/useWakeLock";
import {
  generatePolyglot,
  MODEL_PRICING,
  estimatePolyglotGeneration,
} from "../lib/polyglotApi";
import { isLoggedIn } from "../sync/cfAuth";
import { triggerSync } from "../sync/cfSync";
import { parseStoredPolyglot } from "../lib/polyglotParser";
import { annotateParagraphsInHtml } from "../lib/sentenceWrapper";
import { extractPolyglotTtsData, SentenceTtsPlayer } from "../lib/ttsFragments";

const LANGUAGE_META = Object.fromEntries(
  LANGUAGES.map((lang) => [lang.code, lang]),
);
const LANGUAGE_ORDER = new Map(
  LANGUAGES.map((lang, index) => [lang.code, index]),
);

/* ═══════════════════════════════════════════
   Helpers
═══════════════════════════════════════════ */

function flattenToc(items, depth = 0) {
  const result = [];
  for (const item of items) {
    result.push({ ...item, depth });
    if (item.children?.length)
      result.push(...flattenToc(item.children, depth + 1));
  }
  return result;
}

function navigableTocItems(toc) {
  const seen = new Set();
  return flattenToc(toc).filter((item) => {
    const base = (item.href || "").split("#")[0];
    if (!base || seen.has(base)) return false;
    seen.add(base);
    return true;
  });
}

function getVoiceId(voice) {
  if (!voice) return "";
  return voice.voiceURI || `${voice.name}__${voice.lang}`;
}

function findVoiceById(voices, id) {
  if (!id) return null;
  return voices.find((voice) => getVoiceId(voice) === id) || null;
}

function getVoicesForLang(voices, lang) {
  const code = (lang || "").split("-")[0].toLowerCase();
  return voices.filter(
    (voice) => (voice.lang || "").toLowerCase().split("-")[0] === code,
  );
}

function resetTooltipPosition(pw) {
  if (!pw) return;
  pw.style.removeProperty("--pw-tooltip-left");
  pw.style.removeProperty("--pw-tooltip-top");
  pw.style.removeProperty("--pw-tooltip-arrow-left");
  delete pw.dataset.tooltipPlacement;
}

/* ═══════════════════════════════════════════
   Reader component
═══════════════════════════════════════════ */

export default function Reader({
  bookId,
  settings,
  onUpdateSetting,
  onBack,
  onOpenSettings,
}) {
  // Book metadata
  const [book, setBook] = useState(null);
  const [toc, setToc] = useState([]);
  const [chapterCount, setChapterCount] = useState(0);

  // Chapter state
  const [chapterIdx, setChapterIdx] = useState(null); // null until reading position loaded
  const [chapter, setChapter] = useState(null);
  const [chapterLoading, setChapterLoading] = useState(true);

  // Polyglot state
  const [activeLang, setActiveLang] = useState(null); // null = original
  const [cachedLangs, setCachedLangs] = useState([]);
  const [polyState, setPolyState] = useState("idle");
  const [polyHtml, setPolyHtml] = useState("");
  const [polyError, setPolyError] = useState("");
  const [polyProgress, setPolyProgress] = useState({
    phase: "patch",
    done: 0,
    total: 0,
    cost: 0,
    secs: 0,
  });
  const [polyLiveSecs, setPolyLiveSecs] = useState(0);
  const [polyRescueNote, setPolyRescueNote] = useState("");
  const [confirmLang, setConfirmLang] = useState("");
  // derived
  const polyMode = activeLang !== null;

  // Original TTS state
  const [originalHtmlAnnotated, setOriginalHtmlAnnotated] = useState("");
  const [originalTtsFragments, setOriginalTtsFragments] = useState([]);
  const [originalTtsPlaying, setOriginalTtsPlaying] = useState(false);
  const [originalTtsPaused, setOriginalTtsPaused] = useState(false);
  const [activeSid, setActiveSid] = useState(-1);
  const activeSidRef = useRef(-1);
  const chapterBodyRef = useRef(null);

  // UI state
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [toolbarVisible, setToolbarVisible] = useState(true);
  const [settingsMenuOpen, setSettingsMenuOpen] = useState(false);
  const [fs, setFs] = useState(settings.fontSize ?? 19);

  // Page state
  const [currentPage, setCurrentPage] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [layoutKey, setLayoutKey] = useState(0); // bumped by ResizeObserver to re-trigger layout

  // Missing translation banner
  const [missingLangBanner, setMissingLangBanner] = useState(null); // langCode | null

  // Chapter status map (index → { hasTranslation, hasAudio })
  const [chapterStatusMap, setChapterStatusMap] = useState({});

  // href → chapterIndex map for TOC badges
  const [hrefToIndex, setHrefToIndex] = useState({});

  // Refs
  const chScrollRef = useRef(null);
  const chInnerRef = useRef(null);
  const animKeyRef = useRef(0);
  const saveTimerRef = useRef(null);
  const genTokenRef = useRef(0);
  const genAbortRef = useRef(null);
  const tooltipTimerRef = useRef(null);
  const openPwRef = useRef(null);
  const activeLangRef = useRef(null);
  const chapterIdxRef = useRef(null);
  const pendingProgressRef = useRef(null); // progress (0-1) to restore after layout (null = no pending restore)
  const pendingChapterProgressOverrideRef = useRef(null); // one-shot progress override for the next chapter load
  const userChangedLangRef = useRef(false); // true only when user explicitly switched lang
  const currentPageRef = useRef(0);
  const totalPagesRef = useRef(1);
  const flippingRef = useRef(false);
  const pageTurnTimerRef = useRef(null);
  const desiredLangRef = useRef(null); // lang to carry over when changing chapter
  const originalTtsPlayerRef = useRef(null);
  const ttsAutoStartRef = useRef(null); // 'original' | 'hybrid' | null
  const settingsMenuRef = useRef(null);
  const settingsToggleRef = useRef(null);

  useWakeLock(polyState === "loading");

  // Hybrid TTS state (polyglot mode — Web Speech API, no Polly)
  const [ttsPlaying, setTtsPlaying] = useState(false);
  const [ttsPaused, setTtsPaused] = useState(false);
  const [activePolyPid, setActivePolyPid] = useState(-1);
  const [polyHtmlAnnotated, setPolyHtmlAnnotated] = useState("");
  const [polyTtsParagraphs, setPolyTtsParagraphs] = useState([]);
  const [polyWordFragments, setPolyWordFragments] = useState([]);
  const renderedPolyHtml = polyHtmlAnnotated || polyHtml;
  const ttsPlayerRef = useRef(null);

  // TTS voice selection — persisted per language in localStorage
  const [ttsVoices, setTtsVoices] = useState([]);
  const [ttsSourceVoice, setTtsSourceVoice] = useState(""); // stable voice id
  const [ttsTargetVoice, setTtsTargetVoice] = useState(""); // stable voice id
  const [voiceLoadState, setVoiceLoadState] = useState("loading");

  const clearPageTurnState = useCallback(() => {
    if (pageTurnTimerRef.current) {
      window.clearTimeout(pageTurnTimerRef.current);
      pageTurnTimerRef.current = null;
    }
    flippingRef.current = false;
    chScrollRef.current?.classList.remove("page-turning");
  }, []);

  const syncPageViewport = useCallback((page, colWidth) => {
    const container = chScrollRef.current;
    const inner = chInnerRef.current;
    if (!container || !inner) return;

    // Page by scrollLeft (not transform) to avoid Blink/WebKit multi-column repaint bugs.
    inner.style.removeProperty("transform");
    // Use the explicitly supplied column width when available (avoids a mismatch
    // if clientWidth changed between the rAF that set column-width and the rAF
    // that syncs scrollLeft — common during mobile address-bar transitions).
    const cw = colWidth ?? container.clientWidth;
    container.scrollLeft = Math.max(0, page) * cw;
  }, []);

  /* ── Load Web Speech API voices (async, fires voiceschanged) ── */
  useEffect(() => {
    const synth = window.speechSynthesis;
    if (!synth?.getVoices) {
      setVoiceLoadState("unsupported");
      setTtsVoices([]);
      return undefined;
    }

    let pollTimer = null;
    let cancelled = false;
    const prevOnVoicesChanged = synth.onvoiceschanged;

    const load = () => {
      if (cancelled) return false;
      const voices = synth.getVoices() || [];
      setTtsVoices(voices);
      setVoiceLoadState(voices.length ? "ready" : "empty");
      return voices.length > 0;
    };

    const handleVoicesChanged = () => {
      load();
    };

    load();
    let attempts = 0;
    pollTimer = window.setInterval(() => {
      attempts += 1;
      if (load() || attempts >= 12) {
        window.clearInterval(pollTimer);
        pollTimer = null;
      }
    }, 400);

    if (typeof synth.addEventListener === "function") {
      synth.addEventListener("voiceschanged", handleVoicesChanged);
    }
    synth.onvoiceschanged = (...args) => {
      prevOnVoicesChanged?.apply(synth, args);
      handleVoicesChanged();
    };

    const handleUserUnlock = () => {
      window.setTimeout(load, 0);
    };

    window.addEventListener("pointerdown", handleUserUnlock, { passive: true });
    document.addEventListener("visibilitychange", handleVoicesChanged);

    return () => {
      cancelled = true;
      if (pollTimer) window.clearInterval(pollTimer);
      if (typeof synth.removeEventListener === "function") {
        synth.removeEventListener("voiceschanged", handleVoicesChanged);
      }
      synth.onvoiceschanged = prevOnVoicesChanged || null;
      window.removeEventListener("pointerdown", handleUserUnlock);
      document.removeEventListener("visibilitychange", handleVoicesChanged);
    };
  }, []);

  /* ── Restore saved voice for source lang when book or voices change ── */
  useEffect(() => {
    if (!ttsVoices.length || !book?.lang) return;
    const key = `tts-voice-src-${book.lang.split("-")[0]}`;
    const saved = localStorage.getItem(key);
    if (saved && findVoiceById(ttsVoices, saved)) setTtsSourceVoice(saved);
  }, [ttsVoices, book?.lang]);

  /* ── Restore saved voice for target lang when language or voices change ── */
  useEffect(() => {
    if (!ttsVoices.length || !activeLang) return;
    const key = `tts-voice-tgt-${activeLang.split("-")[0]}`;
    const saved = localStorage.getItem(key);
    if (saved && findVoiceById(ttsVoices, saved)) setTtsTargetVoice(saved);
    else setTtsTargetVoice(""); // reset when switching language
  }, [ttsVoices, activeLang]);

  useEffect(
    () => () => {
      genAbortRef.current?.abort();
      genAbortRef.current = null;
      clearPageTurnState();
      stopAllTts();
    },
    [clearPageTurnState],
  );

  useEffect(() => {
    if (polyState !== "loading") {
      setPolyLiveSecs(0);
      return undefined;
    }

    const startedAt = Date.now();
    setPolyLiveSecs(0);
    const timer = window.setInterval(() => {
      setPolyLiveSecs((Date.now() - startedAt) / 1000);
    }, 100);

    return () => window.clearInterval(timer);
  }, [polyState]);

  /* ── Load book metadata + restore starting chapter ── */
  useEffect(() => {
    if (!bookId) return;
    getBook(bookId).then(async (b) => {
      if (!b) return;
      setBook(b);
      setToc(JSON.parse(b.tocJson || "[]"));
      setChapterCount(b.chapterCount || 0);
      const pos = await getReadingPosition(bookId);
      setChapterIdx(pos?.chapterIndex ?? 0);
      // Build href → chapterIndex map for TOC badges
      const chs = await db.chapters.where("bookId").equals(bookId).toArray();
      const map = {};
      for (const ch of chs) map[ch.href.split("#")[0]] = ch.chapterIndex;
      setHrefToIndex(map);
    });
  }, [bookId]);

  /* ── Load chapter when index changes ── */
  useEffect(() => {
    if (!bookId || chapterIdx === null) return;
    genTokenRef.current++;
    genAbortRef.current?.abort();
    genAbortRef.current = null;
    userChangedLangRef.current = false;
    clearPageTurnState();
    setChapterLoading(true);
    setActiveLang(null);
    setCachedLangs([]);
    setPolyState("idle");
    setPolyHtml("");
    setPolyError("");
    setPolyRescueNote("");
    clearTimeout(tooltipTimerRef.current);
    resetTooltipPosition(openPwRef.current);
    openPwRef.current = null;
    setCurrentPage(0);
    currentPageRef.current = 0;
    totalPagesRef.current = 1;
    flippingRef.current = false;
    syncPageViewport(0);
    setMissingLangBanner(null);
    // Reset original TTS
    stopOriginalTts();
    setOriginalHtmlAnnotated("");
    setOriginalTtsFragments([]);
    setActiveSid(-1);
    activeSidRef.current = -1;
    // Reset hybrid TTS
    ttsPlayerRef.current?.stop();
    ttsPlayerRef.current = null;
    setTtsPlaying(false);
    setActivePolyPid(-1);
    setPolyHtmlAnnotated("");
    setPolyTtsParagraphs([]);
    setPolyWordFragments([]);

    getChapter(bookId, chapterIdx).then(async (ch) => {
      const pos = await getReadingPosition(bookId);
      const progressOverride = pendingChapterProgressOverrideRef.current;
      pendingChapterProgressOverrideRef.current = null;
      pendingProgressRef.current =
        progressOverride ??
        (pos && pos.chapterIndex === chapterIdx ? (pos.progress ?? 0) : 0);

      setChapter(ch || null);
      setOriginalHtmlAnnotated("");
      setOriginalTtsFragments([]);
      setChapterLoading(false);
      animKeyRef.current += 1;

      // Defer paragraph annotation so chapter HTML renders first and the
      // initial layout rAFs (double rAF) complete before the annotated HTML
      // triggers a second layout pass. Using double-rAF here places this AFTER
      // the layout effect's own rAF2, eliminating the race where originalHtmlAnnotated
      // could change between rAF1 and rAF2 of the first layout.
      if (ch?.html) {
        const chHtml = ch.html;
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            const { html: annotated, fragments } =
              annotateParagraphsInHtml(chHtml);
            setOriginalHtmlAnnotated(annotated);
            setOriginalTtsFragments(fragments);
          });
        });
      }

      if (ch?.id) {
        const cached_codes = await getChapterCachedLangs(ch.id);
        const langs = cached_codes
          .map((c) => LANGUAGES.find((l) => l.code === c))
          .filter(Boolean);
        setCachedLangs(langs);

        // Language carry logic:
        // 1. Exact saved lang for this chapter position → use it
        // 2. Language carried from previous chapter → check if cached
        //    - YES → auto-load
        //    - NO  → show missing banner, show original
        // 3. No preference → use first cached if available
        const savedLang =
          pos?.chapterIndex === chapterIdx && pos?.activeLang
            ? pos.activeLang
            : null;
        const desiredLang = desiredLangRef.current;
        desiredLangRef.current = null;

        let langToLoad = null;
        if (savedLang && cached_codes.includes(savedLang)) {
          langToLoad = savedLang;
        } else if (desiredLang) {
          if (cached_codes.includes(desiredLang)) {
            langToLoad = desiredLang;
          } else {
            setMissingLangBanner(desiredLang);
          }
        } else {
          langToLoad = cached_codes[0] ?? null;
        }

        if (langToLoad) {
          const entry = await getPolyglotCache(ch.id, langToLoad);
          if (entry) {
            const { html } = parseStoredPolyglot(entry, ch.html);
            const {
              html: annotated,
              paragraphs,
              words,
            } = extractPolyglotTtsData(html);
            setPolyHtml(html);
            setPolyHtmlAnnotated(annotated);
            setPolyTtsParagraphs(paragraphs);
            setPolyWordFragments(words);
            setPolyState("done");
            setActiveLang(langToLoad);
          }
        }
      }
    });
  }, [bookId, chapterIdx, clearPageTurnState, syncPageViewport]);

  /* ── Refresh cached langs + TOC badges when a translation is saved ── */
  const refreshChapterStatusMap = useCallback(() => {
    if (!bookId) {
      setChapterStatusMap({});
      return Promise.resolve();
    }
    return getChapterStatusMap(bookId).then(setChapterStatusMap);
  }, [bookId]);

  useEffect(() => {
    function onPolyglotSaved(e) {
      if (chapter?.id && e.detail.chapterId === chapter.id) {
        getChapterCachedLangs(chapter.id).then((codes) => {
          setCachedLangs(
            codes
              .map((c) => LANGUAGES.find((l) => l.code === c))
              .filter(Boolean),
          );
        });
      }
      refreshChapterStatusMap();
    }
    window.addEventListener("polyglot-saved", onPolyglotSaved);
    return () => window.removeEventListener("polyglot-saved", onPolyglotSaved);
  }, [chapter?.id, refreshChapterStatusMap]);

  /* ── Auto-start TTS after chapter auto-advance ── */
  useEffect(() => {
    if (!ttsAutoStartRef.current) return;
    if (originalTtsFragments.length === 0) return;
    const mode = ttsAutoStartRef.current;
    ttsAutoStartRef.current = null;
    if (mode === "hybrid" && polyTtsParagraphs.length > 0) {
      startHybridTts(0);
    } else {
      startOriginalTts(0);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [originalTtsFragments]);

  /* ── Chapter status map (translation + audio badges in TOC) ── */
  useEffect(() => {
    refreshChapterStatusMap();
  }, [refreshChapterStatusMap]);

  /* ── Page break calculation + position restore ── */
  useEffect(() => {
    const container = chScrollRef.current;
    const inner = chInnerRef.current;
    if (!container || !inner || !chapter?.id) return;

    clearPageTurnState();

    requestAnimationFrame(() => {
      if (!container || !inner) return;
      const pw = container.clientWidth;
      const ph = container.clientHeight;
      if (!pw || !ph) return;

      // Snap height to whole lines to prevent partial-line clipping at column boundaries
      const chBodyEl = inner.querySelector(".ch-body");
      const lh = chBodyEl
        ? parseFloat(window.getComputedStyle(chBodyEl).lineHeight)
        : 0;
      const snappedPh = lh > 4 ? Math.floor(ph / lh) * lh : ph;

      inner.style.columnWidth = pw + "px";
      inner.style.height = snappedPh + "px";

      requestAnimationFrame(() => {
        if (!container || !inner) return;
        const total = Math.max(1, Math.round(inner.scrollWidth / pw));
        totalPagesRef.current = total;
        setTotalPages(total);

        if (pendingProgressRef.current !== null) {
          // Initial load or chapter navigation — restore saved progress (device-independent)
          const restoreProgress = pendingProgressRef.current;
          const targetPage = Math.min(
            Math.round(restoreProgress * (total - 1)),
            total - 1,
          );
          // Some first-pass layouts briefly report a single page before the
          // final column flow is measured. Keep non-zero restores queued until
          // we see a multi-page layout, otherwise they get collapsed to page 1.
          if (restoreProgress === 0 || total > 1) {
            pendingProgressRef.current = null;
          }
          setCurrentPage(targetPage);
          currentPageRef.current = targetPage;
          inner.style.transition = "";
          // Pass pw so scrollLeft uses the same column width that was applied
          // in the first rAF — avoids mismatch if clientWidth changed meanwhile.
          syncPageViewport(targetPage, pw);
        } else {
          // Re-layout only (font change or polyMode switch) — keep current page
          const cur = Math.min(currentPageRef.current, total - 1);
          if (cur !== currentPageRef.current) {
            setCurrentPage(cur);
            currentPageRef.current = cur;
          }
          inner.style.transition = "";
          syncPageViewport(cur, pw);
        }
      });
    });
  }, [
    chapter?.id,
    polyMode,
    fs,
    renderedPolyHtml,
    originalHtmlAnnotated,
    layoutKey,
    clearPageTurnState,
    syncPageViewport,
  ]);

  useEffect(() => {
    if (!polyMode || polyState !== "done" || !renderedPolyHtml) return;
    const rafId = window.requestAnimationFrame(() => {
      setLayoutKey((k) => k + 1);
    });
    return () => window.cancelAnimationFrame(rafId);
  }, [polyMode, polyState, renderedPolyHtml]);

  useEffect(() => {
    chapterIdxRef.current = chapterIdx;
  }, [chapterIdx]);

  /* ── Re-layout on container resize ── */
  useEffect(() => {
    const container = chScrollRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => {
      const progress =
        totalPagesRef.current > 1
          ? currentPageRef.current / (totalPagesRef.current - 1)
          : 0;
      // Keep explicit chapter-transition restores intact; only capture
      // current progress when no restore is already queued.
      if (pendingProgressRef.current === null) {
        pendingProgressRef.current = progress;
      }
      setLayoutKey((k) => k + 1);
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const getCurrentProgress = useCallback(
    () => currentPageRef.current / Math.max(1, totalPagesRef.current - 1),
    [],
  );

  /* ── Save reading position ── */
  const persistPosition = useCallback(
    ({
      immediate = false,
      chapterIndex = chapterIdxRef.current,
      progress = getCurrentProgress(),
      activeLang = activeLangRef.current,
    } = {}) => {
      if (!bookId || chapterIndex === null || chapterIndex === undefined) {
        return Promise.resolve();
      }

      clearTimeout(saveTimerRef.current);

      const writePosition = () =>
        saveReadingPosition(bookId, chapterIndex, progress, activeLang);

      if (immediate) {
        saveTimerRef.current = null;
        return writePosition();
      }

      saveTimerRef.current = setTimeout(() => {
        saveTimerRef.current = null;
        void writePosition();
      }, 800);
      return Promise.resolve();
    },
    [bookId, getCurrentProgress],
  );

  /* ── Re-sync viewport when app returns from background (visibilitychange / pageshow) ──
     On mobile browsers (especially iOS Safari) scrollLeft on overflow:hidden elements
     can be silently reset to 0 when the PWA is backgrounded and then brought back.
     Re-trigger a full layout so position is correctly restored from refs.          ── */
  useEffect(() => {
    const resync = () => {
      if (document.hidden) return;
      if (pendingProgressRef.current === null) {
        const progress =
          totalPagesRef.current > 1
            ? currentPageRef.current / (totalPagesRef.current - 1)
            : 0;
        pendingProgressRef.current = progress;
      }
      setLayoutKey((k) => k + 1);
    };
    document.addEventListener("visibilitychange", resync);
    // pageshow fires on bfcache restore (iOS Safari back-navigation)
    window.addEventListener("pageshow", resync);
    return () => {
      document.removeEventListener("visibilitychange", resync);
      window.removeEventListener("pageshow", resync);
    };
  }, []);

  /* ── Keep activeLangRef in sync; save position only on explicit user lang switch ── */
  useEffect(() => {
    activeLangRef.current = activeLang;
    if (!bookId || !userChangedLangRef.current) return;
    userChangedLangRef.current = false;
    void persistPosition({ immediate: true, activeLang });
  }, [activeLang, bookId, persistPosition]);

  /* ── Page navigation with Kindle flash ── */
  function goToPage(page, animate = true) {
    const inner = chInnerRef.current;
    const container = chScrollRef.current;
    if (!inner || !container) return;
    const total = totalPagesRef.current;
    const clampedPage = Math.max(0, Math.min(page, total - 1));

    clearPageTurnState();

    if (animate) {
      flippingRef.current = true;
      container.classList.add("page-turning");
      pageTurnTimerRef.current = window.setTimeout(() => {
        pageTurnTimerRef.current = null;
        if (!chInnerRef.current || !chScrollRef.current) {
          clearPageTurnState();
          return;
        }
        chInnerRef.current.style.transition = "";
        syncPageViewport(clampedPage);
        setCurrentPage(clampedPage);
        currentPageRef.current = clampedPage;
        clearPageTurnState();
        persistPosition();
      }, 90);
    } else {
      inner.style.transition = "";
      syncPageViewport(clampedPage);
      setCurrentPage(clampedPage);
      currentPageRef.current = clampedPage;
    }
  }

  function prevPage() {
    if (currentPageRef.current === 0) {
      if ((chapterIdx ?? 0) === 0) return;
      navigate((chapterIdx ?? 0) - 1, { progressOverride: 1 });
      return;
    }
    goToPage(currentPageRef.current - 1);
  }
  function nextPage() {
    if (currentPageRef.current >= totalPagesRef.current - 1) {
      if ((chapterIdx ?? 0) >= chapterCount - 1) return;
      navigate((chapterIdx ?? 0) + 1);
      return;
    }
    goToPage(currentPageRef.current + 1);
  }

  /* ── Font size sync ── */
  useEffect(() => {
    document.documentElement.style.setProperty("--fs", fs + "px");
  }, [fs]);

  /* ── Keyboard navigation ── */
  useEffect(() => {
    function onKey(e) {
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")
        return;
      if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault();
        prevPage();
      }
      if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        e.preventDefault();
        nextPage();
      }
      if (e.key === "Escape") {
        setSidebarOpen(false);
        setSettingsMenuOpen(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [nextPage, prevPage]);

  /* ── Close settings menu on outside click ── */
  useEffect(() => {
    if (!settingsMenuOpen) return;
    function onOutside(e) {
      if (
        settingsMenuRef.current &&
        !settingsMenuRef.current.contains(e.target) &&
        settingsToggleRef.current &&
        !settingsToggleRef.current.contains(e.target)
      ) {
        setSettingsMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, [settingsMenuOpen]);

  function navigate(idx, options = {}) {
    if (chapterIdx === null) return;
    const { progressOverride = null } = options;
    const nextChapterIdx = Math.max(0, Math.min(idx, chapterCount - 1));
    clearPageTurnState();
    void persistPosition({
      immediate: true,
      chapterIndex: nextChapterIdx,
      progress: progressOverride ?? 0,
      activeLang: activeLangRef.current,
    });
    pendingChapterProgressOverrideRef.current = progressOverride;
    // Carry current language to next chapter
    desiredLangRef.current = activeLangRef.current;
    // Save per-chapter lang before leaving
    if (activeLangRef.current && bookId) {
      saveChapterLang(bookId, chapterIdx, activeLangRef.current);
    }
    setChapterIdx(nextChapterIdx);
  }

  /* ─────────────────────────────────────────
     VERSION SWITCHING
  ───────────────────────────────────────── */

  function applyPolyEntry(entry, chapterHtml) {
    const { html } = parseStoredPolyglot(entry, chapterHtml);
    const { html: annotated, paragraphs, words } = extractPolyglotTtsData(html);
    setPolyHtml(html);
    setPolyHtmlAnnotated(annotated);
    setPolyTtsParagraphs(paragraphs);
    setPolyWordFragments(words);
  }

  function switchToLang(lang) {
    if (lang === activeLang) return;
    clearPageTurnState();
    userChangedLangRef.current = true;
    pendingProgressRef.current = 0;
    // Reset audio when switching language — old audio/marks belong to the previous version
    stopOriginalTts();
    setOriginalHtmlAnnotated("");
    setOriginalTtsFragments([]);
    setActiveSid(-1);
    activeSidRef.current = -1;
    // Reset hybrid TTS
    ttsPlayerRef.current?.stop();
    ttsPlayerRef.current = null;
    setTtsPlaying(false);
    setActivePolyPid(-1);
    setPolyHtmlAnnotated("");
    setPolyTtsParagraphs([]);
    setPolyWordFragments([]);
    if (lang === null) {
      if (chapter?.html) {
        const { html: annotated, fragments } = annotateParagraphsInHtml(
          chapter.html,
        );
        setOriginalHtmlAnnotated(annotated);
        setOriginalTtsFragments(fragments);
      }
      setActiveLang(null);
      setPolyState("idle");
      return;
    }
    if (!chapter?.id) return;
    getPolyglotCache(chapter.id, lang).then((entry) => {
      if (entry) {
        applyPolyEntry(entry, chapter.html);
        setPolyState("done");
        setActiveLang(lang);
      }
    });
  }

  function requestGenerate() {
    if (!isLoggedIn()) {
      onOpenSettings();
      return;
    }
    if (!chapter?.text) return;
    clearPageTurnState();
    const lastCode = localStorage.getItem("vocabapp:lastLang");
    const initialCode =
      lastCode && LANGUAGES.some((l) => l.code === lastCode)
        ? lastCode
        : LANGUAGES[0].code;
    userChangedLangRef.current = true;
    setConfirmLang(initialCode);
    setActiveLang(initialCode);
    setPolyState("confirm");
  }

  function regenerateCurrentTranslation() {
    if (!activeLang || !chapter?.text) return;
    if (!isLoggedIn()) {
      onOpenSettings();
      return;
    }
    setSettingsMenuOpen(false);
    startGeneration(activeLang);
  }

  async function startGeneration(forcedLangCode = null) {
    if (!chapter?.text) return;
    const token = ++genTokenRef.current;
    const langCode =
      typeof forcedLangCode === "string" && forcedLangCode
        ? forcedLangCode
        : confirmLang;
    if (!langCode) return;
    genAbortRef.current?.abort();
    const controller = new AbortController();
    genAbortRef.current = controller;
    const langObj = LANGUAGES.find((l) => l.code === langCode) ?? LANGUAGES[0];
    setPolyState("loading");
    setPolyProgress({ phase: "patch", done: 0, total: 0, cost: 0, secs: 0 });
    setPolyError("");
    setPolyRescueNote("");

    try {
      const { cacheValue } = await generatePolyglot(
        { text: chapter.text, html: chapter.html },
        {
          targetLangName: langObj.name,
          sourceLangName: book?.lang || "",
          model: settings.polyglotModel,
          signal: controller.signal,
          onRescue: ({ retryAttempt, maxRetries }) => {
            setPolyRescueNote(
              `Brak postepu. Ponawiam probe (${retryAttempt}/${maxRetries})...`,
            );
          },
        },
        (progress) => {
          if (token === genTokenRef.current) {
            setPolyRescueNote("");
            setPolyProgress(progress);
          }
        },
      );

      if (token !== genTokenRef.current) return;

      localStorage.setItem("vocabapp:lastLang", langCode);
      await savePolyglotCache(chapter.id, langCode, cacheValue);
      window.dispatchEvent(
        new CustomEvent("polyglot-saved", {
          detail: { chapterId: chapter.id, lang: langCode },
        }),
      );
      triggerSync();

      applyPolyEntry(cacheValue, chapter.html);
      genAbortRef.current = null;
      setPolyRescueNote("");
      setPolyState("done");
    } catch (err) {
      if (token !== genTokenRef.current) return;
      genAbortRef.current = null;
      setPolyRescueNote("");
      setPolyError(err.message || "Błąd API.");
      setPolyState("error");
    }
  }

  /* ─────────────────────────────────────────
     HYBRID TTS — Web Speech API, polyglot mode
  ───────────────────────────────────────── */

  function clearWordHighlight() {
    const body = chapterBodyRef.current;
    if (!body) return;
    body
      .querySelectorAll(".tts-active")
      .forEach((el) => el.classList.remove("tts-active"));
  }

  function highlightWord(wordId) {
    const body = chapterBodyRef.current;
    if (!body) return;
    clearWordHighlight();
    if (wordId < 0) return;
    const el = body.querySelector(`[data-word-id="${wordId}"]`);
    if (!el) return;
    el.classList.add("tts-active");
    openTooltip(el, true);
    const scrollEl = chScrollRef.current;
    if (scrollEl) {
      const pw = scrollEl.clientWidth;
      const containerRect = scrollEl.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      const currentOffset = currentPageRef.current * pw;
      const elAbsLeft = elRect.left - containerRect.left + currentOffset;
      const targetPage = Math.floor(elAbsLeft / pw);
      if (
        targetPage !== currentPageRef.current &&
        targetPage >= 0 &&
        targetPage < totalPagesRef.current
      ) {
        goToPage(targetPage, false);
      }
    }
  }

  function clearSentenceHighlight() {
    const body = chapterBodyRef.current;
    if (!body) return;
    body
      .querySelectorAll(".paragraph-active")
      .forEach((el) => el.classList.remove("paragraph-active"));
  }

  function highlightCurrentSentence(pid) {
    const body = chapterBodyRef.current;
    if (!body) return;

    clearSentenceHighlight();
    if (pid < 0) return;

    const el = body.querySelector(`[data-pid="${pid}"]`);
    if (!el) return;
    el.classList.add("paragraph-active");

    const scrollEl = chScrollRef.current;
    if (!scrollEl) return;

    const pw = scrollEl.clientWidth;
    const containerRect = scrollEl.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    const currentOffset = currentPageRef.current * pw;
    const elAbsLeft = elRect.left - containerRect.left + currentOffset;
    const targetPage = Math.floor(elAbsLeft / pw);
    if (
      targetPage !== currentPageRef.current &&
      targetPage >= 0 &&
      targetPage < totalPagesRef.current
    ) {
      goToPage(targetPage, false);
    }
  }

  function announceNextChapter(callback) {
    const polishVoices = ttsVoices.filter(
      (v) => v.lang?.startsWith("pl") || v.name?.toLowerCase().includes("polish"),
    );
    const voice =
      polishVoices.length > 0
        ? polishVoices[Math.floor(Math.random() * polishVoices.length)]
        : null;
    const utt = new SpeechSynthesisUtterance("Kolejny rozdział");
    utt.lang = "pl-PL";
    if (voice) utt.voice = voice;
    utt.onend = callback;
    utt.onerror = callback;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utt);
  }

  function stopHybridTts() {
    ttsPlayerRef.current?.stop();
    ttsPlayerRef.current = null;
    setTtsPlaying(false);
    setTtsPaused(false);
    setActivePolyPid(-1);
    clearSentenceHighlight();
    clearWordHighlight();
  }

  function stopOriginalTts() {
    originalTtsPlayerRef.current?.stop();
    originalTtsPlayerRef.current = null;
    setOriginalTtsPlaying(false);
    setOriginalTtsPaused(false);
    setActiveSid(-1);
    activeSidRef.current = -1;
    clearSentenceHighlight();
  }

  function stopAllTts() {
    stopOriginalTts();
    stopHybridTts();
    window.speechSynthesis?.cancel();
  }

  async function handleBackToLibrary() {
    await persistPosition({ immediate: true });
    stopAllTts();
    onBack();
  }

  function getFirstSidOnCurrentPage() {
    const scrollEl = chScrollRef.current;
    const body = chapterBodyRef.current;
    if (!scrollEl || !body) return 0;
    const pw = scrollEl.clientWidth;
    const containerRect = scrollEl.getBoundingClientRect();
    const page = currentPageRef.current;

    for (const el of body.querySelectorAll("[data-pid]")) {
      const elRect = el.getBoundingClientRect();
      const elAbsLeft = elRect.left - containerRect.left + page * pw;
      if (Math.floor(elAbsLeft / pw) >= page) {
        return parseInt(el.dataset.pid, 10);
      }
    }

    return 0;
  }

  function startOriginalTts(fromSid = 0) {
    if (!originalTtsFragments.length) return;

    stopHybridTts();
    stopOriginalTts();

    const player = new SentenceTtsPlayer({
      fragments: originalTtsFragments,
      lang: book?.lang || "en",
      voice: findVoiceById(ttsVoices, ttsSourceVoice),
      onSentence: (sid) => {
        activeSidRef.current = sid;
        setActiveSid(sid);
        highlightCurrentSentence(sid);
      },
      onDone: () => {
        setOriginalTtsPlaying(false);
        setOriginalTtsPaused(false);
        setActiveSid(-1);
        activeSidRef.current = -1;
        clearSentenceHighlight();
        if (chapterIdx < chapterCount - 1) {
          announceNextChapter(() => {
            ttsAutoStartRef.current = "original";
            navigate(chapterIdx + 1);
          });
        }
      },
    });

    originalTtsPlayerRef.current = player;
    player.play(fromSid);
    setOriginalTtsPlaying(true);
    setOriginalTtsPaused(false);
  }

  function jumpSentence(delta) {
    if (!originalTtsFragments.length) return;
    const base = activeSid >= 0 ? activeSid : getFirstSidOnCurrentPage();
    const pid = Math.max(
      0,
      Math.min(originalTtsFragments.length - 1, base + delta),
    );
    startOriginalTts(pid);
  }

  function toggleOriginalTts() {
    if (!originalTtsPlaying) {
      startOriginalTts(getFirstSidOnCurrentPage());
      return;
    }

    if (originalTtsPaused) {
      originalTtsPlayerRef.current?.resume();
      setOriginalTtsPaused(false);
      return;
    }

    originalTtsPlayerRef.current?.pause();
    setOriginalTtsPaused(true);
  }

  function startHybridTts(fromPid = 0) {
    if (!polyTtsParagraphs.length) return;
    stopOriginalTts();
    stopHybridTts();
    const player = new SentenceTtsPlayer({
      fragments: polyTtsParagraphs,
      lang: book?.lang || "en",
      voice: findVoiceById(ttsVoices, ttsSourceVoice),
      onSentence: (pid) => {
        setActivePolyPid(pid);
        highlightCurrentSentence(pid);
      },
      onDone: () => {
        setTtsPlaying(false);
        setTtsPaused(false);
        setActivePolyPid(-1);
        clearSentenceHighlight();
        if (chapterIdx < chapterCount - 1) {
          announceNextChapter(() => {
            ttsAutoStartRef.current = "hybrid";
            navigate(chapterIdx + 1);
          });
        }
      },
    });
    ttsPlayerRef.current = player;
    player.play(fromPid);
    setTtsPlaying(true);
    setTtsPaused(false);
  }

  // Jump to the previous/next paragraph while playing
  function jumpPolyParagraph(delta) {
    if (!polyTtsParagraphs.length) return;
    const base =
      activePolyPid >= 0 ? activePolyPid : getFirstSidOnCurrentPage();
    const pid = Math.max(
      0,
      Math.min(polyTtsParagraphs.length - 1, base + delta),
    );
    startHybridTts(pid);
  }

  function toggleHybridTts() {
    if (!ttsPlaying) {
      startHybridTts(getFirstSidOnCurrentPage());
      return;
    }

    if (ttsPaused) {
      ttsPlayerRef.current?.resume();
      setTtsPaused(false);
      return;
    }

    ttsPlayerRef.current?.pause();
    setTtsPaused(true);
  }

  function playSingleWord(wordId) {
    stopOriginalTts();
    stopHybridTts();
    const word = polyWordFragments[wordId];
    if (!word) return;
    highlightWord(wordId);
    const text = word.target;
    const utt = new SpeechSynthesisUtterance(text);
    utt.lang = activeLang || "es";
    const targetVoice = findVoiceById(ttsVoices, ttsTargetVoice);
    if (targetVoice) utt.voice = targetVoice;
    utt.onend = () => {
      clearWordHighlight();
    };
    utt.onerror = () => {
      clearWordHighlight();
    };
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utt);
  }

  /* ─────────────────────────────────────────
     TOOLTIP — auto-close after 2s
  ───────────────────────────────────────── */

  function openTooltip(pw, force = false) {
    if (openPwRef.current && openPwRef.current !== pw) {
      openPwRef.current.classList.remove("open");
      resetTooltipPosition(openPwRef.current);
    }
    clearTimeout(tooltipTimerRef.current);

    if (!force && pw.classList.contains("open") && openPwRef.current === pw) {
      pw.classList.remove("open");
      resetTooltipPosition(pw);
      openPwRef.current = null;
      return;
    }

    pw.classList.add("open");
    positionTooltip(pw);
    openPwRef.current = pw;
    tooltipTimerRef.current = setTimeout(() => {
      pw.classList.remove("open");
      resetTooltipPosition(pw);
      if (openPwRef.current === pw) openPwRef.current = null;
    }, 2000);
  }

  function positionTooltip(pw) {
    const tooltip = pw?.querySelector(".pw-original");
    const scrollEl = chScrollRef.current;
    if (!tooltip || !scrollEl) return;

    resetTooltipPosition(pw);

    window.requestAnimationFrame(() => {
      if (!pw.isConnected || !pw.classList.contains("open")) return;

      const viewportRect = scrollEl.getBoundingClientRect();
      const pwRect = pw.getBoundingClientRect();
      const tooltipRect = tooltip.getBoundingClientRect();
      const viewportPadding = 10;
      const gap = 7;

      const centerX = pwRect.left + pwRect.width / 2;
      const minLeft = viewportRect.left + viewportPadding;
      const maxLeft = viewportRect.right - viewportPadding - tooltipRect.width;
      const preferredLeft = centerX - tooltipRect.width / 2;
      const clampedLeft =
        maxLeft >= minLeft
          ? Math.min(Math.max(preferredLeft, minLeft), maxLeft)
          : minLeft;

      const fitsAbove =
        pwRect.top - gap - tooltipRect.height >=
        viewportRect.top + viewportPadding;
      const preferredTop = fitsAbove
        ? pwRect.top - gap - tooltipRect.height
        : pwRect.bottom + gap;
      const minTop = viewportRect.top + viewportPadding;
      const maxTop = viewportRect.bottom - viewportPadding - tooltipRect.height;
      const clampedTop =
        maxTop >= minTop
          ? Math.min(Math.max(preferredTop, minTop), maxTop)
          : minTop;

      const arrowLeft = Math.min(
        Math.max(centerX - clampedLeft, 10),
        tooltipRect.width - 10,
      );

      pw.style.setProperty(
        "--pw-tooltip-left",
        `${clampedLeft - pwRect.left}px`,
      );
      pw.style.setProperty("--pw-tooltip-top", `${clampedTop - pwRect.top}px`);
      pw.style.setProperty("--pw-tooltip-arrow-left", `${arrowLeft}px`);
      pw.dataset.tooltipPlacement =
        clampedTop >= pwRect.bottom ? "bottom" : "top";
    });
  }

  /* ─────────────────────────────────────────
     EPUB INTERNAL LINK RESOLVER
  ───────────────────────────────────────── */

  function resolveEpubHref(linkHref) {
    if (!linkHref) return null;
    if (/^https?:\/\/localhost/.test(linkHref)) {
      try {
        linkHref = new URL(linkHref).pathname.slice(1);
      } catch {
        return null;
      }
    } else if (
      /^https?:\/\//.test(linkHref) ||
      linkHref.startsWith("mailto:")
    ) {
      return null;
    }
    const withoutAnchor = linkHref.split("#")[0];
    if (!withoutAnchor) return null;
    if (withoutAnchor.startsWith("/")) return withoutAnchor.slice(1);
    const dir = chapter?.href?.includes("/")
      ? chapter.href.slice(0, chapter.href.lastIndexOf("/") + 1)
      : "";
    const parts = (dir + withoutAnchor).split("/");
    const out = [];
    for (const p of parts) {
      if (p === "..") out.pop();
      else if (p && p !== ".") out.push(p);
    }
    return out.join("/") || null;
  }

  /* ─────────────────────────────────────────
     CONTENT CLICK — tooltip + internal links + click-to-seek
  ───────────────────────────────────────── */

  function handleContentClick(e) {
    const anchor = e.target.closest("a[href]");
    if (anchor) {
      const target = resolveEpubHref(anchor.getAttribute("href") || "");
      if (target) {
        e.preventDefault();
        goToHref(target);
      }
      return;
    }

    // In translated mode: words preview pronunciation, paragraphs seek only while TTS is active
    if (polyMode) {
      const pw = e.target.closest(".pw");
      if (pw) {
        openTooltip(pw);
        const wordId = Number.parseInt(pw.dataset.wordId, 10);
        if (Number.isInteger(wordId)) playSingleWord(wordId);
        return;
      }
      const pidEl = e.target.closest("[data-pid]");
      if (pidEl && ttsPlaying && polyTtsParagraphs.length > 0) {
        const pid = parseInt(pidEl.dataset.pid, 10);
        if (pid !== activePolyPid) startHybridTts(pid);
      }
      return;
    }

    // In original mode: paragraph seek works only while TTS is already active
    const pidEl = e.target.closest("[data-pid]");
    if (pidEl && originalTtsPlaying && originalTtsFragments.length > 0) {
      const pid = parseInt(pidEl.dataset.pid, 10);
      if (pid !== activeSid) startOriginalTts(pid);
    }
  }

  /* ── TOC navigation ── */
  function goToHref(href) {
    if (!href || !book) return;
    const clean = href.split("#")[0];
    db.chapters
      .where("bookId")
      .equals(bookId)
      .toArray()
      .then((chs) => {
        const found = chs.find((c) => c.href.split("#")[0] === clean);
        if (found) navigate(found.chapterIndex);
      });
    setSidebarOpen(false);
  }

  const progressPct = chapterCount
    ? `${Math.round((((chapterIdx ?? 0) + 1) / chapterCount) * 100)}%`
    : "0%";

  const { generationBatches: estimatedFragments } = useMemo(
    () => estimatePolyglotGeneration({ html: chapter?.html }),
    [chapter?.html],
  );
  const estimatedCost = (() => {
    if (!chapter?.text) return 0;
    const p = MODEL_PRICING[settings.polyglotModel] ?? { input: 0, output: 0 };
    const inputK = chapter.text.length / 4 / 1000;
    const outputK = chapter.text.length / 3.5 / 1000;
    return inputK * p.input + outputK * p.output;
  })();
  const estimatedSecs = chapter?.text
    ? Math.ceil(chapter.text.length / 3500) *
      (settings.polyglotModel?.includes("reasoner") ? 45 : 12)
    : 0;
  const polyDisplaySecs =
    polyState === "loading"
      ? Math.max(polyProgress.secs, polyLiveSecs)
      : polyProgress.secs;
  const patchUnitLabel =
    polyProgress.total === 1
      ? "fragment"
      : polyProgress.total < 5
        ? "fragmenty"
        : "fragmentów";
  const verifyUnitLabel =
    polyProgress.total === 1
      ? "partia"
      : polyProgress.total < 5
        ? "partie"
        : "partii";
  const polyLoadingText =
    polyProgress.phase === "verify"
      ? polyProgress.total > 0
        ? polyProgress.done === 0
          ? `Startuję weryfikację (${polyProgress.total} ${verifyUnitLabel})…`
          : `Weryfikacja ${polyProgress.done} / ${polyProgress.total} ${verifyUnitLabel}`
        : "Weryfikuję tłumaczenie…"
      : polyProgress.total > 0
        ? polyProgress.done === 0
          ? `Wysyłam ${polyProgress.total} ${patchUnitLabel}…`
          : `Przetworzono ${polyProgress.done} / ${polyProgress.total} ${patchUnitLabel}`
        : "Łączenie z API…";
  const currentChapterHref = (chapter?.href || "").split("#")[0];
  const tocItems = navigableTocItems(toc);

  if (!book && !chapterLoading) {
    return (
      <div className="loading-screen">
        <div style={{ color: "var(--red)" }}>Nie znaleziono książki.</div>
        <button className="btn-ghost" onClick={handleBackToLibrary}>
          ← Biblioteka
        </button>
      </div>
    );
  }

  return (
    <div className={`reader-layout ${toolbarVisible ? "" : "toolbar-hidden"}`}>
      {/* ── Sidebar ── */}
      <aside className={`sidebar ${sidebarOpen ? "open" : ""}`}>
        <div className="sb-top">
          <button className="btn-back" onClick={handleBackToLibrary}>
            ← Biblioteka
          </button>
          <div className="sb-cover">
            {book?.cover ? (
              <img src={book.cover} alt="okładka" />
            ) : (
              <span className="cover-ph">📖</span>
            )}
          </div>
          <div className="sb-title">{book?.title || "…"}</div>
          {book?.author && <div className="sb-author">{book.author}</div>}
          <div className="sb-stats">{chapterCount} rozdziałów</div>
        </div>
        <div className="toc-label">Spis treści</div>
        <div className="toc-scroll">
          <ul className="toc-list">
            {tocItems.map((item, i) => {
              const itemHref = (item.href || "").split("#")[0];
              const chIdx = hrefToIndex[itemHref] ?? -1;
              const status = chapterStatusMap[chIdx];
              const translationBadges = [...(status?.translationLangs || [])]
                .sort(
                  (a, b) =>
                    (LANGUAGE_ORDER.get(a) ?? Number.MAX_SAFE_INTEGER) -
                    (LANGUAGE_ORDER.get(b) ?? Number.MAX_SAFE_INTEGER),
                )
                .map(
                  (code) =>
                    LANGUAGE_META[code] || {
                      code,
                      flag: code.toUpperCase(),
                      name: code,
                    },
                );
              return (
                <li
                  key={itemHref || `${i}-${item.title || "toc"}`}
                  className="toc-item"
                >
                  <button
                    type="button"
                    className={`toc-entry toc-depth-${Math.min(item.depth ?? 0, 3)}${
                      currentChapterHref === itemHref ? " active" : ""
                    }`}
                    onClick={() => goToHref(itemHref)}
                  >
                    <span className="toc-entry-title">{item.title || "—"}</span>
                    {translationBadges.length > 0 && (
                      <span className="toc-badges">
                        {translationBadges.map((lang) => (
                          <span
                            key={`${itemHref}-${lang.code}`}
                            className="toc-bdg toc-bdg-tr"
                            title={`Tłumaczenie: ${lang.name}`}
                            aria-label={`Tłumaczenie: ${lang.name}`}
                          >
                            {lang.flag}
                          </span>
                        ))}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </aside>

      <div
        className={`sb-overlay ${sidebarOpen ? "open" : ""}`}
        onClick={() => setSidebarOpen(false)}
      />

      {/* ── Main content ── */}
      <div className="reader-main">
        {/* Top bar */}
        <div className="topbar">
          <button
            className="sb-tog-inline ctl ctl-icon"
            onClick={() => setSidebarOpen((s) => !s)}
            title="Spis treści"
          >
            ☰
          </button>
          <div className="tb-chapter">
            {chapter ? (
              <select
                className="tb-ver-select"
                value={activeLang ?? ""}
                onChange={(e) => {
                  switchToLang(e.target.value || null);
                }}
              >
                <option value="">
                  {`Rozdział ${(chapterIdx ?? 0) + 1}${chapter.title ? " · " + chapter.title : ""} — Oryginał`}
                </option>
                {cachedLangs.map((l) => (
                  <option key={l.code} value={l.code}>
                    {`Rozdział ${(chapterIdx ?? 0) + 1}${chapter.title ? " · " + chapter.title : ""} — ${l.name}`}
                  </option>
                ))}
              </select>
            ) : (
              ""
            )}
          </div>
          <div className="tb-controls">
            <button
              ref={settingsToggleRef}
              className={`ctl ctl-icon${settingsMenuOpen ? " ctl-active" : ""}`}
              onClick={() => setSettingsMenuOpen((v) => !v)}
              title="Ustawienia"
            >
              ⚙
            </button>
          </div>
        </div>

        {/* Settings dropdown */}
        {settingsMenuOpen && (
          <div className="settings-menu" ref={settingsMenuRef}>
            <div className="settings-menu-row">
              <span className="settings-menu-label">Czcionka</span>
              <div className="settings-menu-ctrl">
                <button
                  className="ctl"
                  onClick={() => setFs((f) => Math.max(13, f - 1))}
                >
                  A−
                </button>
                <span className="fs-val">{fs}</span>
                <button
                  className="ctl"
                  onClick={() => setFs((f) => Math.min(30, f + 1))}
                >
                  A+
                </button>
              </div>
            </div>
            <div className="settings-menu-row">
              <span className="settings-menu-label">Czytaj</span>
              <div className="settings-menu-ctrl">
                {polyMode && polyState === "done" ? (
                  <button
                    className="ctl ctl-icon"
                    onClick={toggleHybridTts}
                    title={
                      ttsPlaying ? (ttsPaused ? "Wznów" : "Pauza") : "Odtwórz"
                    }
                    disabled={!polyTtsParagraphs.length}
                  >
                    {ttsPlaying ? (ttsPaused ? "▶" : "⏸") : "▶"}
                  </button>
                ) : (
                  <button
                    className="ctl ctl-icon"
                    onClick={toggleOriginalTts}
                    title={
                      originalTtsPlaying
                        ? originalTtsPaused
                          ? "Wznów"
                          : "Pauza"
                        : "Odtwórz"
                    }
                    disabled={!originalTtsFragments.length}
                  >
                    {originalTtsPlaying ? (originalTtsPaused ? "▶" : "⏸") : "▶"}
                  </button>
                )}
              </div>
            </div>
            {!polyMode && chapter?.text && (
              <div className="settings-menu-row">
                <span className="settings-menu-label">Tłumacz</span>
                <div className="settings-menu-ctrl">
                  <button
                    className="ctl"
                    onClick={() => {
                      requestGenerate();
                      setSettingsMenuOpen(false);
                    }}
                  >
                    + Dodaj
                  </button>
                </div>
              </div>
            )}
            {polyMode &&
              polyState === "done" &&
              activeLang &&
              chapter?.text && (
                <div className="settings-menu-row">
                  <span className="settings-menu-label">Tłumaczenie</span>
                  <div className="settings-menu-ctrl">
                    <button
                      className="ctl"
                      onClick={regenerateCurrentTranslation}
                    >
                      Regeneruj
                    </button>
                  </div>
                </div>
              )}
            {(() => {
              const srcCode = (book?.lang || "en").split("-")[0].toLowerCase();
              const tgtCode = (activeLang || "es").split("-")[0].toLowerCase();
              const srcVoices = getVoicesForLang(ttsVoices, book?.lang || "en");
              const tgtVoices = getVoicesForLang(ttsVoices, activeLang || "es");
              const showVoiceNote =
                voiceLoadState !== "ready" ||
                !srcVoices.length ||
                (polyMode && !tgtVoices.length);
              return (
                <>
                  <div className="settings-menu-row">
                    <span className="settings-menu-label">
                      Głos ({srcCode})
                    </span>
                    <select
                      className="tts-voice-sel"
                      value={ttsSourceVoice}
                      disabled={!srcVoices.length}
                      onChange={(e) => {
                        const nextVoiceId = e.target.value;
                        setTtsSourceVoice(nextVoiceId);
                        localStorage.setItem(
                          `tts-voice-src-${srcCode}`,
                          nextVoiceId,
                        );
                        const nextVoice = findVoiceById(ttsVoices, nextVoiceId);
                        ttsPlayerRef.current?.setVoice(nextVoice);
                        originalTtsPlayerRef.current?.setVoice(nextVoice);
                      }}
                    >
                      <option value="">
                        {srcVoices.length ? "Domyślny" : "Systemowy"}
                      </option>
                      {srcVoices.map((v) => (
                        <option key={getVoiceId(v)} value={getVoiceId(v)}>
                          {v.name}
                        </option>
                      ))}
                    </select>
                  </div>

                  {polyMode && (
                    <div className="settings-menu-row">
                      <span className="settings-menu-label">
                        Głos ({tgtCode})
                      </span>
                      <select
                        className="tts-voice-sel"
                        value={ttsTargetVoice}
                        disabled={!tgtVoices.length}
                        onChange={(e) => {
                          setTtsTargetVoice(e.target.value);
                          localStorage.setItem(
                            `tts-voice-tgt-${tgtCode}`,
                            e.target.value,
                          );
                        }}
                      >
                        <option value="">
                          {tgtVoices.length ? "Domyślny" : "Systemowy"}
                        </option>
                        {tgtVoices.map((v) => (
                          <option key={getVoiceId(v)} value={getVoiceId(v)}>
                            {v.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                  {showVoiceNote && (
                    <div className="settings-menu-note">
                      {voiceLoadState === "unsupported"
                        ? "Ta przeglądarka nie udostępnia listy głosów Web Speech."
                        : voiceLoadState === "empty"
                          ? "Lista głosów jest pusta. Na mobilnym Chromium pojawia się to często, gdy system nie ma zainstalowanych danych TTS albo przeglądarka nie odsłoni jeszcze głosów."
                          : "Brak osobnych głosów dla tego języka. Przeglądarka użyje domyślnego głosu systemowego."}
                    </div>
                  )}
                </>
              );
            })()}
          </div>
        )}

        {/* Missing translation banner */}
        {missingLangBanner &&
          (() => {
            const langObj = LANGUAGES.find((l) => l.code === missingLangBanner);
            return (
              <div className="missing-lang-banner">
                <span>
                  Brak tłumaczenia {langObj?.flag}{" "}
                  {langObj?.label || missingLangBanner}
                </span>
                <div className="missing-lang-actions">
                  <button
                    className="btn-primary"
                    style={{ fontSize: 11, padding: "7px 16px" }}
                    onClick={() => {
                      setMissingLangBanner(null);
                      userChangedLangRef.current = true;
                      setConfirmLang(missingLangBanner);
                      setActiveLang(missingLangBanner);
                      setPolyState("confirm");
                    }}
                  >
                    Wygeneruj
                  </button>
                  <button
                    className="btn-ghost"
                    style={{ fontSize: 11, padding: "7px 16px" }}
                    onClick={() => setMissingLangBanner(null)}
                  >
                    Oryginał
                  </button>
                </div>
              </div>
            );
          })()}

        {/* Chapter page area */}
        <div className="ch-scroll" ref={chScrollRef}>
          <div className="ch-columns" ref={chInnerRef} key={animKeyRef.current}>
            <div className="ch-inner">
              {chapterLoading ? (
                <div className="poly-loading">
                  <div className="spin-ring" />
                </div>
              ) : !chapter ? (
                <div
                  style={{
                    color: "var(--txt-3)",
                    fontStyle: "italic",
                    fontSize: 14,
                  }}
                >
                  Nie można wczytać rozdziału.
                </div>
              ) : (
                <>
                  {polyMode && polyState === "confirm" && (
                    <div className="poly-confirm ch-anim">
                      <p className="poly-confirm-title">
                        Wybierz język tłumaczenia
                      </p>
                      <select
                        className="form-select"
                        value={confirmLang}
                        onChange={(e) => {
                          setConfirmLang(e.target.value);
                          setActiveLang(e.target.value);
                        }}
                        style={{ marginBottom: 12, alignSelf: "stretch" }}
                      >
                        {LANGUAGES.map((l) => (
                          <option key={l.code} value={l.code}>
                            {l.flag} {l.label} ({l.name})
                          </option>
                        ))}
                      </select>
                      <p className="poly-confirm-hint">
                        <strong>
                          {estimatedFragments}{" "}
                          {estimatedFragments === 1
                            ? "fragment"
                            : estimatedFragments < 5
                              ? "fragmenty"
                              : "fragmentów"}
                        </strong>
                        {" · ~"}
                        {estimatedSecs < 60
                          ? `${estimatedSecs}s`
                          : `${Math.round(estimatedSecs / 60)} min`}
                        {estimatedCost > 0 && (
                          <>
                            {" · ~$"}
                            {estimatedCost.toFixed(4)}
                          </>
                        )}
                      </p>
                      <p className="poly-confirm-hint">
                        Nie zamykaj strony i nie zmieniaj rozdziału.
                      </p>
                      <div className="poly-confirm-btns">
                        <button
                          className="btn-primary"
                          onClick={() => startGeneration()}
                        >
                          Generuj tłumaczenia
                        </button>
                        <button
                          className="btn-ghost"
                          onClick={() => {
                            setActiveLang(null);
                            setPolyState("idle");
                          }}
                        >
                          Anuluj
                        </button>
                      </div>
                    </div>
                  )}

                  {polyMode && polyState === "loading" && (
                    <div className="poly-loading">
                      <div className="spin-ring" />
                      <div className="poly-loading-text">{polyLoadingText}</div>
                      {polyProgress.total > 0 && (
                        <>
                          <div className="poly-progress-bar">
                            <div
                              className="poly-progress-fill"
                              style={{
                                width: `${(polyProgress.done / polyProgress.total) * 100}%`,
                              }}
                            />
                          </div>
                          <div className="poly-gen-stats">
                            {polyDisplaySecs > 0 && (
                              <span>{polyDisplaySecs.toFixed(1)}s</span>
                            )}
                            {polyProgress.cost > 0 ? (
                              <span>~${polyProgress.cost.toFixed(4)}</span>
                            ) : (
                              <span style={{ color: "var(--txt-3)" }}>
                                ~$0.00
                              </span>
                            )}
                          </div>
                        </>
                      )}
                      <p className="poly-loading-hint">
                        Nie zamykaj strony i nie zmieniaj rozdziału do końca
                        generowania.
                        {/*
                      Możesz zmienić rozdział — tekst zostanie zapisany w tle.
                      */}
                      </p>
                      <p className="poly-loading-hint">
                        Ekran pozostaje aktywny podczas generowania. Jesli API
                        utknie bez postepu, aplikacja automatycznie ponowi probe.
                      </p>
                      {polyRescueNote && (
                        <p
                          className="poly-loading-hint"
                          style={{ color: "var(--amber, #c09050)" }}
                        >
                          {polyRescueNote}
                        </p>
                      )}
                    </div>
                  )}

                  {polyMode && polyState === "error" && (
                    <div className="poly-error">
                      <div>⚠ {polyError}</div>
                      <button
                        className="btn-ghost"
                        onClick={() => {
                          setActiveLang(null);
                          setPolyState("idle");
                        }}
                      >
                        Wróć
                      </button>
                    </div>
                  )}

                  {polyMode && polyState === "done" && (
                    <div
                      key={activeLang}
                      ref={chapterBodyRef}
                      className={`ch-body ch-anim${polyWordFragments.length ? " tts-ready" : ""}${ttsPlaying ? " audio-ready" : ""}`}
                      dangerouslySetInnerHTML={{
                        __html: renderedPolyHtml,
                      }}
                      onClick={handleContentClick}
                    />
                  )}

                  {!polyMode && (
                    <div
                      ref={chapterBodyRef}
                      className={`ch-body ch-anim${originalTtsPlaying ? " audio-ready" : ""}`}
                      dangerouslySetInnerHTML={{
                        __html: originalHtmlAnnotated
                          ? originalHtmlAnnotated
                          : chapter.html ||
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

        {/* Bottom navigation — TTS controls replace page counter when playing */}
        <div className="bottombar">
          <button
            className="nav-btn"
            onClick={prevPage}
            disabled={currentPage === 0 && (chapterIdx ?? 0) === 0}
          >
            ←
          </button>

          {originalTtsPlaying ? (
            <div className="tts-inline">
              <button
                className="tts-bar-btn"
                onClick={() => jumpSentence(-1)}
                disabled={activeSid <= 0}
                title="Poprzedni akapit"
              >
                ⏮
              </button>
              <button
                className="tts-bar-btn tts-bar-play active"
                onClick={toggleOriginalTts}
                title={originalTtsPaused ? "Wznów" : "Pauza"}
              >
                {originalTtsPaused ? "▶" : "⏸"}
              </button>
              <button
                className="tts-bar-btn"
                onClick={stopOriginalTts}
                title="Zakończ TTS"
              >
                ⏹
              </button>
              <button
                className="tts-bar-btn"
                onClick={() => jumpSentence(1)}
                disabled={activeSid >= originalTtsFragments.length - 1}
                title="Następny akapit"
              >
                ⏭
              </button>
            </div>
          ) : ttsPlaying ? (
            <div className="tts-inline">
              <button
                className="tts-bar-btn"
                onClick={() => jumpPolyParagraph(-1)}
                disabled={activePolyPid <= 0}
                title="Poprzedni akapit"
              >
                ⏮
              </button>
              <button
                className="tts-bar-btn tts-bar-play active"
                onClick={toggleHybridTts}
                title={ttsPaused ? "Wznów" : "Pauza"}
              >
                {ttsPaused ? "▶" : "⏸"}
              </button>
              <button
                className="tts-bar-btn"
                onClick={stopHybridTts}
                title="Zakończ TTS"
              >
                ⏹
              </button>
              <button
                className="tts-bar-btn"
                onClick={() => jumpPolyParagraph(1)}
                disabled={activePolyPid >= polyTtsParagraphs.length - 1}
                title="Następny akapit"
              >
                ⏭
              </button>
            </div>
          ) : (
            <div className="prog-wrap">
              <div className="prog-lbl">
                {currentPage + 1}/{totalPages}
              </div>
            </div>
          )}

          <button
            className="nav-btn"
            onClick={nextPage}
            disabled={
              currentPage >= totalPages - 1 &&
              (chapterIdx ?? 0) >= chapterCount - 1
            }
          >
            →
          </button>
        </div>
      </div>
    </div>
  );
}
