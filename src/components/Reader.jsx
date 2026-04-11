import {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from "react";
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
import { triggerSync, syncBook } from "../sync/cfSync";
import { parseStoredPolyglot } from "../lib/polyglotParser";
import { annotateParagraphsInHtml } from "../lib/sentenceWrapper";
import { extractPolyglotTtsData, SentenceTtsPlayer } from "../lib/ttsFragments";

const LANGUAGE_META = Object.fromEntries(
  LANGUAGES.map((lang) => [lang.code, lang]),
);
const LANGUAGE_ORDER = new Map(
  LANGUAGES.map((lang, index) => [lang.code, index]),
);
const SEARCH_BLOCK_SELECTOR = "p, h1, h2, h3, h4, h5, h6, li";
const FONT_SIZE_MIN = 13;
const FONT_SIZE_MAX = 30;

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
  delete pw.dataset.tooltipPending;
}

function normalizeInlineText(value) {
  return (value || "").replace(/\s+/g, " ").trim();
}

function buildSearchSnippet(text, query) {
  const normalizedText = normalizeInlineText(text);
  const normalizedQuery = normalizeInlineText(query).toLowerCase();
  if (!normalizedText || !normalizedQuery) return normalizedText;

  const idx = normalizedText.toLowerCase().indexOf(normalizedQuery);
  if (idx === -1) return normalizedText.slice(0, 120);

  const start = Math.max(0, idx - 36);
  const end = Math.min(
    normalizedText.length,
    idx + normalizedQuery.length + 56,
  );
  return `${start > 0 ? "..." : ""}${normalizedText.slice(start, end)}${
    end < normalizedText.length ? "..." : ""
  }`;
}

function getBookmarkPageIndex(bookmark, totalPages) {
  if (!totalPages || totalPages <= 1) return 0;
  return Math.max(
    0,
    Math.min(
      totalPages - 1,
      Math.round((bookmark?.progress ?? 0) * (totalPages - 1)),
    ),
  );
}

function formatBookmarkPage(bookmark) {
  if (
    Number.isFinite(bookmark?.page) &&
    Number.isFinite(bookmark?.totalPages) &&
    bookmark.totalPages > 0
  ) {
    return `${bookmark.page + 1}/${bookmark.totalPages}`;
  }
  return `${Math.round(((bookmark?.progress ?? 0) + Number.EPSILON) * 100)}%`;
}

function isShortcutTargetBlocked(target) {
  return (
    target instanceof Element &&
    Boolean(
      target.closest(
        'input, textarea, select, button, [contenteditable="true"], [role="textbox"]',
      ),
    )
  );
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
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchMatches, setSearchMatches] = useState([]);
  const [activeSearchIdx, setActiveSearchIdx] = useState(0);
  const searchLayoutMode = searchOpen
    ? searchQuery.trim()
      ? "expanded"
      : "compact"
    : "closed";
  const [bookmarkMenuOpen, setBookmarkMenuOpen] = useState(false);
  const [bookmarks, setBookmarks] = useState([]);
  const [settingsMenuOpen, setSettingsMenuOpen] = useState(false);
  const [fs, setFs] = useState(settings.fontSize ?? 19);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(
    () => typeof document !== "undefined" && Boolean(document.fullscreenElement),
  );
  const orderedCachedLangs = useMemo(
    () =>
      [...cachedLangs].sort(
        (a, b) =>
          (LANGUAGE_ORDER.get(a.code) ?? Number.MAX_SAFE_INTEGER) -
          (LANGUAGE_ORDER.get(b.code) ?? Number.MAX_SAFE_INTEGER),
      ),
    [cachedLangs],
  );
  const tooltipClickEnabled = true;

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
  const scrollRetryTokenRef = useRef(0); // incremented each layout to cancel stale retries
  const prevSearchLayoutModeRef = useRef(searchLayoutMode);
  const flippingRef = useRef(false);
  const pageTurnTimerRef = useRef(null);
  const desiredLangRef = useRef(null); // lang to carry over when changing chapter
  const originalTtsPlayerRef = useRef(null);
  const ttsAutoStartRef = useRef(null); // 'original' | 'hybrid' | null
  const searchInputRef = useRef(null);
  const bookmarkMenuRef = useRef(null);
  const bookmarkToggleRef = useRef(null);
  const settingsMenuRef = useRef(null);
  const settingsToggleRef = useRef(null);
  const readerLayoutRef = useRef(null);
  const modifierTapRef = useRef({ Shift: false });
  const ttsPagePauseModeRef = useRef(null);

  useWakeLock(Boolean(bookId));

  useEffect(() => {
    setFs(settings.fontSize ?? 19);
  }, [settings.fontSize]);

  useEffect(() => {
    function handleFullscreenChange() {
      setIsFullscreen(Boolean(document.fullscreenElement));
    }

    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () =>
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, []);

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

  const queuePaginationRelayout = useCallback(() => {
    if (!chapter?.id) return;
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
  }, [chapter?.id]);

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
      setBookmarks(pos?.bookmarks ?? []);
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
    setSearchQuery("");
    setSearchMatches([]);
    setActiveSearchIdx(0);
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

        let finalPage;
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
          } else {
            // total=1 but we have pending progress: the multi-column layout
            // may not have been computed yet (iOS Safari lazy compositing).
            // Schedule a fallback re-layout after the animation frame budget.
            const token = ++scrollRetryTokenRef.current;
            setTimeout(() => {
              if (scrollRetryTokenRef.current === token && pendingProgressRef.current !== null) {
                setLayoutKey((k) => k + 1);
              }
            }, 250);
          }
          setCurrentPage(targetPage);
          currentPageRef.current = targetPage;
          inner.style.transition = "";
          // Pass pw so scrollLeft uses the same column width that was applied
          // in the first rAF — avoids mismatch if clientWidth changed meanwhile.
          syncPageViewport(targetPage, pw);
          finalPage = targetPage;
        } else {
          // Re-layout only (font change or polyMode switch) — keep current page
          const cur = Math.min(currentPageRef.current, total - 1);
          if (cur !== currentPageRef.current) {
            setCurrentPage(cur);
            currentPageRef.current = cur;
          }
          inner.style.transition = "";
          syncPageViewport(cur, pw);
          finalPage = cur;
        }

        // Retry loop: iOS Safari can silently clamp scrollLeft to 0 when the
        // compositing layer (will-change:transform) hasn't settled yet, or when
        // scrollWidth was wrong (total=1 scenario above).  Re-apply up to 8
        // frames (~133ms) until the value sticks or the user navigates away.
        const expectedLeft = Math.max(0, finalPage) * pw;
        const retryToken = ++scrollRetryTokenRef.current;
        let attempts = 8;
        const retryScroll = () => {
          if (!attempts-- || scrollRetryTokenRef.current !== retryToken) return;
          const c = chScrollRef.current;
          if (!c || currentPageRef.current !== finalPage) return;
          if (Math.abs(c.scrollLeft - expectedLeft) > 2) {
            c.scrollLeft = expectedLeft;
            requestAnimationFrame(retryScroll);
          }
        };
        requestAnimationFrame(retryScroll);
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
      queuePaginationRelayout();
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [queuePaginationRelayout]);

  useEffect(() => {
    let rafId = 0;
    let settleTimer = 0;
    const viewport = window.visualViewport;

    const scheduleRelayout = (withSettlePass = false) => {
      if (!rafId) {
        rafId = window.requestAnimationFrame(() => {
          rafId = 0;
          queuePaginationRelayout();
        });
      }
      if (!withSettlePass) return;
      if (settleTimer) {
        window.clearTimeout(settleTimer);
      }
      // Mobile browsers often finish resizing a moment after orientationchange.
      settleTimer = window.setTimeout(() => {
        settleTimer = 0;
        queuePaginationRelayout();
      }, 180);
    };

    const handleResize = () => scheduleRelayout();
    const handleOrientationChange = () => scheduleRelayout(true);

    window.addEventListener("resize", handleResize);
    window.addEventListener("orientationchange", handleOrientationChange);
    viewport?.addEventListener("resize", handleResize);

    return () => {
      if (rafId) {
        window.cancelAnimationFrame(rafId);
      }
      if (settleTimer) {
        window.clearTimeout(settleTimer);
      }
      window.removeEventListener("resize", handleResize);
      window.removeEventListener("orientationchange", handleOrientationChange);
      viewport?.removeEventListener("resize", handleResize);
    };
  }, [queuePaginationRelayout]);

  useEffect(() => {
    if (prevSearchLayoutModeRef.current === searchLayoutMode) return;
    prevSearchLayoutModeRef.current = searchLayoutMode;

    const rafId = window.requestAnimationFrame(() => {
      queuePaginationRelayout();
    });
    return () => window.cancelAnimationFrame(rafId);
  }, [searchLayoutMode, queuePaginationRelayout]);

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

  const getElementPage = useCallback((element) => {
    const scrollEl = chScrollRef.current;
    if (!scrollEl || !element) return 0;

    const pw = scrollEl.clientWidth || 1;
    const containerRect = scrollEl.getBoundingClientRect();
    const elementRect = element.getBoundingClientRect();
    const absoluteLeft =
      elementRect.left - containerRect.left + scrollEl.scrollLeft;

    return Math.max(
      0,
      Math.min(totalPagesRef.current - 1, Math.floor(absoluteLeft / pw)),
    );
  }, []);

  const getPagePreview = useCallback(
    (page = currentPageRef.current) => {
      const body = chapterBodyRef.current;
      if (!body) return "";

      const blocks = [...body.querySelectorAll(SEARCH_BLOCK_SELECTOR)];
      for (const block of blocks) {
        if (block.closest(".pw-original")) continue;
        const text = normalizeInlineText(block.textContent || "");
        if (!text) continue;
        if (getElementPage(block) === page) return text.slice(0, 140);
      }

      return "";
    },
    [getElementPage],
  );

  const persistBookmarks = useCallback(
    async (nextBookmarks) => {
      if (!bookId || chapterIdxRef.current === null || chapterIdxRef.current === undefined) {
        return;
      }

      setBookmarks(nextBookmarks);
      await saveReadingPosition(
        bookId,
        chapterIdxRef.current,
        getCurrentProgress(),
        activeLangRef.current,
        { bookmarks: nextBookmarks },
      );

      if (isLoggedIn()) {
        void syncBook(bookId);
      }
    },
    [bookId, getCurrentProgress],
  );

  const clearSearchHighlights = useCallback(() => {
    const body = chapterBodyRef.current;
    if (!body) return;

    body
      .querySelectorAll(".search-hit-block, .search-hit-active")
      .forEach((el) =>
        el.classList.remove("search-hit-block", "search-hit-active"),
      );
    body
      .querySelectorAll("[data-search-block-id]")
      .forEach((el) => el.removeAttribute("data-search-block-id"));
  }, []);

  /* ── Re-sync viewport when app returns from background (visibilitychange / pageshow) ──
     On mobile browsers (especially iOS Safari) scrollLeft on overflow:hidden elements
     can be silently reset to 0 when the PWA is backgrounded and then brought back.
     Re-trigger a full layout so position is correctly restored from refs.          ── */
  useEffect(() => {
    const resync = () => {
      if (document.hidden) return;
      queuePaginationRelayout();
    };
    document.addEventListener("visibilitychange", resync);
    // pageshow fires on bfcache restore (iOS Safari back-navigation)
    window.addEventListener("pageshow", resync);
    return () => {
      document.removeEventListener("visibilitychange", resync);
      window.removeEventListener("pageshow", resync);
    };
  }, [queuePaginationRelayout]);

  useEffect(() => {
    function handleSynced() {
      if (!bookId) return;
      getReadingPosition(bookId).then((pos) => {
        setBookmarks(pos?.bookmarks ?? []);
      });
    }

    window.addEventListener("vocabapp:synced", handleSynced);
    return () => window.removeEventListener("vocabapp:synced", handleSynced);
  }, [bookId]);

  useEffect(() => {
    if (!searchOpen) return;
    const timer = window.setTimeout(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [searchOpen, chapter?.id, activeLang]);

  useEffect(() => {
    clearSearchHighlights();

    const normalizedQuery = normalizeInlineText(searchQuery);
    if (!searchOpen || !normalizedQuery) {
      setSearchMatches([]);
      setActiveSearchIdx(0);
      return;
    }

    const body = chapterBodyRef.current;
    if (!body) {
      setSearchMatches([]);
      setActiveSearchIdx(0);
      return;
    }

    const nextMatches = [];
    let blockId = 0;
    for (const block of body.querySelectorAll(SEARCH_BLOCK_SELECTOR)) {
      if (block.closest(".pw-original")) continue;

      const text = normalizeInlineText(block.textContent || "");
      if (!text) continue;

      const lowerText = text.toLowerCase();
      const lowerQuery = normalizedQuery.toLowerCase();
      const firstIdx = lowerText.indexOf(lowerQuery);
      if (firstIdx === -1) continue;

      let count = 0;
      let scanIdx = firstIdx;
      while (scanIdx !== -1) {
        count += 1;
        scanIdx = lowerText.indexOf(lowerQuery, scanIdx + lowerQuery.length);
      }

      const blockKey = String(blockId++);
      block.dataset.searchBlockId = blockKey;
      block.classList.add("search-hit-block");
      nextMatches.push({
        blockId: blockKey,
        count,
        page: getElementPage(block),
        preview: buildSearchSnippet(text, normalizedQuery),
      });
    }

    setSearchMatches(nextMatches);
    setActiveSearchIdx((current) => {
      if (!nextMatches.length) return 0;
      return Math.min(current, nextMatches.length - 1);
    });
  }, [
    searchOpen,
    searchQuery,
    chapter?.id,
    renderedPolyHtml,
    originalHtmlAnnotated,
    getElementPage,
    clearSearchHighlights,
  ]);

  useEffect(() => {
    const body = chapterBodyRef.current;
    if (!body) return;

    body
      .querySelectorAll(".search-hit-active")
      .forEach((el) => el.classList.remove("search-hit-active"));

    const activeMatch = searchMatches[activeSearchIdx];
    if (!activeMatch) return;

    body
      .querySelector(`[data-search-block-id="${activeMatch.blockId}"]`)
      ?.classList.add("search-hit-active");
  }, [searchMatches, activeSearchIdx, currentPage]);

  /* ── Keep activeLangRef in sync; save position only on explicit user lang switch ── */

  useEffect(() => {
    activeLangRef.current = activeLang;
    if (!bookId || !userChangedLangRef.current) return;
    userChangedLangRef.current = false;
    void persistPosition({ immediate: true, activeLang });
  }, [activeLang, bookId, persistPosition]);

  /* ── Page navigation with Kindle flash ── */
  function goToPage(page, options = {}) {
    const { animate = true, pauseTts = false } =
      typeof options === "boolean" ? { animate: options } : options;
    const inner = chInnerRef.current;
    const container = chScrollRef.current;
    if (!inner || !container) return;
    const total = totalPagesRef.current;
    const clampedPage = Math.max(0, Math.min(page, total - 1));

    clearPageTurnState();
    if (pauseTts) pauseTtsForManualPageTurn();

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
    goToPage(currentPageRef.current - 1, { pauseTts: true });
  }
  function nextPage() {
    if (currentPageRef.current >= totalPagesRef.current - 1) {
      if ((chapterIdx ?? 0) >= chapterCount - 1) return;
      navigate((chapterIdx ?? 0) + 1);
      return;
    }
    goToPage(currentPageRef.current + 1, { pauseTts: true });
  }

  function goToSearchMatch(index) {
    if (!searchMatches.length) return;
    const nextIndex =
      ((index % searchMatches.length) + searchMatches.length) %
      searchMatches.length;
    const match = searchMatches[nextIndex];
    const target = chapterBodyRef.current?.querySelector(
      `[data-search-block-id="${match.blockId}"]`,
    );

    if (target) {
      goToPage(getElementPage(target), { animate: false, pauseTts: true });
    }

    setActiveSearchIdx(nextIndex);
  }

  async function addBookmark() {
    if (!bookId || chapterIdx === null) return;

    const now = Date.now();
    const page = currentPageRef.current;
    const currentProgress = getCurrentProgress();
    const currentPageBookmark = bookmarks.find(
      (bookmark) =>
        !bookmark.deletedAt &&
        bookmark.chapterIndex === chapterIdx &&
        getBookmarkPageIndex(bookmark, totalPagesRef.current) === page,
    );

    const nextBookmark = {
      id:
        currentPageBookmark?.id ||
        (globalThis.crypto?.randomUUID?.() ??
          `${bookId}-${chapterIdx}-${page}-${now}`),
      chapterIndex: chapterIdx,
      chapterTitle: chapterLabel,
      progress: currentProgress,
      page,
      totalPages: totalPagesRef.current,
      preview: getPagePreview(page),
      createdAt: currentPageBookmark?.createdAt ?? now,
      updatedAt: now,
      deletedAt: null,
    };

    const nextBookmarks = currentPageBookmark
      ? bookmarks.map((bookmark) =>
          bookmark.id === currentPageBookmark.id ? nextBookmark : bookmark,
        )
      : [...bookmarks, nextBookmark];

    await persistBookmarks(nextBookmarks);
    setBookmarkMenuOpen(false);
  }

  async function removeBookmark(bookmarkId) {
    const now = Date.now();
    const nextBookmarks = bookmarks.map((bookmark) =>
      bookmark.id === bookmarkId
        ? { ...bookmark, deletedAt: now, updatedAt: now }
        : bookmark,
    );

    await persistBookmarks(nextBookmarks);
  }

  function jumpToBookmark(bookmark) {
    if (!bookmark) return;

    if (bookmark.chapterIndex === chapterIdx) {
      goToPage(getBookmarkPageIndex(bookmark, totalPagesRef.current), {
        animate: false,
        pauseTts: true,
      });
      void persistPosition({ immediate: true, progress: bookmark.progress });
    } else {
      navigate(bookmark.chapterIndex, { progressOverride: bookmark.progress });
    }

    setBookmarkMenuOpen(false);
    setSearchOpen(false);
  }

  /* ── Font size sync ── */
  useEffect(() => {
    document.documentElement.style.setProperty("--fs", fs + "px");
  }, [fs]);

  /* ── Keyboard navigation ── */
  useEffect(() => {
    function clearModifierTap(exceptKey = "") {
      if (exceptKey !== "Shift") modifierTapRef.current.Shift = false;
    }

    function onKey(e) {
      if (isShortcutTargetBlocked(e.target)) return;

      const isStandaloneShift =
        !e.repeat && e.key === "Shift" && !e.altKey && !e.metaKey && !e.ctrlKey;
      if (isStandaloneShift) {
        modifierTapRef.current.Shift = true;
        return;
      }

      clearModifierTap(e.key);

      if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault();
        prevPage();
        return;
      }

      if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        e.preventDefault();
        nextPage();
        return;
      }

      if (e.key === "Escape") {
        setSidebarOpen(false);
        setSearchOpen(false);
        setBookmarkMenuOpen(false);
        setSettingsMenuOpen(false);
        setShortcutsOpen(false);
        return;
      }

      if (e.key === "Backspace") {
        e.preventDefault();
        void handleBackToLibrary();
        return;
      }

      if (e.code === "Space" || e.key === " ") {
        e.preventDefault();
        toggleCurrentTts();
        return;
      }

      if (e.key === "," || e.key === "<") {
        e.preventDefault();
        jumpCurrentTts(-1);
        return;
      }

      if (e.key === "." || e.key === ">") {
        e.preventDefault();
        jumpCurrentTts(1);
        return;
      }

      if (e.key === "{" || e.key === "[") {
        e.preventDefault();
        changeFontSize(-1);
        return;
      }

      if (e.key === "}" || e.key === "]") {
        e.preventDefault();
        changeFontSize(1);
        return;
      }

      if (e.ctrlKey || e.metaKey || e.altKey) return;

      if (e.key === "?") {
        e.preventDefault();
        openShortcutsPanel();
        return;
      }

      switch (e.key.toLowerCase()) {
        case "j":
          e.preventDefault();
          openSearchPanel();
          break;
        case "z":
          e.preventDefault();
          openBookmarksPanel();
          break;
        case "n":
          e.preventDefault();
          nextChapterDirect();
          break;
        case "p":
          e.preventDefault();
          prevChapter();
          break;
        case "q":
          e.preventDefault();
          setSidebarOpen((open) => !open);
          break;
        case "f":
          e.preventDefault();
          void toggleFullscreen();
          break;
        default:
          break;
      }
    }

    function onKeyUp(e) {
      if (isShortcutTargetBlocked(e.target)) return;

      if (e.key === "Shift") {
        const shouldCycle = modifierTapRef.current.Shift;
        modifierTapRef.current.Shift = false;
        if (shouldCycle) {
          e.preventDefault();
          cycleChapterVersion();
        }
      }
    }

    function resetModifierTap() {
      clearModifierTap();
    }

    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", resetModifierTap);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", resetModifierTap);
    };
  }, [
    activeLang,
    changeFontSize,
    chapterCount,
    chapterIdx,
    cycleChapterVersion,
    handleBackToLibrary,
    nextPage,
    nextChapterDirect,
    openBookmarksPanel,
    openSearchPanel,
    openShortcutsPanel,
    orderedCachedLangs,
    polyMode,
    polyState,
    prevPage,
    prevChapter,
    jumpCurrentTts,
    toggleCurrentTts,
    toggleFullscreen,
  ]);

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

  useEffect(() => {
    if (!bookmarkMenuOpen) return;
    function onOutside(e) {
      if (
        bookmarkMenuRef.current &&
        !bookmarkMenuRef.current.contains(e.target) &&
        bookmarkToggleRef.current &&
        !bookmarkToggleRef.current.contains(e.target)
      ) {
        setBookmarkMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, [bookmarkMenuOpen]);

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
    pendingProgressRef.current = getCurrentProgress();
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

  function changeFontSize(delta) {
    setFs((current) => {
      const next = Math.max(
        FONT_SIZE_MIN,
        Math.min(FONT_SIZE_MAX, current + delta),
      );
      if (next !== current) {
        void onUpdateSetting?.("fontSize", next);
      }
      return next;
    });
  }

  function openSearchPanel() {
    setSearchOpen(true);
    setBookmarkMenuOpen(false);
    setSettingsMenuOpen(false);
    setShortcutsOpen(false);
    window.setTimeout(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    }, 0);
  }

  function openBookmarksPanel() {
    setBookmarkMenuOpen(true);
    setSearchOpen(false);
    setSettingsMenuOpen(false);
    setShortcutsOpen(false);
  }

  function openShortcutsPanel() {
    setShortcutsOpen(true);
    setSearchOpen(false);
    setBookmarkMenuOpen(false);
    setSettingsMenuOpen(false);
  }

  function handlePageSliderChange(e) {
    const nextPage = Number(e.target.value);
    if (!Number.isFinite(nextPage)) return;
    goToPage(nextPage, { animate: false });
    void persistPosition();
  }

  function handlePageSliderCommit() {
    void persistPosition({ immediate: true });
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
    if (tooltipClickEnabled) {
      openTooltip(el, true);
    }
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
    ttsPagePauseModeRef.current =
      ttsPagePauseModeRef.current === "hybrid" ? null : ttsPagePauseModeRef.current;
    setTtsPlaying(false);
    setTtsPaused(false);
    setActivePolyPid(-1);
    clearSentenceHighlight();
    clearWordHighlight();
  }

  function stopOriginalTts() {
    originalTtsPlayerRef.current?.stop();
    originalTtsPlayerRef.current = null;
    ttsPagePauseModeRef.current =
      ttsPagePauseModeRef.current === "original" ? null : ttsPagePauseModeRef.current;
    setOriginalTtsPlaying(false);
    setOriginalTtsPaused(false);
    setActiveSid(-1);
    activeSidRef.current = -1;
    clearSentenceHighlight();
  }

  function stopAllTts() {
    stopOriginalTts();
    stopHybridTts();
    ttsPagePauseModeRef.current = null;
    window.speechSynthesis?.cancel();
  }

  function pauseTtsForManualPageTurn() {
    if (originalTtsPlaying || originalTtsPaused) {
      originalTtsPlayerRef.current?.pause();
      setOriginalTtsPaused(true);
      ttsPagePauseModeRef.current = "original";
      return;
    }

    if (ttsPlaying || ttsPaused) {
      ttsPlayerRef.current?.pause();
      setTtsPaused(true);
      ttsPagePauseModeRef.current = "hybrid";
    }
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
    ttsPagePauseModeRef.current = null;

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
      ttsPagePauseModeRef.current = null;
      startOriginalTts(getFirstSidOnCurrentPage());
      return;
    }

    if (ttsPagePauseModeRef.current === "original") {
      ttsPagePauseModeRef.current = null;
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
    ttsPagePauseModeRef.current = null;
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
      ttsPagePauseModeRef.current = null;
      startHybridTts(getFirstSidOnCurrentPage());
      return;
    }

    if (ttsPagePauseModeRef.current === "hybrid") {
      ttsPagePauseModeRef.current = null;
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

  function toggleCurrentTts() {
    if (polyMode) {
      if (polyState === "done") toggleHybridTts();
      return;
    }
    toggleOriginalTts();
  }

  function jumpCurrentTts(delta) {
    if (ttsPagePauseModeRef.current === "original") {
      const base = getFirstSidOnCurrentPage();
      startOriginalTts(
        Math.max(
          0,
          Math.min(originalTtsFragments.length - 1, base + delta),
        ),
      );
      return;
    }

    if (ttsPagePauseModeRef.current === "hybrid") {
      const base = getFirstSidOnCurrentPage();
      startHybridTts(
        Math.max(
          0,
          Math.min(polyTtsParagraphs.length - 1, base + delta),
        ),
      );
      return;
    }

    if (originalTtsPlaying || originalTtsPaused) {
      jumpSentence(delta);
      return;
    }
    if (ttsPlaying || ttsPaused) {
      jumpPolyParagraph(delta);
    }
  }

  function prevChapter() {
    if (chapterIdx === null || chapterIdx <= 0) return;
    navigate(chapterIdx - 1);
  }

  function nextChapterDirect() {
    if (chapterIdx === null || chapterIdx >= chapterCount - 1) return;
    navigate(chapterIdx + 1);
  }

  function cycleChapterVersion() {
    const versionCodes = [null, ...orderedCachedLangs.map((lang) => lang.code)];
    if (versionCodes.length < 2) return;

    const currentIdx = versionCodes.indexOf(activeLang);
    const baseIdx = currentIdx >= 0 ? currentIdx : 0;
    const nextLang = versionCodes[(baseIdx + 1) % versionCodes.length];
    switchToLang(nextLang);
  }

  async function toggleFullscreen() {
    const target = readerLayoutRef.current || document.documentElement;
    if (!document.fullscreenElement && !target?.requestFullscreen) return;

    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await target.requestFullscreen?.();
      }
    } catch {
      // Ignore browser fullscreen permission/state errors.
    }
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
    pw.dataset.tooltipPending = "true";

    const applyPosition = () => {
      if (!pw.isConnected || !pw.classList.contains("open")) return true;

      const viewportRect = scrollEl.getBoundingClientRect();
      const pwRect = pw.getBoundingClientRect();
      const tooltipRect = tooltip.getBoundingClientRect();
      if (!tooltipRect.width || !tooltipRect.height) return false;

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
      delete pw.dataset.tooltipPending;
      return true;
    };

    if (applyPosition()) return;

    window.requestAnimationFrame(() => {
      if (applyPosition()) return;
      delete pw.dataset.tooltipPending;
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
        if (tooltipClickEnabled) {
          openTooltip(pw);
        }
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
  const chapterLabel =
    chapter?.title?.trim() || `Rozdzia\u0142 ${(chapterIdx ?? 0) + 1}`;
  const visibleBookmarks = useMemo(
    () => bookmarks.filter((bookmark) => !bookmark.deletedAt),
    [bookmarks],
  );
  const currentPageBookmarks = useMemo(
    () =>
      visibleBookmarks.filter(
        (bookmark) =>
          bookmark.chapterIndex === chapterIdx &&
          getBookmarkPageIndex(bookmark, totalPages) === currentPage,
      ),
    [visibleBookmarks, chapterIdx, totalPages, currentPage],
  );
  const hasCurrentPageBookmark = currentPageBookmarks.length > 0;
  const bookmarkList = useMemo(
    () =>
      [...visibleBookmarks].sort((a, b) => {
        if (a.chapterIndex !== b.chapterIndex) {
          return a.chapterIndex - b.chapterIndex;
        }
        if (a.progress !== b.progress) return a.progress - b.progress;
        return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
      }),
    [visibleBookmarks],
  );
  const currentChapterHref = (chapter?.href || "").split("#")[0];
  const tocItems = navigableTocItems(toc);
  const ttsButtonTitle =
    polyMode && polyState === "done"
      ? ttsPlaying
        ? ttsPaused
          ? "Wznów czytanie"
          : "Zatrzymaj czytanie"
        : "Odtwórz TTS"
      : originalTtsPlaying
        ? originalTtsPaused
          ? "Wznów czytanie"
          : "Zatrzymaj czytanie"
        : "Odtwórz TTS";
  const ttsButtonLabel =
    polyMode && polyState === "done"
      ? ttsPlaying
        ? ttsPaused
          ? "Wznów"
          : "Pauza"
        : "Play"
      : originalTtsPlaying
        ? originalTtsPaused
          ? "Wznów"
          : "Pauza"
        : "Play";
  const ttsButtonIcon =
    polyMode && polyState === "done"
      ? ttsPlaying
        ? ttsPaused
          ? ">"
          : "||"
        : ">"
      : originalTtsPlaying
        ? originalTtsPaused
          ? ">"
          : "||"
        : ">";
  const hasTtsAvailable =
    polyMode && polyState === "done"
      ? polyTtsParagraphs.length > 0
      : originalTtsFragments.length > 0;

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
    <div
      ref={readerLayoutRef}
      className={`reader-layout ${toolbarVisible ? "" : "toolbar-hidden"}`}
    >
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
                <option value="">{`${chapterLabel} \u2014 Orygina\u0142`}</option>
                {orderedCachedLangs.map((l) => (
                  <option key={`display-${l.code}`} value={l.code}>
                    {`${chapterLabel} \u2014 ${l.name}`}
                  </option>
                ))}
              </select>
            ) : null}
            {false ? (
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
              onClick={() => {
                setSettingsMenuOpen((v) => !v);
                setSearchOpen(false);
                setBookmarkMenuOpen(false);
                setShortcutsOpen(false);
              }}
              title="Ustawienia"
            >
              ⚙
            </button>
          </div>
        </div>

        {searchOpen && (
          <div className="reader-search-strip">
            <div className="reader-search-main">
              <input
                ref={searchInputRef}
                className="reader-search-input"
                type="search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    if (!searchMatches.length) return;
                    goToSearchMatch(
                      activeSearchIdx + (e.shiftKey ? -1 : 1),
                    );
                  }
                }}
                placeholder="Szukaj tekstu w tym rozdziale"
              />
              <div className="reader-search-meta">
                {searchQuery.trim()
                  ? searchMatches.length
                    ? `${activeSearchIdx + 1}/${searchMatches.length}`
                    : "0 wynikow"
                  : "Wpisz fraze"}
              </div>
              <button
                className="ctl ctl-icon"
                onClick={() => goToSearchMatch(activeSearchIdx - 1)}
                disabled={!searchMatches.length}
                title="Poprzedni wynik"
              >
                {"<"}
              </button>
              <button
                className="ctl ctl-icon"
                onClick={() => goToSearchMatch(activeSearchIdx + 1)}
                disabled={!searchMatches.length}
                title="Nastepny wynik"
              >
                {">"}
              </button>
              <button
                className="ctl ctl-icon"
                onClick={() => setSearchOpen(false)}
                title="Zamknij wyszukiwanie"
              >
                x
              </button>
            </div>

            {searchQuery.trim() && (
              <div className="reader-search-results">
                {searchMatches.length ? (
                  searchMatches.map((match, index) => (
                    <button
                      key={`${match.blockId}-${index}`}
                      type="button"
                      className={`reader-search-result${
                        index === activeSearchIdx ? " active" : ""
                      }`}
                      onClick={() => goToSearchMatch(index)}
                    >
                      <span className="reader-search-result-page">
                        s. {match.page + 1}
                      </span>
                      <span className="reader-search-result-text">
                        {match.preview}
                      </span>
                      {match.count > 1 && (
                        <span className="reader-search-result-count">
                          x{match.count}
                        </span>
                      )}
                    </button>
                  ))
                ) : (
                  <div className="reader-search-empty">
                    Brak trafien w tym rozdziale.
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {bookmarkMenuOpen && (
          <div className="bookmark-menu" ref={bookmarkMenuRef}>
            <div className="bookmark-menu-head">
              <div>
                <div className="bookmark-menu-title">Zakladki</div>
                <div className="bookmark-menu-sub">
                  Zapisz biezaca strone i zsynchronizuj ja z kontem.
                </div>
              </div>
            </div>

            <button
              type="button"
              className={`bookmark-save-btn${hasCurrentPageBookmark ? " active" : ""}`}
              onClick={() => addBookmark()}
              title="Zapisz zakladke"
            >
              <span className="bookmark-save-btn-label">
                {hasCurrentPageBookmark
                  ? "Zapisano te strone"
                  : "Zapisz zakladke"}
              </span>
              <span className="bookmark-save-btn-meta">
                Strona {currentPage + 1}/{totalPages}
              </span>
            </button>

            <div className="bookmark-menu-list">
              {bookmarkList.length ? (
                bookmarkList.map((bookmark) => (
                  <div key={bookmark.id} className="bookmark-item">
                    <button
                      type="button"
                      className="bookmark-item-main"
                      onClick={() => jumpToBookmark(bookmark)}
                    >
                      <span className="bookmark-item-copy">
                        <span className="bookmark-item-title">
                          {bookmark.chapterTitle ||
                            `Rozdzial ${bookmark.chapterIndex + 1}`}
                        </span>
                        <span className="bookmark-item-meta">
                          Strona {formatBookmarkPage(bookmark)}
                        </span>
                        {bookmark.preview && (
                          <span className="bookmark-item-preview">
                            {bookmark.preview}
                          </span>
                        )}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="bookmark-item-remove"
                      onClick={() => removeBookmark(bookmark.id)}
                      title="Usun zakladke"
                      aria-label="Usun zakladke"
                    >
                      x
                    </button>
                  </div>
                ))
              ) : (
                <div className="bookmark-empty">
                  Brak zapisanych zakladek.
                </div>
              )}
            </div>
          </div>
        )}

        {/* Settings dropdown */}
        {settingsMenuOpen && (
          <div className="settings-menu" ref={settingsMenuRef}>
            <div className="settings-menu-toolbar">
              <button
                className={`settings-tool${searchOpen ? " settings-tool-active" : ""}`}
                onClick={() => {
                  if (searchOpen) {
                    setSearchOpen(false);
                    setSettingsMenuOpen(false);
                    return;
                  }
                  openSearchPanel();
                }}
                title="Szukaj w rozdziale (J)"
              >
                <span className="settings-tool-icon">/</span>
                <span className="settings-tool-text">Szukaj</span>
              </button>
              <button
                ref={bookmarkToggleRef}
                className={`settings-tool${bookmarkMenuOpen || currentPageBookmarks.length ? " settings-tool-active" : ""}`}
                onClick={() => {
                  if (bookmarkMenuOpen) {
                    setBookmarkMenuOpen(false);
                    setSettingsMenuOpen(false);
                    return;
                  }
                  openBookmarksPanel();
                }}
                title="Zakladki (Z)"
              >
                <span className="settings-tool-icon">*</span>
                <span className="settings-tool-text">Zakładki</span>
              </button>
              <button
                className={`settings-tool settings-tool-desktop-only${shortcutsOpen ? " settings-tool-active" : ""}`}
                onClick={openShortcutsPanel}
                title="Pokaz skróty (?)"
              >
                <span className="settings-tool-icon">?</span>
                <span className="settings-tool-text">Skróty</span>
              </button>
              <button
                className={`settings-tool${isFullscreen ? " settings-tool-active" : ""}`}
                onClick={() => void toggleFullscreen()}
                title="Przelacz pelny ekran (F)"
              >
                <span className="settings-tool-icon">[]</span>
                <span className="settings-tool-text">Ekran</span>
              </button>
              <button
                className={`settings-tool${(ttsPlaying && !ttsPaused) || (originalTtsPlaying && !originalTtsPaused) ? " settings-tool-active" : ""}`}
                onClick={polyMode && polyState === "done" ? toggleHybridTts : toggleOriginalTts}
                title={ttsButtonTitle}
                disabled={!hasTtsAvailable}
              >
                <span className="settings-tool-icon">{ttsButtonIcon}</span>
                <span className="settings-tool-text">{ttsButtonLabel}</span>
              </button>
            </div>

            <div className="settings-menu-divider" />

            <div className="settings-menu-row settings-menu-row-compact">
              <span className="settings-menu-label">Czcionka</span>
              <div className="settings-menu-ctrl">
                <button className="ctl" onClick={() => changeFontSize(-1)}>
                  A-
                </button>
                <span className="fs-val">{fs}</span>
                <button className="ctl" onClick={() => changeFontSize(1)}>
                  A+
                </button>
              </div>
            </div>

            {!polyMode && chapter?.text && (
              <div className="settings-menu-row settings-menu-row-compact">
                <span className="settings-menu-label">Tłumaczenie</span>
                <div className="settings-menu-ctrl">
                  <button
                    className="ctl ctl-gold"
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
                <div className="settings-menu-row settings-menu-row-compact">
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
            <div className="settings-menu-divider" />
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
                  <div className="settings-menu-row settings-menu-row-compact settings-menu-row-select">
                    <span className="settings-menu-label">{srcCode}</span>
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
                    <div className="settings-menu-row settings-menu-row-compact settings-menu-row-select">
                      <span className="settings-menu-label">{tgtCode}</span>
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

        {shortcutsOpen && (
          <div className="shortcuts-panel">
            <div className="shortcuts-head">
              <div>
                <div className="bookmark-menu-title">Skroty</div>
                <div className="bookmark-menu-sub">
                  Nawigacja, TTS i podglad tlumaczen.
                </div>
              </div>
              <button
                className="ctl ctl-icon"
                onClick={() => setShortcutsOpen(false)}
                title="Zamknij"
              >
                x
              </button>
            </div>
            <div className="shortcuts-grid">
              <div><kbd>Shift</kbd><span>oryginal / tlumaczenie</span></div>
              <div><kbd>?</kbd><span>pokaz te sciage</span></div>
              <div><kbd>Space</kbd><span>play / pause TTS</span></div>
              <div><kbd>,</kbd><span>poprzedni fragment TTS</span></div>
              <div><kbd>.</kbd><span>nastepny fragment TTS</span></div>
              <div><kbd>J</kbd><span>wyszukiwarka</span></div>
              <div><kbd>Z</kbd><span>zakladki</span></div>
              <div><kbd>Q</kbd><span>sidebar</span></div>
              <div><kbd>F</kbd><span>pelny ekran</span></div>
              <div><kbd>N</kbd><span>nastepny rozdzial</span></div>
              <div><kbd>P</kbd><span>poprzedni rozdzial</span></div>
              <div><kbd>Backspace</kbd><span>powrot do biblioteki</span></div>
              <div><kbd>[</kbd><span>mniejsza czcionka</span></div>
              <div><kbd>]</kbd><span>wieksza czcionka</span></div>
              <div><kbd>← →</kbd><span>zmiana strony</span></div>
            </div>
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
                title="Poprzedni fragment (,)"
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
                title="Poprzedni fragment (,)"
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
              <input
                className="page-slider"
                type="range"
                min="0"
                max={Math.max(totalPages - 1, 0)}
                step="1"
                value={Math.min(currentPage, Math.max(totalPages - 1, 0))}
                disabled={totalPages <= 1}
                aria-label="Przesun do strony"
                onChange={handlePageSliderChange}
                onPointerUp={handlePageSliderCommit}
                onMouseUp={handlePageSliderCommit}
                onTouchEnd={handlePageSliderCommit}
                onKeyUp={handlePageSliderCommit}
              />
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
