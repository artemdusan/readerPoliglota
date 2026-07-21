import { ActionIcon, Group, Slider, Text } from "@mantine/core";

function TtsControls({ onPrev, prevDisabled, onToggle, paused, onStop, onNext, nextDisabled }) {
  return (
    <Group gap="xs" justify="center" flex={1}>
      <ActionIcon variant="subtle" size="lg" onClick={onPrev} disabled={prevDisabled} title="Poprzedni fragment">
        ⏮
      </ActionIcon>
      <ActionIcon variant="filled" size="lg" onClick={onToggle} title={paused ? "Wznów" : "Pauza"}>
        {paused ? "▶" : "⏸"}
      </ActionIcon>
      <ActionIcon variant="subtle" size="lg" onClick={onStop} title="Zakończ TTS">
        ⏹
      </ActionIcon>
      <ActionIcon variant="subtle" size="lg" onClick={onNext} disabled={nextDisabled} title="Następny akapit">
        ⏭
      </ActionIcon>
    </Group>
  );
}

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
      <ActionIcon
        variant="subtle"
        size="xl"
        onClick={onPrevPage}
        disabled={currentPage === 0 && (chapterIdx ?? 0) === 0}
      >
        ❮
      </ActionIcon>

      {originalTtsPlaying ? (
        <TtsControls
          onPrev={() => onJumpSentence(-1)}
          prevDisabled={activeSid <= 0}
          onToggle={onToggleOriginalTts}
          paused={originalTtsPaused}
          onStop={onStopOriginalTts}
          onNext={() => onJumpSentence(1)}
          nextDisabled={activeSid >= originalTtsFragments.length - 1}
        />
      ) : ttsPlaying ? (
        <TtsControls
          onPrev={() => onJumpPolyParagraph(-1)}
          prevDisabled={activePolyPid <= 0}
          onToggle={onToggleHybridTts}
          paused={ttsPaused}
          onStop={onStopHybridTts}
          onNext={() => onJumpPolyParagraph(1)}
          nextDisabled={activePolyPid >= polyTtsParagraphs.length - 1}
        />
      ) : (
        <div style={{ flex: 1, minWidth: 0 }}>
          <Text size="xs" c="dimmed" ta="center">
            {currentPage + 1}/{totalPages} • {pageProgress}%
          </Text>
          <Slider
            size="xs"
            min={0}
            max={Math.max(totalPages - 1, 0)}
            step={1}
            value={Math.min(currentPage, Math.max(totalPages - 1, 0))}
            disabled={totalPages <= 1}
            label={null}
            aria-label="Przesuń do strony"
            onChange={(value) => onPageSliderChange({ target: { value } })}
            onChangeEnd={(value) => onPageSliderCommit({ target: { value } })}
          />
        </div>
      )}

      <ActionIcon
        variant="subtle"
        size="xl"
        onClick={onNextPage}
        disabled={
          currentPage >= totalPages - 1 && (chapterIdx ?? 0) >= chapterCount - 1
        }
      >
        ❯
      </ActionIcon>
    </div>
  );
}
