function renderEstimateTime(estimatedSecs) {
  return estimatedSecs < 60
    ? `${estimatedSecs}s`
    : `${Math.round(estimatedSecs / 60)} min`;
}

function renderCount(count, one, few, many) {
  if (count === 1) return `${count} ${one}`;
  if (count < 5) return `${count} ${few}`;
  return `${count} ${many}`;
}

export default function ReaderChapterContent({
  scrollRef,
  innerRef,
  animKey,
  chapterLoading,
  chapter,
  polyMode,
  polyState,
  confirmLang,
  languages,
  batchOptions,
  estimatedSentenceCount,
  estimatedBatchCount,
  estimatedSecs,
  estimatedCost,
  sentencesPerRequest,
  onSentencesPerRequestChange,
  onConfirmLangChange,
  onStartGeneration,
  onCancelConfirm,
  polyLoadingText,
  polyProgress,
  polyDisplaySecs,
  polyRescueNote,
  polyError,
  onDismissPolyError,
  activeLang,
  chapterBodyRef,
  polyWordFragments,
  ttsPlaying,
  renderedPolyHtml,
  onContentClick,
  originalTtsPlaying,
  originalHtmlAnnotated,
}) {
  const originalHtml =
    originalHtmlAnnotated ||
    chapter?.html ||
    '<p style="color:var(--txt-3);font-style:italic">Ten rozdział nie zawiera tekstu.</p>';

  return (
    <div className="ch-scroll" ref={scrollRef}>
      <div className="ch-columns" ref={innerRef} key={animKey}>
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
                  <div className="poly-confirm-config">
                    <div className="poly-confirm-field">
                      <span className="poly-confirm-field-label">
                        Język tłumaczenia
                      </span>
                      <select
                        className="form-select"
                        value={confirmLang}
                        onChange={(event) =>
                          onConfirmLangChange(event.target.value)
                        }
                      >
                        {languages.map((lang) => (
                          <option key={lang.code} value={lang.code}>
                            {lang.flag} {lang.label} ({lang.name})
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="poly-confirm-field">
                      <span className="poly-confirm-field-label">
                        Paczka AI
                      </span>
                      <select
                        className="form-select"
                        value={sentencesPerRequest ?? 4}
                        onChange={(event) =>
                          onSentencesPerRequestChange?.(
                            Number(event.target.value),
                          )
                        }
                      >
                        {batchOptions.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label} na zapytanie
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <p className="poly-confirm-hint">
                    <strong>
                      {renderCount(
                        estimatedSentenceCount,
                        "zdanie",
                        "zdania",
                        "zdań",
                      )}
                    </strong>
                    {" · "}
                    <strong>
                      {renderCount(
                        estimatedBatchCount,
                        "zapytanie",
                        "zapytania",
                        "zapytań",
                      )}
                    </strong>
                    {" · ~"}
                    {renderEstimateTime(estimatedSecs)}
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
                    <button className="btn-primary" onClick={onStartGeneration}>
                      Generuj tłumaczenia
                    </button>
                    <button className="btn-ghost" onClick={onCancelConfirm}>
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
                          <span style={{ color: "var(--txt-3)" }}>~$0.00</span>
                        )}
                      </div>
                    </>
                  )}
                  <p className="poly-loading-hint">
                    Nie zamykaj strony i nie zmieniaj rozdziału do końca
                    generowania.
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
                  <button className="btn-ghost" onClick={onDismissPolyError}>
                    Wróć
                  </button>
                </div>
              )}

              {polyMode && polyState === "done" && (
                <div
                  key={activeLang}
                  ref={chapterBodyRef}
                  className={`ch-body ch-anim${
                    polyWordFragments.length ? " tts-ready" : ""
                  }${ttsPlaying ? " audio-ready" : ""}`}
                  dangerouslySetInnerHTML={{ __html: renderedPolyHtml }}
                  onClick={onContentClick}
                />
              )}

              {!polyMode && (
                <div
                  ref={chapterBodyRef}
                  className={`ch-body ch-anim${originalTtsPlaying ? " audio-ready" : ""}`}
                  dangerouslySetInnerHTML={{ __html: originalHtml }}
                  onClick={onContentClick}
                />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
