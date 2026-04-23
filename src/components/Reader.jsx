import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  db,
  getBook,
  getChapter,
  getPolyglotCache,
  savePolyglotCache,
  deletePolyglotCache,
  getChapterCachedLangs,
  getReadingPosition,
  saveReadingPosition,
  saveChapterLang,
  getChapterStatusMap,
} from "../db";
import { LANGUAGES, POLYGLOT_BATCH_OPTIONS } from "../hooks/useSettings";
import { useWakeLock } from "../hooks/useWakeLock";
import {
  generatePolyglot,
  estimatePolyglotGeneration,
  estimatePolyglotCostUsd,
  estimatePolyglotTimeSec,
  POLYGLOT_MODEL_ID,
} from "../lib/polyglotApi";
import { isLoggedIn } from "../sync/cfAuth";
import { triggerSync, syncBook } from "../sync/cfSync";
import { parseStoredPolyglot } from "../lib/polyglotParser";
import { annotateParagraphsInHtml } from "../lib/sentenceWrapper";
import { SentenceTtsPlayer } from "../lib/ttsFragments";
import BatchGenModal from "./BatchGenModal";
import ReaderSidebar from "./reader_components/ReaderSidebar";
import ReaderTopbar from "./reader_components/ReaderTopbar";
import ReaderSearchPanel from "./reader_components/ReaderSearchPanel";
import ReaderBookmarkMenu from "./reader_components/ReaderBookmarkMenu";
import ReaderSettingsMenu from "./reader_components/ReaderSettingsMenu";
import ReaderMissingLangBanner from "./reader_components/ReaderMissingLangBanner";
import ReaderChapterContent from "./reader_components/ReaderChapterContent";
import ReaderBottomBar from "./reader_components/ReaderBottomBar";
import {
  SEARCH_BLOCK_SELECTOR,
  FONT_SIZE_MIN,
  FONT_SIZE_MAX,
  getReaderFontStack,
  navigableTocItems,
  getVoiceId,
  findVoiceById,
  getVoicesForLang,
  resetTooltipPosition,
  normalizeInlineText,
  buildSearchSnippet,
  getBookmarkPageIndex,
  formatBookmarkPage,
} from "./reader_components/readerUtils";

const LANGUAGE_META = Object.fromEntries(
  LANGUAGES.map((lang) => [lang.code, lang]),
);
const LANGUAGE_ORDER = new Map(
  LANGUAGES.map((lang, index) => [lang.code, index]),
);
const POLISH_LANGUAGE_NAMES =
  typeof Intl !== "undefined" && typeof Intl.DisplayNames === "function"
    ? new Intl.DisplayNames(["pl"], { type: "language" })
    : null;

function capitalizeLabel(value) {
  if (!value) return "";
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function getLanguageDisplayLabel(code, meta = null) {
  if (!code) return "Nieznany język";
  if (meta?.name) return capitalizeLabel(meta.name);
  const normalized = code.split("-")[0].toLowerCase();
  const display = POLISH_LANGUAGE_NAMES?.of(normalized);
  if (display) return capitalizeLabel(display);
  return normalized.toUpperCase();
}

const NEXT_PAGE_KEY_NAMES = new Set([
  "ArrowRight",
  "PageDown",
  "VolumeDown",
  "AudioVolumeDown",
  "BrowserForward",
  "MediaTrackNext",
]);
const PREV_PAGE_KEY_NAMES = new Set([
  "ArrowLeft",
  "PageUp",
  "VolumeUp",
  "AudioVolumeUp",
  "BrowserBack",
  "MediaTrackPrevious",
]);
const NEXT_PAGE_CODES = new Set(["ArrowRight", "PageDown", "VolumeDown", "Space"]);
const PREV_PAGE_CODES = new Set(["ArrowLeft", "PageUp", "VolumeUp"]);
const NEXT_PAGE_KEY_CODES = new Set([32, 34, 39, 93, 167, 174, 25]);
const PREV_PAGE_KEY_CODES = new Set([33, 37, 92, 166, 175, 24]);

function getPageTurnDirection(event) {
  const key = event.key;
  const code = event.code;
  const keyCode = event.keyCode ?? event.which;

  if (key === " " || key === "Spacebar" || code === "Space") {
    return event.shiftKey ? -1 : 1;
  }
  if (
    NEXT_PAGE_KEY_NAMES.has(key) ||
    NEXT_PAGE_CODES.has(code) ||
    NEXT_PAGE_KEY_CODES.has(keyCode)
  ) {
    return 1;
  }
  if (
    PREV_PAGE_KEY_NAMES.has(key) ||
    PREV_PAGE_CODES.has(code) ||
    PREV_PAGE_KEY_CODES.has(keyCode)
  ) {
    return -1;
  }
  return 0;
}

function isTextEntryElement(element) {
  if (!element) return false;
  const tag = element.tagName;
  if (element.isContentEditable || tag === "TEXTAREA" || tag === "SELECT") {
    return true;
  }
  if (tag !== "INPUT") return false;
  return !["button", "checkbox", "radio", "range", "submit"].includes(
    element.type,
  );
}

/* ═══════════════════════════════════════════
   Helpers
═══════════════════════════════════════════ */

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
  const [batchModalOpen, setBatchModalOpen] = useState(false);

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
  const [distractionFree, setDistractionFree] = useState(false);
  const [showAllTranslations, setShowAllTranslations] = useState(false);
  const [fs, setFs] = useState(settings.fontSize ?? 19);
  const readerFont = settings.readerFont ?? "garamond";
  const readerFontStack = getReaderFontStack(readerFont);
  const orderedCachedLangs = useMemo(
    () =>
      [...cachedLangs].sort(
        (a, b) =>
          (LANGUAGE_ORDER.get(a.code) ?? Number.MAX_SAFE_INTEGER) -
          (LANGUAGE_ORDER.get(b.code) ?? Number.MAX_SAFE_INTEGER),
      ),
    [cachedLangs],
  );
  const tooltipReadOnClick = settings.tooltipReadOnClick !== false;

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
  const ttsPagePauseModeRef = useRef(null);
  const swipeTouchStartXRef = useRef(null);
  const swipeTouchStartYRef = useRef(null);
  const toggleDistractionFreeRef = useRef(null);
  const keyPageTurnAtRef = useRef(0);
  toggleDistractionFreeRef.current = toggleDistractionFree;
  const centerTapHandledRef = useRef(false);

  useWakeLock(Boolean(bookId));

  useEffect(() => {
    function onKeyDown(e) {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTextEntryElement(document.activeElement)) return;
      if (e.key === "f" || e.key === "F") {
        e.preventDefault();
        toggleDistractionFreeRef.current?.();
        return;
      }
      const direction = getPageTurnDirection(e);
      if (!direction) return;

      e.preventDefault();
      const now = Date.now();
      if (e.repeat && now - keyPageTurnAtRef.current < 180) return;
      keyPageTurnAtRef.current = now;

      if (direction > 0) {
        nextPageRef.current();
      } else {
        prevPageRef.current();
      }
      setDistractionFree(true);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    setFs(settings.fontSize ?? 19);
  }, [settings.fontSize]);

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
  const [ttsErrorToast, setTtsErrorToast] = useState(false);

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
              annotateParagraphsInHtml(chHtml, book?.lang || "en");
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
            const { html, paragraphs, words } = parseStoredPolyglot(entry, ch.html);
            setPolyHtml(html);
            setPolyHtmlAnnotated(html);
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
              if (
                scrollRetryTokenRef.current === token &&
                pendingProgressRef.current !== null
              ) {
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
    readerFontStack,
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
      if (
        !bookId ||
        chapterIdxRef.current === null ||
        chapterIdxRef.current === undefined
      ) {
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

  /* ── Page navigation ── */
  function goToPage(page, options = {}) {
    const { pauseTts = false } =
      typeof options === "boolean" ? {} : options;
    const inner = chInnerRef.current;
    const container = chScrollRef.current;
    if (!inner || !container) return;
    const total = totalPagesRef.current;
    const clampedPage = Math.max(0, Math.min(page, total - 1));

    clearPageTurnState();
    if (pauseTts) pauseTtsForManualPageTurn();

    inner.style.transition = "";
    syncPageViewport(clampedPage);
    setCurrentPage(clampedPage);
    currentPageRef.current = clampedPage;
    persistPosition();
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

  /* ── Swipe left/right to navigate pages ── */
  const prevPageRef = useRef(prevPage);
  const nextPageRef = useRef(nextPage);
  prevPageRef.current = prevPage;
  nextPageRef.current = nextPage;

  useEffect(() => {
    const el = chScrollRef.current;
    if (!el) return;
    function onTouchStart(e) {
      swipeTouchStartXRef.current = e.touches[0].clientX;
      swipeTouchStartYRef.current = e.touches[0].clientY;
    }
    function onTouchEnd(e) {
      if (swipeTouchStartXRef.current === null) return;
      const touch = e.changedTouches[0];
      const dx = touch.clientX - swipeTouchStartXRef.current;
      const dy = touch.clientY - swipeTouchStartYRef.current;
      swipeTouchStartXRef.current = null;
      swipeTouchStartYRef.current = null;
      if (Math.abs(dx) >= 50) {
        if (dx > 0) prevPageRef.current();
        else nextPageRef.current();
        setDistractionFree(true);
        return;
      }
    }
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchend", onTouchEnd, { passive: true });
    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchend", onTouchEnd);
    };
  }, []);

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
      goToPage(getElementPage(target), { pauseTts: true });
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

  const theme = settings.theme ?? "dark";

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
        (!bookmarkToggleRef.current ||
          !bookmarkToggleRef.current.contains(e.target))
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
    const { html, paragraphs, words } = parseStoredPolyglot(entry, chapterHtml);
    setPolyHtml(html);
    setPolyHtmlAnnotated(html);
    setPolyTtsParagraphs(paragraphs);
    setPolyWordFragments(words);
  }

  function switchToLang(lang) {
    if (lang === activeLang) return;
    clearPageTurnState();
    userChangedLangRef.current = true;
    pendingProgressRef.current = getCurrentProgress();
    // Force ch-columns to remount on mode switch to bust stale GPU compositing layer.
    // will-change:transform promotes ch-columns to its own GPU layer; after a DOM
    // content swap the layer texture may not refresh until a user interaction.
    animKeyRef.current += 1;
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
          book?.lang || "en",
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

  function setReaderFontSize(value) {
    if (!Number.isFinite(value)) return;
    setFs((current) => {
      const next = Math.max(FONT_SIZE_MIN, Math.min(FONT_SIZE_MAX, value));
      if (next !== current) {
        void onUpdateSetting?.("fontSize", next);
      }
      return next;
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

  function changeReaderFont(nextFont) {
    if (!nextFont || nextFont === readerFont) return;
    void onUpdateSetting?.("readerFont", nextFont);
  }

  function openSearchPanel() {
    setSearchOpen(true);
    setBookmarkMenuOpen(false);
    setSettingsMenuOpen(false);
  }

  function openBookmarksPanel() {
    setBookmarkMenuOpen(true);
    setSearchOpen(false);
    setSettingsMenuOpen(false);
  }

  function handlePageSliderChange(e) {
    const nextPage = Number(e.target.value);
    if (!Number.isFinite(nextPage)) return;
    goToPage(nextPage);
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
    const lastCode = localStorage.getItem("vocabapp:lastLang") || settings.targetLang;
    const initialCode =
      lastCode && LANGUAGES.some((l) => l.code === lastCode)
        ? lastCode
        : LANGUAGES[0].code;
    openTranslationConfirmation(initialCode);
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

  async function deleteCurrentTranslation() {
    if (!activeLang || !chapter?.id) return;
    setSettingsMenuOpen(false);
    await deletePolyglotCache(chapter.id, activeLang);
    switchToLang(null);
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
          model: POLYGLOT_MODEL_ID,
          sentencesPerRequest: settings.polyglotSentencesPerRequest,
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
      (v) =>
        v.lang?.startsWith("pl") || v.name?.toLowerCase().includes("polish"),
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
      ttsPagePauseModeRef.current === "hybrid"
        ? null
        : ttsPagePauseModeRef.current;
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
      ttsPagePauseModeRef.current === "original"
        ? null
        : ttsPagePauseModeRef.current;
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

  function showTtsUnsupportedToast() {
    setTtsErrorToast(true);
    setTimeout(() => setTtsErrorToast(false), 4000);
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
      onError: () => {
        setOriginalTtsPlaying(false);
        setOriginalTtsPaused(false);
        setActiveSid(-1);
        activeSidRef.current = -1;
        clearSentenceHighlight();
        showTtsUnsupportedToast();
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
      onError: () => {
        setTtsPlaying(false);
        setTtsPaused(false);
        setActivePolyPid(-1);
        clearSentenceHighlight();
        showTtsUnsupportedToast();
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
        Math.max(0, Math.min(originalTtsFragments.length - 1, base + delta)),
      );
      return;
    }

    if (ttsPagePauseModeRef.current === "hybrid") {
      const base = getFirstSidOnCurrentPage();
      startHybridTts(
        Math.max(0, Math.min(polyTtsParagraphs.length - 1, base + delta)),
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

  function playSingleWord(wordId, options = {}) {
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
    if (!options.skipTooltip) {
      const el = chapterBodyRef.current?.querySelector(`[data-word-id="${wordId}"]`);
      if (el) openTooltip(el, true);
    }
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

      pw.style.setProperty("--pw-tooltip-left", `${clampedLeft - pwRect.left}px`);
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
        if (!showAllTranslations) openTooltip(pw);
        const wordId = Number.parseInt(pw.dataset.wordId, 10);
        if (tooltipReadOnClick && Number.isInteger(wordId)) {
          playSingleWord(wordId, { skipTooltip: true });
        }
        return;
      }
      const pidEl = e.target.closest("[data-pid]");
      if (pidEl && ttsPlaying && polyTtsParagraphs.length > 0) {
        const pid = parseInt(pidEl.dataset.pid, 10);
        if (pid !== activePolyPid) startHybridTts(pid);
        return;
      }
    } else {
      // In original mode: paragraph seek works only while TTS is already active
      const pidEl = e.target.closest("[data-pid]");
      if (pidEl && originalTtsPlaying && originalTtsFragments.length > 0) {
        const pid = parseInt(pidEl.dataset.pid, 10);
        if (pid !== activeSid) startOriginalTts(pid);
        return;
      }
    }

  }

  /* ── TOC navigation ── */
  function goToHref(href) {
    if (!href || !book) return;
    const safeDecode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
    const clean = safeDecode(href.split("#")[0]);
    db.chapters
      .where("bookId")
      .equals(bookId)
      .toArray()
      .then((chs) => {
        const found = chs.find((c) => safeDecode(c.href.split("#")[0]) === clean);
        if (found) navigate(found.chapterIndex);
      });
    setSidebarOpen(false);
  }

  function openTranslationConfirmation(langCode) {
    userChangedLangRef.current = true;
    setConfirmLang(langCode);
    setActiveLang(langCode);
    setPolyState("confirm");
  }

  function resetTranslationSelection() {
    setActiveLang(null);
    setPolyState("idle");
  }

  function handleConfirmLangChange(langCode) {
    setConfirmLang(langCode);
    setActiveLang(langCode);
  }

  function handleToggleSettingsMenu() {
    setSettingsMenuOpen((open) => !open);
    setSearchOpen(false);
    setBookmarkMenuOpen(false);
  }

  function handleSettingsSearchToolClick() {
    if (searchOpen) {
      setSearchOpen(false);
      setSettingsMenuOpen(false);
      return;
    }
    openSearchPanel();
  }

  function handleSettingsBookmarksToolClick() {
    if (bookmarkMenuOpen) {
      setBookmarkMenuOpen(false);
      setSettingsMenuOpen(false);
      return;
    }
    openBookmarksPanel();
  }

  function handleOpenBatchModal() {
    setBatchModalOpen(true);
    setSidebarOpen(false);
  }

  function toggleDistractionFree() {
    setDistractionFree((v) => {
      if (!v) setSidebarOpen(false);
      return !v;
    });
  }

  function handleAddTranslation() {
    requestGenerate();
    setSettingsMenuOpen(false);
  }

  function handleSourceVoiceChange(nextVoiceId) {
    setTtsSourceVoice(nextVoiceId);
    localStorage.setItem(`tts-voice-src-${sourceLangCode}`, nextVoiceId);
    const nextVoice = findVoiceById(ttsVoices, nextVoiceId);
    ttsPlayerRef.current?.setVoice(nextVoice);
    originalTtsPlayerRef.current?.setVoice(nextVoice);
  }

  function handleTargetVoiceChange(nextVoiceId) {
    setTtsTargetVoice(nextVoiceId);
    localStorage.setItem(`tts-voice-tgt-${targetLangCode}`, nextVoiceId);
  }

  function handleToggleTooltipReadOnClick() {
    void onUpdateSetting?.("tooltipReadOnClick", !tooltipReadOnClick);
  }

  function handleMissingLangGenerate() {
    if (!missingLangBanner) return;
    setMissingLangBanner(null);
    openTranslationConfirmation(missingLangBanner);
  }

  const generationEstimate = useMemo(
    () =>
      estimatePolyglotGeneration(
        { html: chapter?.html },
        {
          sentencesPerRequest: settings.polyglotSentencesPerRequest,
        },
      ),
    [chapter?.html, settings.polyglotSentencesPerRequest],
  );
  const estimatedSentenceCount = generationEstimate.sentenceCount;
  const estimatedBatchCount = generationEstimate.generationBatches;
  const estimatedCost = chapter?.text
    ? estimatePolyglotCostUsd(chapter.text.length)
    : 0;
  const estimatedSecs = chapter?.text
    ? estimatePolyglotTimeSec(
        estimatedBatchCount,
        generationEstimate.requestConcurrency,
        estimatedSentenceCount,
      )
    : 0;
  const polyDisplaySecs =
    polyState === "loading"
      ? Math.max(polyProgress.secs, polyLiveSecs)
      : polyProgress.secs;
  const polyProgressUnitLabel =
    polyProgress.phase === "verify"
      ? polyProgress.total === 1
        ? "zmiana"
        : polyProgress.total < 5
          ? "zmiany"
          : "zmian"
      : polyProgress.total === 1
        ? "zapytanie"
        : polyProgress.total < 5
          ? "zapytania"
          : "zapytań";
  const polyLoadingText =
    polyProgress.phase === "verify"
      ? polyProgress.total > 0
        ? polyProgress.done === 0
          ? `Startuję weryfikację (${polyProgress.total} ${polyProgressUnitLabel})…`
          : `Weryfikacja ${polyProgress.done} / ${polyProgress.total} ${polyProgressUnitLabel}`
        : "Weryfikuję tłumaczenie…"
      : polyProgress.total > 0
        ? polyProgress.done === 0
          ? `Wysyłam ${polyProgress.total} ${polyProgressUnitLabel}…`
          : `Przetworzono ${polyProgress.done} / ${polyProgress.total} ${polyProgressUnitLabel}`
        : "Łączenie z API…";
  const chapterLabel = chapter?.title?.trim() || `Rozdział ${(chapterIdx ?? 0) + 1}`;
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
  const activeTtsMode =
    polyMode && polyState === "done" ? "hybrid" : "original";
  const activeTtsPlaying =
    activeTtsMode === "hybrid" ? ttsPlaying : originalTtsPlaying;
  const activeTtsPaused =
    activeTtsMode === "hybrid" ? ttsPaused : originalTtsPaused;
  const ttsButtonTitle = activeTtsPlaying
    ? activeTtsPaused
      ? "Wznów czytanie"
      : "Zatrzymaj czytanie"
    : "Odtwórz TTS";
  const ttsButtonLabel = activeTtsPlaying
    ? activeTtsPaused
      ? "Wznów"
      : "Pauza"
    : "Play";
  const hasTtsAvailable =
    activeTtsMode === "hybrid"
      ? polyTtsParagraphs.length > 0
      : originalTtsFragments.length > 0;
  const sourceLangCode = (book?.lang || "en").split("-")[0].toLowerCase();
  const targetLangCode = (activeLang || "es").split("-")[0].toLowerCase();
  const sourceLanguageLabel = getLanguageDisplayLabel(
    sourceLangCode,
    LANGUAGE_META[sourceLangCode],
  );
  const targetLanguageLabel = getLanguageDisplayLabel(
    targetLangCode,
    LANGUAGE_META[targetLangCode],
  );
  const sourceVoices = getVoicesForLang(ttsVoices, book?.lang || "en");
  const targetVoices = getVoicesForLang(ttsVoices, activeLang || "es");
  const showVoiceNote =
    voiceLoadState !== "ready" ||
    !sourceVoices.length ||
    (polyMode && !targetVoices.length);

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
      className={`reader-layout${distractionFree ? " distraction-free" : ""}`}
      data-show-all={showAllTranslations ? "true" : undefined}
      style={{ "--fs": `${fs}px`, "--reader-font": readerFontStack }}
    >
      <ReaderSidebar
        sidebarOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        onBack={handleBackToLibrary}
        book={book}
        canTranslateBook={Boolean(book && settings)}
        onOpenBatchModal={handleOpenBatchModal}
        chapterCount={chapterCount}
        tocItems={tocItems}
        hrefToIndex={hrefToIndex}
        chapterStatusMap={chapterStatusMap}
        currentChapterHref={currentChapterHref}
        onGoToHref={goToHref}
        languageMeta={LANGUAGE_META}
        languageOrder={LANGUAGE_ORDER}
      />

      {ttsErrorToast && (
        <div className="tts-error-toast">
          TTS nie jest obsługiwane w tej przeglądarce
        </div>
      )}

      {/* ── Main content ── */}
      <div className="reader-main">
        {/* Top bar */}
        <ReaderTopbar
          chapter={chapter}
          chapterLabel={chapterLabel}
          activeLang={activeLang}
          orderedCachedLangs={orderedCachedLangs}
          onSwitchLang={switchToLang}
          settingsMenuOpen={settingsMenuOpen}
          settingsToggleRef={settingsToggleRef}
          onToggleSidebar={() => setSidebarOpen((open) => !open)}
          onToggleSettings={handleToggleSettingsMenu}
          onHideBars={() => setDistractionFree(true)}
        />

        {searchOpen && (
          <ReaderSearchPanel
            inputRef={searchInputRef}
            searchQuery={searchQuery}
            onSearchQueryChange={setSearchQuery}
            searchMatches={searchMatches}
            activeSearchIdx={activeSearchIdx}
            onGoToSearchMatch={goToSearchMatch}
            onClose={() => setSearchOpen(false)}
          />
        )}

        {bookmarkMenuOpen && (
          <ReaderBookmarkMenu
            menuRef={bookmarkMenuRef}
            hasCurrentPageBookmark={hasCurrentPageBookmark}
            currentPage={currentPage}
            totalPages={totalPages}
            bookmarkList={bookmarkList}
            onAddBookmark={addBookmark}
            onJumpToBookmark={jumpToBookmark}
            onRemoveBookmark={removeBookmark}
            formatBookmarkPage={formatBookmarkPage}
          />
        )}

        {settingsMenuOpen && (
          <ReaderSettingsMenu
            menuRef={settingsMenuRef}
            bookmarkToggleRef={bookmarkToggleRef}
            searchOpen={searchOpen}
            bookmarkMenuOpen={bookmarkMenuOpen}
            hasCurrentPageBookmarks={hasCurrentPageBookmark}
            isTtsActive={activeTtsPlaying && !activeTtsPaused}
            onSearchToolClick={handleSettingsSearchToolClick}
            onBookmarksToolClick={handleSettingsBookmarksToolClick}
            onToggleTts={
              activeTtsMode === "hybrid" ? toggleHybridTts : toggleOriginalTts
            }
            ttsButtonTitle={ttsButtonTitle}
            ttsButtonLabel={ttsButtonLabel}
            isTtsPlaying={activeTtsPlaying}
            isTtsPaused={activeTtsPaused}
            hasTtsAvailable={hasTtsAvailable}
            fontSize={fs}
            readerFont={readerFont}
            onChangeFontSize={changeFontSize}
            onSetFontSize={setReaderFontSize}
            onChangeReaderFont={changeReaderFont}
            showAddTranslation={!polyMode && Boolean(chapter?.text)}
            showRegenerateTranslation={
              polyMode &&
              polyState === "done" &&
              Boolean(activeLang && chapter?.text)
            }
            onAddTranslation={handleAddTranslation}
            onRegenerateTranslation={regenerateCurrentTranslation}
            onDeleteTranslation={deleteCurrentTranslation}
            sourceLanguageLabel={sourceLanguageLabel}
            targetLanguageLabel={targetLanguageLabel}
            sourceVoices={sourceVoices}
            targetVoices={targetVoices}
            showTargetVoiceSelect={polyMode}
            showVoiceNote={showVoiceNote}
            voiceLoadState={voiceLoadState}
            theme={theme}
            onChangeTheme={(nextTheme) => onUpdateSetting?.("theme", nextTheme)}
            tooltipReadOnClick={tooltipReadOnClick}
            onToggleTooltipReadOnClick={handleToggleTooltipReadOnClick}
            showAllTranslations={showAllTranslations}
            onToggleShowAllTranslations={() => setShowAllTranslations((v) => !v)}
            ttsSourceVoice={ttsSourceVoice}
            ttsTargetVoice={ttsTargetVoice}
            onSourceVoiceChange={handleSourceVoiceChange}
            onTargetVoiceChange={handleTargetVoiceChange}
          />
        )}

        {batchModalOpen && book && settings && (
          <BatchGenModal
            bookId={book.id}
            book={book}
            settings={settings}
            onUpdateSetting={onUpdateSetting}
            onClose={() => setBatchModalOpen(false)}
          />
        )}

        {missingLangBanner && (
          <ReaderMissingLangBanner
            langCode={missingLangBanner}
            languages={LANGUAGES}
            onGenerate={handleMissingLangGenerate}
            onDismiss={() => setMissingLangBanner(null)}
          />
        )}

        <ReaderChapterContent
          scrollRef={chScrollRef}
          innerRef={chInnerRef}
          animKey={animKeyRef.current}
          chapterLoading={chapterLoading}
          chapter={chapter}
          polyMode={polyMode}
          polyState={polyState}
          confirmLang={confirmLang}
          languages={LANGUAGES}
          batchOptions={POLYGLOT_BATCH_OPTIONS}
          estimatedSentenceCount={estimatedSentenceCount}
          estimatedBatchCount={estimatedBatchCount}
          estimatedSecs={estimatedSecs}
          estimatedCost={estimatedCost}
          sentencesPerRequest={settings.polyglotSentencesPerRequest}
          onSentencesPerRequestChange={(value) =>
            onUpdateSetting?.("polyglotSentencesPerRequest", value)
          }
          onConfirmLangChange={handleConfirmLangChange}
          onStartGeneration={startGeneration}
          onCancelConfirm={resetTranslationSelection}
          polyLoadingText={polyLoadingText}
          polyProgress={polyProgress}
          polyDisplaySecs={polyDisplaySecs}
          polyRescueNote={polyRescueNote}
          polyError={polyError}
          onDismissPolyError={resetTranslationSelection}
          activeLang={activeLang}
          chapterBodyRef={chapterBodyRef}
          polyWordFragments={polyWordFragments}
          ttsPlaying={ttsPlaying}
          renderedPolyHtml={renderedPolyHtml}
          onContentClick={handleContentClick}
          originalTtsPlaying={originalTtsPlaying}
          originalHtmlAnnotated={originalHtmlAnnotated}
        />

        <ReaderBottomBar
          currentPage={currentPage}
          totalPages={totalPages}
          chapterIdx={chapterIdx}
          chapterCount={chapterCount}
          onPrevPage={prevPage}
          onNextPage={nextPage}
          originalTtsPlaying={originalTtsPlaying}
          activeSid={activeSid}
          onJumpSentence={jumpSentence}
          onToggleOriginalTts={toggleOriginalTts}
          originalTtsPaused={originalTtsPaused}
          onStopOriginalTts={stopOriginalTts}
          originalTtsFragments={originalTtsFragments}
          ttsPlaying={ttsPlaying}
          activePolyPid={activePolyPid}
          onJumpPolyParagraph={jumpPolyParagraph}
          onToggleHybridTts={toggleHybridTts}
          ttsPaused={ttsPaused}
          onStopHybridTts={stopHybridTts}
          polyTtsParagraphs={polyTtsParagraphs}
          onPageSliderChange={handlePageSliderChange}
          onPageSliderCommit={handlePageSliderCommit}
        />
      </div>

      {distractionFree && (
        <button
          className={`ui-toggle-btn${showAllTranslations ? " translations-active" : ""}`}
          onClick={toggleDistractionFree}
          aria-label="Pokaż/ukryj UI"
        >
          ≡
        </button>
      )}

    </div>
  );
}
