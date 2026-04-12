import { useState, useEffect, useMemo } from "react";
import { getBookChaptersWithCacheStatus, savePolyglotCache } from "../db";
import {
  estimatePolyglotGeneration,
  estimatePolyglotCostUsd,
  estimatePolyglotTimeSec,
  generatePolyglot,
  POLYGLOT_MODEL_ID,
} from "../lib/polyglotApi";
import { triggerSync } from "../sync/cfSync";
import { LANGUAGES } from "../hooks/useSettings";
import { useWakeLock } from "../hooks/useWakeLock";

const MAX_PARALLEL_BATCH_REQUESTS = 24;

function getBatchChapterConcurrency(requestConcurrency, chapterCount) {
  const perChapterRequests = Math.max(1, Number(requestConcurrency) || 1);
  const chapters = Math.max(0, Number(chapterCount) || 0);
  if (!chapters) return 1;
  return Math.max(
    1,
    Math.min(chapters, Math.floor(MAX_PARALLEL_BATCH_REQUESTS / perChapterRequests)),
  );
}

function fmtTime(s) {
  if (s < 60) return `~${s}s`;
  return `~${Math.ceil(s / 60)} min`;
}

function fmtCost(usd) {
  if (usd < 0.001) return "< $0.001";
  return `~$${usd.toFixed(3)}`;
}

export default function BatchGenModal({ bookId, book, settings, onClose }) {
  const [selectedLang, setSelectedLang] = useState(() => {
    const code = localStorage.getItem("vocabapp:lastLang");
    return LANGUAGES.find((l) => l.code === code) ?? LANGUAGES[0];
  });
  const [chapters, setChapters] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(new Set());
  const [generating, setGenerating] = useState(false);
  const [genStep, setGenStep] = useState(null);
  const [errors, setErrors] = useState({});
  const [done, setDone] = useState(false);
  const [rescueNote, setRescueNote] = useState("");

  useWakeLock(generating);

  useEffect(() => {
    setLoading(true);
    getBookChaptersWithCacheStatus(bookId, selectedLang.code).then((chs) => {
      setChapters(chs);
      setSelected(new Set(chs.filter((c) => !c.hasPoly).map((c) => c.id)));
      setLoading(false);
    });
  }, [bookId, selectedLang.code]);

  const toGenerate = useMemo(
    () => chapters.filter((c) => selected.has(c.id)),
    [chapters, selected],
  );

  const generationStatsByChapterId = useMemo(
    () =>
      new Map(
        toGenerate.map((chapter) => [
          chapter.id,
          estimatePolyglotGeneration(
            { html: chapter.html },
            {
              sentencesPerRequest: settings.polyglotSentencesPerRequest,
            },
          ),
        ]),
      ),
    [toGenerate, settings.polyglotSentencesPerRequest],
  );

  const {
    totalChars,
    totalSentences,
    totalRequests,
    requestConcurrency,
    costUSD,
    timeSec,
  } = useMemo(() => {
    const totalChars = toGenerate.reduce(
      (sum, chapter) => sum + (chapter.text?.length ?? 0),
      0,
    );
    const totalSentences = [...generationStatsByChapterId.values()].reduce(
      (sum, stats) => sum + (stats?.sentenceCount ?? 0),
      0,
    );
    const totalRequests = [...generationStatsByChapterId.values()].reduce(
      (sum, stats) => sum + (stats?.generationBatches ?? 0),
      0,
    );
    const requestConcurrency =
      [...generationStatsByChapterId.values()][0]?.requestConcurrency ?? 1;
    const chapterConcurrency = getBatchChapterConcurrency(
      requestConcurrency,
      toGenerate.length,
    );

    return {
      totalChars,
      totalSentences,
      totalRequests,
      requestConcurrency,
      chapterConcurrency,
      costUSD: estimatePolyglotCostUsd(totalChars),
      timeSec: estimatePolyglotTimeSec(
        totalRequests,
        requestConcurrency,
        totalSentences,
        chapterConcurrency,
      ),
    };
  }, [toGenerate, generationStatsByChapterId]);

  function toggleChapter(id) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function selectAll() {
    setSelected(new Set(chapters.map((c) => c.id)));
  }
  function selectNone() {
    setSelected(new Set());
  }

  async function handleGenerate() {
    setGenerating(true);
    setErrors({});
    setDone(false);
    setRescueNote("");
    localStorage.setItem("vocabapp:lastLang", selectedLang.code);

    const totalChapters = toGenerate.length;
    const batchTotal = [...generationStatsByChapterId.values()].reduce(
      (sum, stats) => sum + (stats?.generationBatches ?? 0),
      0,
    );
    const patchDoneByChapter = new Map();
    const activeChapterIds = new Set();
    let nextChapterIdx = 0;
    let doneChapters = 0;

    const refreshProgress = () => {
      const batchDone = [...patchDoneByChapter.values()].reduce(
        (sum, current) => sum + current,
        0,
      );
      setGenStep({
        doneChapters,
        totalChapters,
        activeChapters: activeChapterIds.size,
        batchDone,
        batchTotal,
      });
    };

    async function runChapter(chapter, chapterIdx) {
      const chapterStats = generationStatsByChapterId.get(chapter.id) ?? {};
      const requestTotal = chapterStats.generationBatches ?? 0;
      const chapterLabel = chapter.title || `Rozdział ${chapterIdx + 1}`;

      activeChapterIds.add(chapter.id);
      patchDoneByChapter.set(chapter.id, 0);
      refreshProgress();

      try {
        const { cacheValue } = await generatePolyglot(
          { text: chapter.text, html: chapter.html },
          {
            targetLangName: selectedLang.name,
            sourceLangName: book?.lang || "",
            model: POLYGLOT_MODEL_ID,
            sentencesPerRequest: settings.polyglotSentencesPerRequest,
            onRescue: ({ retryAttempt, maxRetries }) => {
              setRescueNote(
                `${chapterLabel}: brak postępu, ponawiam próbę (${retryAttempt}/${maxRetries})...`,
              );
            },
          },
          (progress) => {
            setRescueNote("");
            if (progress.phase === "patch") {
              patchDoneByChapter.set(
                chapter.id,
                Math.max(
                  patchDoneByChapter.get(chapter.id) ?? 0,
                  progress.done,
                ),
              );
            }
            refreshProgress();
          },
        );

        patchDoneByChapter.set(chapter.id, requestTotal);
        await savePolyglotCache(chapter.id, selectedLang.code, cacheValue);
        triggerSync();
        window.dispatchEvent(
          new CustomEvent("polyglot-saved", {
            detail: { chapterId: chapter.id, lang: selectedLang.code },
          }),
        );
        setChapters((prev) =>
          prev.map((c) => (c.id === chapter.id ? { ...c, hasPoly: true } : c)),
        );
        setSelected((prev) => {
          const next = new Set(prev);
          next.delete(chapter.id);
          return next;
        });
      } catch (err) {
        patchDoneByChapter.set(chapter.id, requestTotal);
        setErrors((prev) => ({
          ...prev,
          [chapter.id]: err.message || "Błąd API",
        }));
      } finally {
        activeChapterIds.delete(chapter.id);
        doneChapters += 1;
        refreshProgress();
      }
    }

    async function workerLoop() {
      while (true) {
        const chapterIdx = nextChapterIdx;
        nextChapterIdx += 1;
        if (chapterIdx >= toGenerate.length) return;
        await runChapter(toGenerate[chapterIdx], chapterIdx);
      }
    }

    refreshProgress();
    await Promise.all(
      Array.from(
        { length: getBatchChapterConcurrency(requestConcurrency, toGenerate.length) },
        () => workerLoop(),
      ),
    );

    setGenerating(false);
    setGenStep(null);
    setRescueNote("");
    setDone(true);
  }

  return (
    <div
      className="modal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget && !generating) onClose();
      }}
    >
      <div className="modal bgen-modal">
        <div className="modal-head">
          <div className="modal-title">Generuj tłumaczenia — {book?.title}</div>
          <button
            className="modal-close"
            onClick={onClose}
            disabled={generating}
          >
            ✕
          </button>
        </div>

        <div className="modal-body">
          {loading ? (
            <div
              style={{ display: "flex", justifyContent: "center", padding: 40 }}
            >
              <div className="spin-ring" />
            </div>
          ) : (
            <>
              <div className="bgen-info">
                <select
                  className="form-select"
                  value={selectedLang.code}
                  onChange={(e) => {
                    const lang =
                      LANGUAGES.find((l) => l.code === e.target.value) ??
                      LANGUAGES[0];
                    setSelectedLang(lang);
                    setDone(false);
                    setErrors({});
                  }}
                  disabled={generating}
                  style={{ flex: 1, minWidth: 150 }}
                >
                  {LANGUAGES.map((l) => (
                    <option key={l.code} value={l.code}>
                      {l.flag} {l.label} ({l.name})
                    </option>
                  ))}
                </select>
              </div>

              <div className="bgen-chapter-list">
                <div className="bgen-ch-header">
                  <span className="bgen-ch-label">
                    Rozdziały ({chapters.length})
                  </span>
                  <div style={{ display: "flex", gap: 6 }}>
                    <button
                      className="ctl"
                      onClick={selectAll}
                      disabled={generating}
                    >
                      Wszystkie
                    </button>
                    <button
                      className="ctl"
                      onClick={selectNone}
                      disabled={generating}
                    >
                      Żadne
                    </button>
                  </div>
                </div>
                {chapters.map((ch, i) => (
                  <label
                    key={ch.id}
                    className={`bgen-ch-row ${ch.hasPoly ? "has-poly" : ""} ${errors[ch.id] ? "has-error" : ""}`}
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(ch.id)}
                      disabled={generating}
                      onChange={() => toggleChapter(ch.id)}
                    />
                    <span className="bgen-ch-num">{i + 1}.</span>
                    <span className="bgen-ch-title">
                      {ch.title || `Rozdział ${i + 1}`}
                    </span>
                    <span className="bgen-ch-status">
                      {ch.hasPoly ? (
                        <span
                          className="bgen-dot done"
                          title="Tłumaczenie już istnieje. Generowanie nadpisze je."
                        >
                          ✓
                        </span>
                      ) : errors[ch.id] ? (
                        <span className="bgen-dot error" title={errors[ch.id]}>
                          ✕
                        </span>
                      ) : (
                        <span className="bgen-dot empty" title="Brak">
                          ○
                        </span>
                      )}
                    </span>
                  </label>
                ))}
              </div>

              {toGenerate.length > 0 && !generating && !done && (
                <div className="bgen-estimate">
                  <span>
                    <strong>{toGenerate.length}</strong>{" "}
                    {toGenerate.length === 1 ? "rozdział" : "rozdziały"}
                  </span>
                  <span className="bgen-sep">·</span>
                  <span>
                    <strong>{totalSentences}</strong>{" "}
                    {totalSentences === 1
                      ? "zdanie"
                      : totalSentences < 5
                        ? "zdania"
                        : "zdań"}
                  </span>
                  <span className="bgen-sep">·</span>
                  <span>
                    <strong>{totalRequests}</strong>{" "}
                    {totalRequests === 1
                      ? "zapytanie"
                      : totalRequests < 5
                        ? "zapytania"
                        : "zapytań"}
                  </span>
                  <span className="bgen-sep">Â·</span>
                  <span>
                    Czas: <strong>{fmtTime(timeSec)}</strong>
                  </span>
                  <span className="bgen-sep">·</span>
                  <span>
                    Koszt: <strong>{fmtCost(costUSD)}</strong>
                  </span>
                </div>
              )}

              {generating && genStep && (
                <div className="bgen-progress">
                  <div className="bgen-progress-label">
                    Rozdziały {genStep.doneChapters} / {genStep.totalChapters}
                    {genStep.activeChapters > 0
                      ? ` · aktywne ${genStep.activeChapters}`
                      : ""}
                    {genStep.batchTotal > 0
                      ? genStep.batchDone === 0
                        ? ` — wysyłam ${genStep.batchTotal} zapytań…`
                        : ` — przetworzono ${genStep.batchDone}/${genStep.batchTotal} zapytań`
                      : " — łączenie…"}
                  </div>
                  {genStep.batchTotal > 0 && (
                    <div
                      className="poly-progress-bar"
                      style={{ width: "100%", marginTop: 8 }}
                    >
                      <div
                        className="poly-progress-fill"
                        style={{
                          width: `${(genStep.batchDone / genStep.batchTotal) * 100}%`,
                        }}
                      />
                    </div>
                  )}
                  <div
                    className="poly-progress-bar"
                    style={{ width: "100%", marginTop: 6 }}
                  >
                    <div
                      className="poly-progress-fill"
                      style={{
                        width: `${genStep.totalChapters > 0 ? (genStep.doneChapters / genStep.totalChapters) * 100 : 0}%`,
                        background: "rgba(192,144,80,.35)",
                      }}
                    />
                  </div>
                  <div
                    style={{
                      marginTop: 8,
                      fontSize: 12,
                      color: "var(--txt-2)",
                    }}
                  >
                    Rozdziały są generowane równolegle, a requesty do API są
                    wspólnie limitowane globalnie.
                  </div>
                  {rescueNote && (
                    <div
                      style={{
                        marginTop: 6,
                        fontSize: 12,
                        color: "var(--amber, #c09050)",
                      }}
                    >
                      {rescueNote}
                    </div>
                  )}
                </div>
              )}

              {done && (
                <div className="bgen-done">
                  Generowanie zakończone.{" "}
                  {Object.keys(errors).length > 0
                    ? `${Object.keys(errors).length} błędów.`
                    : "Wszystko gotowe ✓"}
                </div>
              )}
            </>
          )}
        </div>

        <div className="modal-foot">
          {!done ? (
            <button
              className="btn-primary"
              onClick={handleGenerate}
              disabled={generating || toGenerate.length === 0}
            >
              {generating
                ? "Generuję…"
                : `Generuj ${toGenerate.length > 0 ? `(${toGenerate.length})` : ""}`}
            </button>
          ) : (
            <button className="btn-primary" onClick={onClose}>
              Zamknij
            </button>
          )}
          {!generating && (
            <button className="btn-ghost" onClick={onClose}>
              Anuluj
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
