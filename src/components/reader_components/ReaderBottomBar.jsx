export default function ReaderBottomBar({
  currentPage,
  totalPages,
  chapterIdx,
  chapterCount,
  onPrevPage,
  onNextPage,
  originalTtsPlaying,
  activeSid,
  onJumpSentence,
  onToggleOriginalTts,
  originalTtsPaused,
  onStopOriginalTts,
  originalTtsFragments,
  ttsPlaying,
  activePolyPid,
  onJumpPolyParagraph,
  onToggleHybridTts,
  ttsPaused,
  onStopHybridTts,
  polyTtsParagraphs,
  onPageSliderChange,
  onPageSliderCommit,
}) {
  const pageProgress =
    totalPages > 1 ? Math.round((currentPage / (totalPages - 1)) * 100) : 0;

  return (
    <div className="bottombar">
      <button
        className="nav-btn"
        onClick={onPrevPage}
        disabled={currentPage === 0 && (chapterIdx ?? 0) === 0}
      >
        ❮
      </button>

      {originalTtsPlaying ? (
        <div className="tts-inline">
          <button
            className="tts-bar-btn"
            onClick={() => onJumpSentence(-1)}
            disabled={activeSid <= 0}
            title="Poprzedni fragment"
          >
            ⏮
          </button>
          <button
            className="tts-bar-btn tts-bar-play active"
            onClick={onToggleOriginalTts}
            title={originalTtsPaused ? "Wznów" : "Pauza"}
          >
            {originalTtsPaused ? "▶" : "⏸"}
          </button>
          <button
            className="tts-bar-btn"
            onClick={onStopOriginalTts}
            title="Zakończ TTS"
          >
            ⏹
          </button>
          <button
            className="tts-bar-btn"
            onClick={() => onJumpSentence(1)}
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
            onClick={() => onJumpPolyParagraph(-1)}
            disabled={activePolyPid <= 0}
            title="Poprzedni fragment"
          >
            ⏮
          </button>
          <button
            className="tts-bar-btn tts-bar-play active"
            onClick={onToggleHybridTts}
            title={ttsPaused ? "Wznów" : "Pauza"}
          >
            {ttsPaused ? "▶" : "⏸"}
          </button>
          <button
            className="tts-bar-btn"
            onClick={onStopHybridTts}
            title="Zakończ TTS"
          >
            ⏹
          </button>
          <button
            className="tts-bar-btn"
            onClick={() => onJumpPolyParagraph(1)}
            disabled={activePolyPid >= polyTtsParagraphs.length - 1}
            title="Następny akapit"
          >
            ⏭
          </button>
        </div>
      ) : (
        <div className="prog-wrap">
          <div className="prog-lbl">
            {currentPage + 1}/{totalPages} • {pageProgress}%
          </div>
          <input
            className="page-slider"
            type="range"
            min="0"
            max={Math.max(totalPages - 1, 0)}
            step="1"
            value={Math.min(currentPage, Math.max(totalPages - 1, 0))}
            disabled={totalPages <= 1}
            aria-label="Przesuń do strony"
            onChange={onPageSliderChange}
            onPointerUp={onPageSliderCommit}
            onMouseUp={onPageSliderCommit}
            onTouchEnd={onPageSliderCommit}
            onKeyUp={onPageSliderCommit}
          />
        </div>
      )}

      <button
        className="nav-btn"
        onClick={onNextPage}
        disabled={
          currentPage >= totalPages - 1 && (chapterIdx ?? 0) >= chapterCount - 1
        }
      >
        ❯
      </button>
    </div>
  );
}
