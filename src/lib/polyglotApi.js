import { getToken } from "../sync/cfAuth";
import { getWorkerUrl } from "../config/workerUrl";
import { buildSentencePatchSource } from "./polyglotStructure";

const WORKER_URL = getWorkerUrl();
const REQUEST_TIMEOUT_MS = 90_000;
const STALL_TIMEOUT_MS = 150_000;
const STALL_RETRY_LIMIT = 1;
const STALL_CHECK_INTERVAL_MS = 10_000;
const NETWORK_RETRY_LIMIT = 1;
const GLOBAL_REQUESTS_PER_MINUTE = 1800;
const GLOBAL_REQUEST_INTERVAL_MS = Math.ceil(
  60_000 / GLOBAL_REQUESTS_PER_MINUTE,
);
export const DEFAULT_POLYGLOT_SENTENCES_PER_REQUEST = 4;
export const MAX_POLYGLOT_SENTENCES_PER_REQUEST = 12;
const MAX_SENTENCES_IN_FLIGHT = 24;

let globalRequestGate = Promise.resolve();
let nextGlobalRequestAt = 0;

/** Approximate pricing in USD per 1 000 tokens (input / output) */
export const MODEL_PRICING = {
  "grok-4.20-0309-non-reasoning": { input: 0.002, output: 0.006 },
  "deepseek-chat": { input: 0.00007, output: 0.00028 },
  "deepseek-reasoner": { input: 0.00055, output: 0.00219 },
  "gpt-4o-mini": { input: 0.00015, output: 0.0006 },
  "gpt-4o": { input: 0.0025, output: 0.01 },
  "google/gemini-flash-1.5": { input: 0.000075, output: 0.0003 },
  "meta-llama/llama-3.3-70b-instruct": { input: 0, output: 0 },
  "anthropic/claude-3.5-haiku": { input: 0.0008, output: 0.004 },
};

function buildSentencePatchSystemPrompt(
  targetLangName,
  sourceLangName,
  { strictJson = false } = {},
) {
  const sourceHint = sourceLangName
    ? ` Tekst zrodlowy jest w jezyku ${sourceLangName}.`
    : "";
  const strictHint = strictJson
    ? `
- odpowiedz ma byc pojedynczym obiektem JSON, bez komentarzy, bez markdownu i bez dodatkowego tekstu
- kazdy element changes ma miec dokladnie pola "id" i "text"
- jesli nic nie zmieniasz, zwroc {"changes":[]}`
    : "";

  return `Jestes precyzyjnym edytorem tekstu do nauki jezyka ${targetLangName}.${sourceHint}

Wejscie zawiera uporzadkowana liste jednego lub kilku zdan:
{"sentences":[{"id":"s1","text":"..."},{"id":"s2","text":"..."}]}

Zasady:
- pracujesz zdanie po zdaniu
- zaznaczaj tylko rzeczowniki i przymiotniki
- mozesz zaznaczyc zero, jedno lub kilka slow w zdaniu
- wybieraj naturalne, przydatne slowa do nauki; zwykle 1-3 na zdanie wystarcza
- nie zaznaczaj czasownikow, imion wlasnych, nazw wlasnych, liczb, dat, skrotow ani znakow interpunkcyjnych
- kazdy marker ma format [tlumaczenie::oryginal]
- marker musi obejmowac dokladnie jedno slowo z oryginalu
- lewa strona markera: slowo w jezyku ${targetLangName}
- prawa strona markera: oryginalne slowo
- uzywaj identyfikatorow dokladnie takich, jakie dostales na wejsciu
- poza markerami zachowaj dokladnie kolejnosc slow, interpunkcje i sens zdania
- nie parafrazuj, nie dopisuj wyjasnien, nie zmieniaj skladni
- dodaj element do tablicy changes tylko wtedy, gdy naprawde cos oznaczyles
${strictHint}

Zwroc tylko JSON bez markdownu:
{"changes":[{"id":"s1","text":"..."}]}`;
}

function normalizeSentencesPerRequest(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return DEFAULT_POLYGLOT_SENTENCES_PER_REQUEST;
  }
  return Math.max(
    1,
    Math.min(MAX_POLYGLOT_SENTENCES_PER_REQUEST, Math.round(numeric)),
  );
}

function getBatchConcurrency(sentencesPerRequest) {
  return Math.max(
    1,
    Math.floor(MAX_SENTENCES_IN_FLIGHT / normalizeSentencesPerRequest(sentencesPerRequest)),
  );
}

function buildSentenceBatches(
  sentences,
  sentencesPerRequest = DEFAULT_POLYGLOT_SENTENCES_PER_REQUEST,
) {
  const batchSize = normalizeSentencesPerRequest(sentencesPerRequest);
  const batches = [];
  for (let index = 0; index < sentences.length; index += batchSize) {
    batches.push(sentences.slice(index, index + batchSize));
  }
  return batches;
}

export function estimatePolyglotGeneration(chapterInput, options = {}) {
  const chapterHtml =
    typeof chapterInput === "string"
      ? chapterInput
      : (chapterInput?.html ?? "");
  const sentencesPerRequest = normalizeSentencesPerRequest(
    options.sentencesPerRequest ?? chapterInput?.sentencesPerRequest,
  );

  if (!chapterHtml) {
    return {
      generationBatches: 0,
      sentenceCount: 0,
      sentencesPerRequest,
      requestConcurrency: getBatchConcurrency(sentencesPerRequest),
    };
  }

  const source = buildSentencePatchSource(chapterHtml);
  const generationBatches = buildSentenceBatches(
    source.sentences,
    sentencesPerRequest,
  ).length;
  return {
    generationBatches,
    sentenceCount: source.sentences.length,
    sentencesPerRequest,
    requestConcurrency: getBatchConcurrency(sentencesPerRequest),
  };
}

function createAbortError(message) {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function getAbortReason(signal) {
  return signal?.reason instanceof Error
    ? signal.reason
    : createAbortError("Generowanie anulowano.");
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw getAbortReason(signal);
  }
}

function waitForTimeout(ms, signal) {
  if (!ms || ms <= 0) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timeoutId);
      signal?.removeEventListener("abort", onAbort);
      reject(getAbortReason(signal));
    };

    if (signal?.aborted) {
      onAbort();
      return;
    }

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function waitForGlobalRequestSlot(signal) {
  let releaseGate;
  const nextGate = new Promise((resolve) => {
    releaseGate = resolve;
  });
  const previousGate = globalRequestGate;
  globalRequestGate = nextGate;

  await previousGate;

  try {
    throwIfAborted(signal);
    const now = Date.now();
    const waitMs = Math.max(0, nextGlobalRequestAt - now);
    nextGlobalRequestAt =
      Math.max(nextGlobalRequestAt, now) + GLOBAL_REQUEST_INTERVAL_MS;
    await waitForTimeout(waitMs, signal);
  } finally {
    releaseGate();
  }
}

function attachAbortSignal(signal, controller) {
  if (!signal) return () => {};

  const abortWithReason = () => {
    controller.abort(
      signal.reason ?? createAbortError("Generowanie anulowano."),
    );
  };

  if (signal.aborted) {
    abortWithReason();
    return () => {};
  }

  signal.addEventListener("abort", abortWithReason, { once: true });
  return () => {
    signal.removeEventListener("abort", abortWithReason);
  };
}

function createTimedController(timeoutMs, message, signal) {
  const controller = new AbortController();
  const startedAt = Date.now();
  const detachSignal = attachAbortSignal(signal, controller);

  const abortIfExpired = () => {
    if (controller.signal.aborted) return;
    if (Date.now() - startedAt >= timeoutMs) {
      controller.abort(createAbortError(message));
    }
  };

  const timeoutId = setTimeout(() => {
    controller.abort(createAbortError(message));
  }, timeoutMs);

  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", abortIfExpired);
  }
  if (typeof window !== "undefined") {
    window.addEventListener("focus", abortIfExpired);
    window.addEventListener("pageshow", abortIfExpired);
  }

  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timeoutId);
      detachSignal();
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", abortIfExpired);
      }
      if (typeof window !== "undefined") {
        window.removeEventListener("focus", abortIfExpired);
        window.removeEventListener("pageshow", abortIfExpired);
      }
    },
  };
}

function createStallMonitor(stallMs, onStall) {
  let lastActivityAt = Date.now();

  const touch = () => {
    lastActivityAt = Date.now();
  };

  const check = () => {
    if (
      typeof document !== "undefined" &&
      document.visibilityState === "hidden"
    ) {
      return;
    }
    if (Date.now() - lastActivityAt >= stallMs) {
      onStall(Date.now() - lastActivityAt);
    }
  };

  const intervalId = setInterval(check, STALL_CHECK_INTERVAL_MS);

  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", check);
  }
  if (typeof window !== "undefined") {
    window.addEventListener("focus", check);
    window.addEventListener("pageshow", check);
  }

  return {
    touch,
    cleanup() {
      clearInterval(intervalId);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", check);
      }
      if (typeof window !== "undefined") {
        window.removeEventListener("focus", check);
        window.removeEventListener("pageshow", check);
      }
    },
  };
}

async function processBatch(
  messages,
  model,
  maxTokens = 4096,
  { signal } = {},
) {
  const token = getToken();
  if (!token) {
    throw new Error("Nie jestes zalogowany. Zaloguj sie w Ustawieniach.");
  }

  const timedSignal = createTimedController(
    REQUEST_TIMEOUT_MS,
    "Przekroczono limit czasu (90s). Sprawdz polaczenie z API.",
    signal,
  );

  try {
    const resp = await fetch(`${WORKER_URL}/translate`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        messages,
      }),
      signal: timedSignal.signal,
    });

    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      throw new Error(body.error || `Worker error ${resp.status}`);
    }

    const { content, usage } = await resp.json();
    return {
      text: content ?? "",
      promptTokens: usage?.prompt_tokens ?? 0,
      completionTokens: usage?.completion_tokens ?? 0,
    };
  } catch (err) {
    if (err.name === "AbortError") {
      throw timedSignal.signal.reason instanceof Error
        ? timedSignal.signal.reason
        : new Error(
            "Przekroczono limit czasu (90s). Sprawdz polaczenie z API.",
          );
    }
    throw err;
  } finally {
    timedSignal.cleanup();
  }
}

async function processBatchWithRetry(
  { messages, model, maxTokens, label, batchIdx, signal, onActivity },
  attempt = 0,
) {
  const startedAt = Date.now();
  onActivity?.();
  console.log(
    `[Polyglot] ${label} ${batchIdx + 1} -> wysylam (${model}, max_tokens=${maxTokens})`,
  );

  try {
    await waitForGlobalRequestSlot(signal);
    onActivity?.();
    const result = await processBatch(messages, model, maxTokens, { signal });
    onActivity?.();
    const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(
      `[Polyglot] ${label} ${batchIdx + 1} ok - ${secs}s, in:${result.promptTokens} out:${result.completionTokens}`,
    );
    return result;
  } catch (err) {
    onActivity?.();
    console.warn(
      `[Polyglot] ${label} ${batchIdx + 1} blad (proba ${attempt + 1}): ${err.message}`,
    );
    if (signal?.aborted || attempt >= NETWORK_RETRY_LIMIT) {
      throw err;
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
    return processBatchWithRetry(
      { messages, model, maxTokens, label, batchIdx, signal, onActivity },
      attempt + 1,
    );
  }
}

function normalizeJsonishText(text) {
  return String(text ?? "")
    .replace(/^\uFEFF/, "")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/\u00A0/g, " ")
    .trim();
}

function stripMarkdownFence(text) {
  return String(text ?? "")
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function extractJsonBlocks(text) {
  const source = String(text ?? "");
  const blocks = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let quoteChar = "";
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === quoteChar) {
        inString = false;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      inString = true;
      quoteChar = char;
      continue;
    }

    if (char === "{" || char === "[") {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }

    if ((char === "}" || char === "]") && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        blocks.push(source.slice(start, index + 1));
        start = -1;
      }
    }
  }

  return blocks;
}

function repairCommonJsonIssues(text) {
  return String(text ?? "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\bNone\b/g, "null")
    .replace(/\bTrue\b/g, "true")
    .replace(/\bFalse\b/g, "false")
    .replace(/([{,]\s*)'([^'\\]*(?:\\.[^'\\]*)*)'\s*:/g, '$1"$2":')
    .replace(/:\s*'([^'\\]*(?:\\.[^'\\]*)*)'(?=\s*[,}\]])/g, ': "$1"')
    .replace(/,\s*([}\]])/g, "$1")
    .trim();
}

function parseJsonResponse(text) {
  const normalized = normalizeJsonishText(text);
  const cleaned = stripMarkdownFence(normalized);
  const candidates = [];
  const seen = new Set();

  function pushCandidate(candidate) {
    const value = String(candidate ?? "").trim();
    if (!value || seen.has(value)) return;
    seen.add(value);
    candidates.push(value);
  }

  pushCandidate(cleaned);
  pushCandidate(repairCommonJsonIssues(cleaned));
  extractJsonBlocks(cleaned).forEach((block) => {
    pushCandidate(block);
    pushCandidate(repairCommonJsonIssues(block));
  });

  let lastError;
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("Invalid JSON response");
}

function normalizeComparisonText(text) {
  return String(text ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function countLexicalTokens(text) {
  const matches = String(text ?? "").match(
    /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu,
  );
  return matches?.length ?? 0;
}

function extractMarkers(text) {
  const markers = [];
  const rx = /\[([^\]]+?)::([^\]]+?)\]/g;
  let match;

  while ((match = rx.exec(String(text ?? ""))) !== null) {
    markers.push({
      full: match[0],
      target: match[1].trim(),
      original: match[2].trim(),
    });
  }

  return markers;
}

function replaceMarkers(text, replacer) {
  const sourceText = String(text ?? "");
  const rx = /\[([^\]]+?)::([^\]]+?)\]/g;
  let result = "";
  let last = 0;
  let match;

  while ((match = rx.exec(sourceText)) !== null) {
    result += sourceText.slice(last, match.index);
    result += replacer({
      full: match[0],
      target: match[1].trim(),
      original: match[2].trim(),
    });
    last = match.index + match[0].length;
  }

  return result + sourceText.slice(last);
}

function validateSentenceChangeLocally(sourceText, candidateText) {
  const candidate = String(candidateText ?? "").trim();
  if (!candidate) return { ok: false, reasons: ["empty"] };

  const markers = extractMarkers(candidate);
  if (!markers.length) return { ok: false, reasons: ["no_markers"] };

  const sourceNormalized = normalizeComparisonText(sourceText);

  for (const marker of markers) {
    const targetNormalized = normalizeComparisonText(marker.target);
    const originalNormalized = normalizeComparisonText(marker.original);

    if (!targetNormalized || !originalNormalized) {
      return { ok: false, reasons: ["empty_marker_side"] };
    }
    if (targetNormalized === originalNormalized) {
      return { ok: false, reasons: ["marker_not_translated"] };
    }
    if (countLexicalTokens(marker.original) !== 1) {
      return { ok: false, reasons: ["source_marker_not_single_word"] };
    }
    if (countLexicalTokens(marker.target) !== 1) {
      return { ok: false, reasons: ["target_marker_not_single_word"] };
    }
    if (!sourceNormalized.includes(originalNormalized)) {
      return { ok: false, reasons: ["source_side_mismatch"] };
    }
  }

  const recoveredOriginal = normalizeComparisonText(
    replaceMarkers(candidate, (marker) => marker.original),
  );
  if (recoveredOriginal !== sourceNormalized) {
    return { ok: false, reasons: ["structure_mismatch"] };
  }

  return { ok: true, text: candidate, markerCount: markers.length };
}

function extractRawChanges(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== "object") return null;
  if (Array.isArray(data.changes)) return data.changes;
  if (Array.isArray(data.items)) return data.items;
  if (Array.isArray(data.sentences)) return data.sentences;
  if (Array.isArray(data.patches)) return data.patches;
  if (
    data.changes &&
    typeof data.changes === "object" &&
    !Array.isArray(data.changes)
  ) {
    return Object.entries(data.changes).map(([id, text]) => ({ id, text }));
  }
  return null;
}

function normalizeRawChange(change) {
  if (!change || typeof change !== "object") return null;

  const id = [
    change.id,
    change.sentenceId,
    change.sentence_id,
    change.key,
  ].find((value) => typeof value === "string" && value.trim());
  const text = [
    change.text,
    change.value,
    change.content,
    change.sentence,
    change.patchedText,
    change.patched_text,
  ].find((value) => typeof value === "string" && value.trim());

  if (!id || !text) return null;
  return {
    id: id.trim(),
    text: text.trim(),
  };
}

function parseSentencePatchResponse(text, batchSentences) {
  let data;
  try {
    data = parseJsonResponse(text);
  } catch {
    throw new Error("Model nie zwrocil poprawnego JSON dla zmian.");
  }

  const rawChanges = extractRawChanges(data);
  if (!rawChanges) {
    throw new Error("Model zwrocil nieprawidlowy format zmian.");
  }

  const originalById = new Map(
    batchSentences.map((sentence) => [sentence.id, sentence.text]),
  );

  return rawChanges
    .map(normalizeRawChange)
    .filter(Boolean)
    .filter(
      (change) =>
        originalById.has(change.id) &&
        change.text &&
        change.text !== originalById.get(change.id),
    );
}

function estimateBatchCost(pricing, promptTokens, completionTokens) {
  return (
    (promptTokens / 1000) * pricing.input +
    (completionTokens / 1000) * pricing.output
  );
}

function buildSentencePatchRequest(
  sentences,
  { targetLangName, sourceLangName = "", model },
) {
  const maxTokens = Math.max(
    320,
    Math.min(1600, 180 + sentences.length * 220),
  );

  return {
    label: "patch",
    model,
    maxTokens,
    messages: [
      {
        role: "system",
        content: buildSentencePatchSystemPrompt(
          targetLangName,
          sourceLangName,
          {
            strictJson: true,
          },
        ),
      },
      {
        role: "user",
        content: JSON.stringify({
          sentences: sentences.map((sentence) => ({
            id: sentence.id,
            text: sentence.text,
          })),
        }),
      },
    ],
  };
}

async function generateSentenceBatch(sentences, options, pricing, batchIdx) {
  const request = buildSentencePatchRequest(sentences, options);
  const startedAt = Date.now();
  const { text, promptTokens, completionTokens } = await processBatchWithRetry({
    ...request,
    batchIdx,
    signal: options.signal,
    onActivity: options.onActivity,
  });

  const cost = estimateBatchCost(pricing, promptTokens, completionTokens);
  const elapsedMs = Date.now() - startedAt;

  try {
    return {
      changes: parseSentencePatchResponse(text, sentences),
      cost,
      elapsedMs,
    };
  } catch (error) {
    console.warn(
      `[Polyglot] patch ${batchIdx + 1} pomijam odpowiedz (${error.message})`,
    );
    return {
      changes: [],
      cost,
      elapsedMs,
    };
  }
}

async function runSentencePatchBatches(batches, options, pricing, onProgress) {
  const startTime = Date.now();
  let totalCost = 0;
  let done = 0;
  let nextBatchIndex = 0;
  const results = new Array(batches.length);
  const concurrency = Math.min(
    getBatchConcurrency(options.sentencesPerRequest),
    batches.length,
  );

  onProgress?.(0, batches.length, 0, 0);

  async function workerLoop() {
    while (true) {
      const batchIdx = nextBatchIndex;
      nextBatchIndex += 1;
      if (batchIdx >= batches.length) return;

      const batchResult = await generateSentenceBatch(
        batches[batchIdx],
        options,
        pricing,
        batchIdx,
      );
      totalCost += batchResult.cost;
      results[batchIdx] = batchResult.changes;
      done += 1;
      const secs = (Date.now() - startTime) / 1000;
      onProgress?.(done, batches.length, totalCost, secs);
    }
  }

  await Promise.all(
    Array.from({ length: concurrency }, () => workerLoop()),
  );

  return {
    changes: results.flat(),
    cost: totalCost,
    elapsedMs: Date.now() - startTime,
  };
}

async function verifySentenceChangesLocally(
  changes,
  sourceSentences,
  onProgress,
  progressBase = { cost: 0, secs: 0 },
) {
  const startedAt = Date.now();
  const sourceById = new Map(
    sourceSentences.map((sentence) => [sentence.id, sentence.text]),
  );
  const accepted = new Map();
  const candidates = changes.filter(
    (change) => change?.id && sourceById.has(change.id) && change?.text,
  );

  onProgress?.({
    phase: "verify",
    done: 0,
    total: candidates.length,
    cost: progressBase.cost,
    secs: progressBase.secs,
  });

  for (let index = 0; index < candidates.length; index += 1) {
    const change = candidates[index];
    const validation = validateSentenceChangeLocally(
      sourceById.get(change.id),
      change.text,
    );
    if (validation.ok) {
      accepted.set(change.id, validation.text);
    }

    if (index === candidates.length - 1 || (index + 1) % 20 === 0) {
      const verifySecs = (Date.now() - startedAt) / 1000;
      onProgress?.({
        phase: "verify",
        done: index + 1,
        total: candidates.length,
        cost: progressBase.cost,
        secs: progressBase.secs + verifySecs,
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  const dropped = candidates.length - accepted.size;
  if (dropped > 0) {
    console.warn(
      `[Polyglot] Dropped ${dropped} unsafe sentence changes after local verification`,
    );
  }

  return {
    changes: sourceSentences
      .map((sentence) => sentence.id)
      .filter((id) => accepted.has(id))
      .map((id) => ({ id, text: accepted.get(id) })),
    cost: 0,
    elapsedMs: Date.now() - startedAt,
    verified: accepted.size,
    dropped,
  };
}

async function generateStructuredPolyglot(
  chapterHtml,
  {
    targetLangName,
    sourceLangName = "",
    model = "grok-4-1-fast-non-reasoning",
    sentencesPerRequest = DEFAULT_POLYGLOT_SENTENCES_PER_REQUEST,
    signal,
    onActivity,
  },
  onProgress,
) {
  const source = buildSentencePatchSource(chapterHtml);
  if (!source.sentences.length) {
    throw new Error(
      "Rozdzial nie zawiera wystarczajacej ilosci tekstu do tlumaczenia.",
    );
  }

  const normalizedBatchSize = normalizeSentencesPerRequest(sentencesPerRequest);
  const batches = buildSentenceBatches(source.sentences, normalizedBatchSize);
  const pricing = MODEL_PRICING[model] ?? { input: 0, output: 0 };

  console.log(
    `[Polyglot] Start patches: ${source.sentences.length} zdan w ${batches.length} zapytaniach (batch=${normalizedBatchSize}), jezyk: ${targetLangName}, model: ${model}`,
  );

  const {
    changes: rawChanges,
    cost,
    elapsedMs,
  } = await runSentencePatchBatches(
    batches,
    {
      targetLangName,
      sourceLangName,
      model,
      sentencesPerRequest: normalizedBatchSize,
      signal,
      onActivity,
    },
    pricing,
    (done, total, currentCost, secs) => {
      onActivity?.();
      onProgress?.({
        phase: "patch",
        done,
        total,
        cost: currentCost,
        secs,
      });
    },
  );

  const verified = await verifySentenceChangesLocally(
    rawChanges,
    source.sentences,
    onProgress,
    { cost, secs: elapsedMs / 1000 },
  );

  console.log(
    `[Polyglot] Verification summary: raw=${rawChanges.length}, accepted=${verified.changes.length}, dropped=${verified.dropped}`,
  );

  return {
    cacheValue: {
      format: "sentence-patches-v1",
      payload: {
        version: 1,
        changes: verified.changes,
      },
    },
    cost: cost + verified.cost,
    elapsedMs: elapsedMs + verified.elapsedMs,
  };
}

/**
 * Generate polyglot text for a chapter.
 *
 * @param {{text?: string, html?: string}} chapterInput
 * @param {object} opts
 * @param {(progress: {phase: 'patch' | 'verify', done: number, total: number, cost: number, secs: number}) => void} [onProgress]
 * @returns {Promise<{cacheValue: object, cost: number, elapsedMs: number}>}
 */
export async function generatePolyglot(chapterInput, opts, onProgress) {
  const chapterHtml = chapterInput?.html ?? "";
  if (!chapterHtml) {
    throw new Error(
      "Obslugiwany jest juz tylko nowy format generowania oparty o HTML rozdzialu.",
    );
  }

  const { signal, onRescue, ...generationOptions } = opts ?? {};
  let rescueCount = 0;

  while (true) {
    const attemptController = new AbortController();
    const detachSignal = attachAbortSignal(signal, attemptController);
    let rescued = false;
    const stallMonitor = createStallMonitor(STALL_TIMEOUT_MS, () => {
      if (attemptController.signal.aborted) return;
      rescued = true;
      attemptController.abort(
        createAbortError("Generowanie utknelo zbyt dlugo bez postepu."),
      );
    });

    stallMonitor.touch();

    try {
      return await generateStructuredPolyglot(
        chapterHtml,
        {
          ...generationOptions,
          signal: attemptController.signal,
          onActivity: stallMonitor.touch,
        },
        (progress) => {
          stallMonitor.touch();
          onProgress?.(progress);
        },
      );
    } catch (error) {
      if (!rescued || rescueCount >= STALL_RETRY_LIMIT || signal?.aborted) {
        throw error;
      }

      rescueCount += 1;
      console.warn(
        `[Polyglot] Stall detected, retrying generation (${rescueCount}/${STALL_RETRY_LIMIT})`,
      );
      onRescue?.({
        retryAttempt: rescueCount,
        maxRetries: STALL_RETRY_LIMIT,
        error,
      });
    } finally {
      stallMonitor.cleanup();
      detachSignal();
    }
  }
}
