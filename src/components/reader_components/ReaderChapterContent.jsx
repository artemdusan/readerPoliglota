import { Button, Group, Loader, NativeSelect, Paper, Progress, Stack, Text } from "@mantine/core";

function renderEstimateTime(estimatedSecs) {
  return estimatedSecs < 60
    ? `${estimatedSecs}s`
    : `${Math.round(estimatedSecs / 60)} min`;
}

function pluralWord(count, one, few, many) {
  if (count === 1) return one;
  if (count < 5) return few;
  return many;
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
  estimatedSentenceCount,
  estimatedBatchCount,
  estimatedSecs,
  estimatedCost,
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
    <div className="ch-scroll" ref={scrollRef} onClick={onContentClick}>
      <div className="ch-columns" ref={innerRef} key={animKey}>
        <div className="ch-inner">
          {chapterLoading ? (
            <Group justify="center" p="xl"><Loader /></Group>
          ) : !chapter ? (
            <Text c="dimmed" fs="italic" size="sm">
              Nie można wczytać rozdziału.
            </Text>
          ) : (
            <>
              {polyMode && polyState === "confirm" && (
                <div className="ch-anim">
                  <Paper withBorder p="lg" maw={420} mx="auto" mt="10dvh">
                    <Stack gap="sm">
                      <div>
                        <Text fw={700}>Przetłumacz rozdział</Text>
                        <Text size="sm" c="dimmed">{chapter?.title || "Bieżący rozdział"}</Text>
                      </div>

                      <NativeSelect
                        label="Język tłumaczenia"
                        value={confirmLang}
                        onChange={(event) => onConfirmLangChange(event.target.value)}
                        data={languages.map((lang) => ({
                          value: lang.code,
                          label: `${lang.flag} ${lang.label} (${lang.name})`,
                        }))}
                      />

                      <Group gap="lg">
                        <Stack gap={0} align="center">
                          <Text fw={700}>{estimatedSentenceCount}</Text>
                          <Text size="xs" c="dimmed">
                            {pluralWord(estimatedSentenceCount, "zdanie", "zdania", "zdań")}
                          </Text>
                        </Stack>
                        <Stack gap={0} align="center">
                          <Text fw={700}>~{renderEstimateTime(estimatedSecs)}</Text>
                          <Text size="xs" c="dimmed">czas</Text>
                        </Stack>
                        {estimatedCost > 0 && (
                          <Stack gap={0} align="center">
                            <Text fw={700}>
                              {estimatedCost < 0.001 ? "< $0.001" : `~$${estimatedCost.toFixed(3)}`}
                            </Text>
                            <Text size="xs" c="dimmed">koszt</Text>
                          </Stack>
                        )}
                      </Group>

                      <Group>
                        <Button onClick={onStartGeneration}>Przetłumacz</Button>
                        <Button variant="subtle" onClick={onCancelConfirm}>Anuluj</Button>
                      </Group>

                      <Text size="xs" c="dimmed">
                        Podczas generowania nie zamykaj strony ani nie zmieniaj rozdziału.
                      </Text>
                    </Stack>
                  </Paper>
                </div>
              )}

              {polyMode && polyState === "loading" && (
                <Stack align="center" gap="sm" p="xl">
                  <Loader />
                  <Text size="sm">{polyLoadingText}</Text>
                  {polyProgress.total > 0 && (
                    <>
                      <Progress
                        w="100%"
                        maw={320}
                        value={(polyProgress.done / polyProgress.total) * 100}
                      />
                      <Group gap="md">
                        {polyDisplaySecs > 0 && (
                          <Text size="xs">{polyDisplaySecs.toFixed(1)}s</Text>
                        )}
                        <Text size="xs" c={polyProgress.cost > 0 ? undefined : "dimmed"}>
                          {polyProgress.cost > 0 ? `~$${polyProgress.cost.toFixed(4)}` : "~$0.00"}
                        </Text>
                      </Group>
                    </>
                  )}
                  <Text size="xs" c="dimmed">
                    Nie zamykaj strony i nie zmieniaj rozdziału do końca generowania.
                  </Text>

                  {polyRescueNote && (
                    <Text size="xs" c="dimmed">{polyRescueNote}</Text>
                  )}
                </Stack>
              )}

              {polyMode && polyState === "error" && (
                <Stack align="center" gap="sm" p="xl">
                  <Text c="red">⚠ {polyError}</Text>
                  <Button variant="subtle" onClick={onDismissPolyError}>Wróć</Button>
                </Stack>
              )}

              {polyMode && polyState === "done" && (
                <div
                  key={activeLang}
                  ref={chapterBodyRef}
                  className={`ch-body ch-anim${
                    polyWordFragments.length ? " tts-ready" : ""
                  }${ttsPlaying ? " audio-ready" : ""}`}
                  dangerouslySetInnerHTML={{ __html: renderedPolyHtml }}
                />
              )}

              {!polyMode && (
                <div
                  ref={chapterBodyRef}
                  className={`ch-body ch-anim${originalTtsPlaying ? " audio-ready" : ""}`}
                  dangerouslySetInnerHTML={{ __html: originalHtml }}
                />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
