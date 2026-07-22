import { useState, useEffect, useMemo } from "react";
import {
  Button,
  Checkbox,
  Group,
  Loader,
  Modal,
  Progress,
  ScrollArea,
  SegmentedControl,
  Select,
  Stack,
  Text,
} from "@mantine/core";
import { getBookChaptersWithCacheStatus, savePolyglotCache, deletePolyglotCache } from "../db";
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

const MAX_PARALLEL_BATCH_REQUESTS = 96;

function getBatchChapterConcurrency(requestConcurrency, chapterCount) {
  const perChapterRequests = Math.max(1, Number(requestConcurrency) || 1);
  const chapters = Math.max(0, Number(chapterCount) || 0);
  if (!chapters) return 1;
  return Math.max(
    1,
    Math.min(
      chapters,
      Math.floor(MAX_PARALLEL_BATCH_REQUESTS / perChapterRequests),
    ),
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

export default function BatchGenModal({
  bookId,
  book,
  settings,
  onClose,
}) {
  const [selectedLang, setSelectedLang] = useState(() => {
    const code =
      localStorage.getItem("vocabapp:lastLang") || settings.targetLang;
    return LANGUAGES.find((l) => l.code === code) ?? LANGUAGES[0];
  });
  const [chapters, setChapters] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(new Set());
  const [mode, setMode] = useState("generate");
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
      setSelected(
        mode === "delete"
          ? new Set(chs.filter((c) => c.hasPoly).map((c) => c.id))
          : new Set(chs.filter((c) => !c.hasPoly).map((c) => c.id)),
      );
      setLoading(false);
    });
  }, [bookId, selectedLang.code, mode]);

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
          ),
        ]),
      ),
    [toGenerate],
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
      (sum, chapter) => sum + (chapter.html?.length ?? 0),
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
    setSelected(
      new Set(
        (mode === "delete" ? chapters.filter((c) => c.hasPoly) : chapters).map(
          (c) => c.id,
        ),
      ),
    );
  }
  function selectNone() {
    setSelected(new Set());
  }

  function handleLangChange(code) {
    const lang = LANGUAGES.find((item) => item.code === code) ?? LANGUAGES[0];
    setSelectedLang(lang);
    setDone(false);
    setErrors({});
  }

  function switchMode(m) {
    setMode(m);
    setDone(false);
    setErrors({});
  }

  async function handleDelete() {
    setGenerating(true);
    setDone(false);
    setErrors({});
    const toDelete = chapters.filter((c) => selected.has(c.id) && c.hasPoly);
    for (const ch of toDelete) {
      await deletePolyglotCache(ch.id, selectedLang.code);
    }
    setGenerating(false);
    setDone(true);
    // refresh chapters list
    const chs = await getBookChaptersWithCacheStatus(bookId, selectedLang.code);
    setChapters(chs);
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
          { html: chapter.html },
          {
            targetLangName: selectedLang.name,
            sourceLangName: book?.lang || "",
            model: POLYGLOT_MODEL_ID,
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
        {
          length: getBatchChapterConcurrency(
            requestConcurrency,
            toGenerate.length,
          ),
        },
        () => workerLoop(),
      ),
    );

    setGenerating(false);
    setGenStep(null);
    setRescueNote("");
    setDone(true);
  }

  const errorCount = Object.keys(errors).length;

  return (
    <Modal
      opened
      onClose={() => { if (!generating) onClose(); }}
      title={`Tłumaczenia${book?.title ? ` — ${book.title}` : ""}`}
      centered
      size="lg"
    >
      {loading ? (
        <Group justify="center" p="xl"><Loader size="sm" /></Group>
      ) : (
        <Stack gap="md">
          <Select
            label="Język tłumaczenia"
            description={`Przetłumaczono ${chapters.filter((c) => c.hasPoly).length} z ${chapters.length} rozdziałów`}
            data={LANGUAGES.map((l) => ({
              value: l.code,
              label: `${l.flag} ${l.label} (${l.name})`,
            }))}
            value={selectedLang.code}
            onChange={(value) => value && handleLangChange(value)}
            disabled={generating}
            allowDeselect={false}
          />

          <SegmentedControl
            fullWidth
            value={mode}
            onChange={switchMode}
            disabled={generating}
            data={[
              { value: "generate", label: "Generuj brakujące" },
              {
                value: "delete",
                label: "Usuń istniejące",
                disabled: chapters.every((c) => !c.hasPoly),
              },
            ]}
          />

          <Stack gap="xs">
            <Group justify="space-between">
              <Text size="sm" fw={600}>
                Rozdziały ({mode === "delete" ? chapters.filter((c) => c.hasPoly).length : chapters.length})
              </Text>
              <Group gap={6}>
                <Button variant="default" size="compact-xs" onClick={selectAll} disabled={generating}>
                  Wszystkie
                </Button>
                <Button variant="default" size="compact-xs" onClick={selectNone} disabled={generating}>
                  Żadne
                </Button>
              </Group>
            </Group>
            <ScrollArea.Autosize mah={300}>
              <Stack gap={6}>
                {chapters
                  .filter((ch) => (mode === "delete" ? ch.hasPoly : true))
                  .map((ch, i) => (
                    <Checkbox
                      key={ch.id}
                      checked={selected.has(ch.id)}
                      disabled={generating}
                      onChange={() => toggleChapter(ch.id)}
                      color={errors[ch.id] ? "red" : undefined}
                      label={
                        <Group gap={6} wrap="nowrap">
                          <span>{i + 1}. {ch.title || `Rozdział ${i + 1}`}</span>
                          {errors[ch.id] ? (
                            <Text span size="xs" c="red" title={errors[ch.id]}>●</Text>
                          ) : ch.hasPoly ? (
                            <Text span size="xs" title="Tłumaczenie istnieje">●</Text>
                          ) : null}
                        </Group>
                      }
                    />
                  ))}
              </Stack>
            </ScrollArea.Autosize>
          </Stack>

          {toGenerate.length > 0 && !generating && !done && mode === "generate" && (
            <Group gap="lg">
              {[
                [toGenerate.length, "rozdziałów"],
                [totalSentences, "zdań"],
                [fmtTime(timeSec), "czas"],
                [fmtCost(costUSD), "koszt"],
              ].map(([val, key]) => (
                <Stack key={key} gap={0} align="center">
                  <Text fw={700}>{val}</Text>
                  <Text size="xs" c="dimmed">{key}</Text>
                </Stack>
              ))}
            </Group>
          )}

          {generating && genStep && (
            <Stack gap={6}>
              <Text size="sm">
                Rozdziały {genStep.doneChapters} / {genStep.totalChapters}
                {genStep.batchTotal > 0
                  ? genStep.batchDone === 0
                    ? ` — wysyłam ${genStep.batchTotal} zapytań…`
                    : ` — ${genStep.batchDone}/${genStep.batchTotal} zapytań`
                  : " — łączenie…"}
              </Text>
              {genStep.batchTotal > 0 && (
                <Progress value={(genStep.batchDone / genStep.batchTotal) * 100} />
              )}
              {rescueNote && <Text size="xs" c="dimmed">{rescueNote}</Text>}
            </Stack>
          )}

          {done && (
            <Text size="sm" c={errorCount > 0 ? "red" : undefined}>
              {errorCount > 0
                ? <>Zakończono z <strong>{errorCount}</strong> błędami.</>
                : "Wszystkie tłumaczenia gotowe."}
            </Text>
          )}

          <Group justify="flex-end">
            {!generating && !done && (
              <Button variant="subtle" onClick={onClose}>Anuluj</Button>
            )}
            {!done ? (
              mode === "delete" ? (
                <Button onClick={handleDelete} loading={generating} disabled={selected.size === 0}>
                  {`Usuń (${selected.size})`}
                </Button>
              ) : (
                <Button onClick={handleGenerate} loading={generating} disabled={toGenerate.length === 0}>
                  {`Przetłumacz ${toGenerate.length > 0 ? `(${toGenerate.length})` : ""}`}
                </Button>
              )
            ) : (
              <Button onClick={onClose}>Zamknij</Button>
            )}
          </Group>
        </Stack>
      )}
    </Modal>
  );
}
