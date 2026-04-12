import { getToken } from "../sync/cfAuth";
import { getWorkerUrl } from "../config/workerUrl";
import { buildSentencePatchSource } from "./polyglotStructure";

const WORKER_URL = getWorkerUrl();
const REQUEST_TIMEOUT_MS = 90_000;
const STALL_TIMEOUT_MS = 150_000;
const STALL_RETRY_LIMIT = 1;
const STALL_CHECK_INTERVAL_MS = 10_000;
const NETWORK_RETRY_LIMIT = 1;
export const GLOBAL_REQUESTS_PER_MINUTE = 1800;
const GLOBAL_REQUEST_INTERVAL_MS = Math.ceil(
  60_000 / GLOBAL_REQUESTS_PER_MINUTE,
);
export const DEFAULT_POLYGLOT_SENTENCES_PER_REQUEST = 4;
export const MAX_POLYGLOT_SENTENCES_PER_REQUEST = 12;
const MAX_SENTENCES_IN_FLIGHT = 24;
export const POLYGLOT_MODEL_ID = "grok-4-1-fast-non-reasoning";
export const POLYGLOT_MODEL_PRICING = { input: 0.0002, output: 0.0005 };
const ESTIMATED_REQUEST_OVERHEAD_MS = 900;
const ESTIMATED_REQUEST_TIME_PER_BATCH_MS = 1400;
const ESTIMATED_VERIFY_TIME_PER_SENTENCE_MS = 35;

let globalRequestGate = Promise.resolve();
let nextGlobalRequestAt = 0;

export function estimatePolyglotCostUsd(charCount) {
  const chars = Math.max(0, Number(charCount) || 0);
  const promptTokens = chars / 4;
  const completionTokens = chars / 5;
  return estimateBatchCost(
    POLYGLOT_MODEL_PRICING,
    promptTokens,
    completionTokens,
  );
}

export function estimatePolyglotTimeSec(
  requestCount,
  requestConcurrency,
  sentenceCount = 0,
  chapterConcurrency = 1,
) {
  const batches = Math.max(0, Number(requestCount) || 0);
  if (!batches) return 0;

  const concurrency = Math.max(1, Number(requestConcurrency) || 1);
  const chaptersInParallel = Math.max(1, Number(chapterConcurrency) || 1);
  const sentences = Math.max(0, Number(sentenceCount) || 0);
  const effectiveParallelRequests = Math.max(
    1,
    Math.floor(concurrency * chaptersInParallel),
  );
  const modelLimitedRps =
    effectiveParallelRequests / (ESTIMATED_REQUEST_TIME_PER_BATCH_MS / 1000);
  const rpmLimitedRps = GLOBAL_REQUESTS_PER_MINUTE / 60;
  const effectiveRps = Math.min(modelLimitedRps, rpmLimitedRps);
  const requestMs =
    ESTIMATED_REQUEST_OVERHEAD_MS +
    (batches / Math.max(effectiveRps, 0.001)) * 1000;
  const verifyMs = sentences * ESTIMATED_VERIFY_TIME_PER_SENTENCE_MS;
  return Math.max(1, Math.ceil((requestMs + verifyMs) / 1000));
}

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
- kazdy element changes ma miec dokladnie pola "id" i "words"
- kazdy element words ma opisywac tylko jedno slowo i miec albo pola "original" oraz "target", albo pojedynczy obiekt {"oryginal":"tlumaczenie"}
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
- zwracasz tylko liste slow do oznaczenia, nigdy nie przepisuj calego zdania
- pole "original" musi zawierac dokladnie jedno oryginalne slowo z danego zdania
- pole "target" musi zawierac jedno naturalne tlumaczenie tego slowa w jezyku ${targetLangName}
- jesli zwracasz obiekt jednopolowy, klucz ma byc slowem oryginalnym, a wartosc jego tlumaczeniem
- uzywaj identyfikatorow dokladnie takich, jakie dostales na wejsciu
- nie dopisuj wyjasnien, odmian, komentarzy ani calej tresci zdania
- dodaj element do tablicy changes tylko wtedy, gdy naprawde chcesz oznaczyc przynajmniej jedno slowo
${strictHint}

Zwroc tylko JSON bez markdownu:
{"changes":[{"id":"s1","words":[{"original":"...","target":"..."},{"oryginal":"tlumaczenie"}]}]}`;
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
  onActivity?.();

  try {
    await waitForGlobalRequestSlot(signal);
    onActivity?.();
    const result = await processBatch(messages, model, maxTokens, { signal });
    onActivity?.();
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
    .normalize("NFKC")
    .replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/\u00A0/g, " ")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function countLexicalTokens(text) {
  const matches = String(text ?? "").match(
    /[\p{L}\p{N}]+(?:['\u2019-][\p{L}\p{N}]+)*/gu,
  );
  return matches?.length ?? 0;
}

function extractSentenceTokens(text) {
  const tokens = [];
  const rx = /[\p{L}\p{N}]+(?:['\u2019-][\p{L}\p{N}]+)*/gu;
  let match;

  while ((match = rx.exec(String(text ?? ""))) !== null) {
    tokens.push({
      raw: match[0],
      normalized: normalizeComparisonText(match[0]),
      start: match.index,
      end: match.index + match[0].length,
    });
  }

  return tokens;
}

function normalizeRawWord(word) {
  if (!word) return null;

  if (typeof word === "string") {
    const parts = word.split(":");
    if (parts.length >= 2) {
      const original = parts.slice(0, -1).join(":").trim();
      const target = parts[parts.length - 1].trim();
      if (target && original) return { target, original };
    }
    return null;
  }

  if (typeof word !== "object" || Array.isArray(word)) return null;

  const target = [
    word.target,
    word.translation,
    word.translated,
    word.translatedWord,
    word.tgt,
  ].find((value) => typeof value === "string" && value.trim());
  const original = [
    word.original,
    word.source,
    word.word,
    word.src,
  ].find((value) => typeof value === "string" && value.trim());

  if (target && original) {
    return {
      target: target.trim(),
      original: original.trim(),
    };
  }

  const entries = Object.entries(word).filter(
    ([key, value]) =>
      typeof key === "string" &&
      key.trim() &&
      typeof value === "string" &&
      value.trim(),
  );
  if (entries.length !== 1) return null;

  const [dynamicOriginal, dynamicTarget] = entries[0];
  return {
    target: dynamicTarget.trim(),
    original: dynamicOriginal.trim(),
  };
}

function validateSentenceChangeLocally(sourceText, candidateWords) {
  const words = Array.isArray(candidateWords) ? candidateWords : [];
  if (!words.length) return { ok: false, reasons: ["no_words"] };

  const sentenceTokens = extractSentenceTokens(sourceText);
  const availableByOriginal = new Map();

  sentenceTokens.forEach((token, index) => {
    const indexes = availableByOriginal.get(token.normalized) ?? [];
    indexes.push(index);
    availableByOriginal.set(token.normalized, indexes);
  });

  const usedIndexes = new Set();
  const acceptedWords = [];

  for (const rawWord of words) {
    const normalizedWord = normalizeRawWord(rawWord);
    if (!normalizedWord) {
      return { ok: false, reasons: ["invalid_word_shape"] };
    }

    const target = normalizedWord.target.trim();
    const original = normalizedWord.original.trim();
    const targetNormalized = normalizeComparisonText(target);
    const originalNormalized = normalizeComparisonText(original);

    if (!targetNormalized || !originalNormalized) {
      return { ok: false, reasons: ["empty_word_side"] };
    }
    if (targetNormalized === originalNormalized) {
      return { ok: false, reasons: ["word_not_translated"] };
    }
    if (countLexicalTokens(original) !== 1) {
      return { ok: false, reasons: ["source_word_not_single_word"] };
    }
    if (countLexicalTokens(target) !== 1) {
      return { ok: false, reasons: ["target_word_not_single_word"] };
    }

    const matchingIndexes = availableByOriginal.get(originalNormalized) ?? [];
    const tokenIndex = matchingIndexes.find((index) => !usedIndexes.has(index));
    if (!Number.isInteger(tokenIndex)) {
      return { ok: false, reasons: ["source_word_missing"] };
    }

    usedIndexes.add(tokenIndex);
    acceptedWords.push({
      tokenIndex,
      original: sentenceTokens[tokenIndex].raw,
      target,
    });
  }

  acceptedWords.sort((a, b) => a.tokenIndex - b.tokenIndex);
  return {
    ok: true,
    words: acceptedWords.map(({ original, target }) => ({ original, target })),
    markerCount: acceptedWords.length,
  };
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
    return Object.entries(data.changes).map(([id, words]) => ({ id, words }));
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
  const rawWordsValue = [
    change.words,
    change.items,
    change.terms,
    change.translations,
    change.replacements,
  ].find(
    (value) =>
      (Array.isArray(value) && value.length) ||
      (value && typeof value === "object" && !Array.isArray(value)),
  );
  const rawWords = Array.isArray(rawWordsValue)
    ? rawWordsValue
    : rawWordsValue && typeof rawWordsValue === "object"
      ? Object.entries(rawWordsValue).map(([target, original]) => ({
          [target]: original,
        }))
      : [];

  if (!id || !rawWords?.length) return null;
  return {
    id: id.trim(),
    words: rawWords,
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
        Array.isArray(change.words) &&
        change.words.length > 0,
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
  { targetLangName, sourceLangName = "" },
) {
  const maxTokens = Math.max(
    320,
    Math.min(1600, 180 + sentences.length * 220),
  );

  return {
    label: "patch",
    model: POLYGLOT_MODEL_ID,
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
    (change) =>
      change?.id &&
      sourceById.has(change.id) &&
      Array.isArray(change?.words) &&
      change.words.length > 0,
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
      change.words,
    );
    if (validation.ok) {
      accepted.set(change.id, validation.words);
    } else {
      console.warn(
        `[PolyglotReject] ${change.id} | ${sourceById.get(change.id) || ""} | ${validation.reasons.join(",")}`,
      );
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
  console.log(
    `[PolyglotVerify] candidates=${candidates.length} accepted=${accepted.size} dropped=${dropped}`,
  );

  return {
    changes: sourceSentences
      .map((sentence) => sentence.id)
      .filter((id) => accepted.has(id))
      .map((id) => ({ id, words: accepted.get(id) })),
    cost: 0,
    elapsedMs: Date.now() - startedAt,
    verified: accepted.size,
    dropped,
  };
}

function logVerifiedSentenceWords(changes, sourceSentences) {
  const sentenceById = new Map(
    sourceSentences.map((sentence) => [sentence.id, sentence.text]),
  );

  changes.forEach((change) => {
    const pairs = (change.words ?? [])
      .map((word) => `${word.original}->${word.target}`)
      .join(", ");
    console.log(
      `[PolyglotWord] ${change.id} | ${sentenceById.get(change.id) || ""} | ${pairs}`,
    );
  });
}

async function generateStructuredPolyglot(
  chapterHtml,
  {
    targetLangName,
    sourceLangName = "",
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
  const pricing = POLYGLOT_MODEL_PRICING;

  const {
    changes: rawChanges,
    cost,
    elapsedMs,
  } = await runSentencePatchBatches(
    batches,
    {
      targetLangName,
      sourceLangName,
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

  if (verified.changes.length === 0) {
    if (rawChanges.length > 0) {
      throw new Error(
        "Model zwrocil odpowiedz, ale nie udalo sie zachowac zadnych bezpiecznych oznaczen. Sprobuj ponownie.",
      );
    }
    throw new Error(
      "Model nie zwrocil zadnych oznaczen tlumaczen dla tego rozdzialu. Sprobuj ponownie.",
    );
  }

  logVerifiedSentenceWords(verified.changes, source.sentences);
  console.log(
    `[PolyglotSummary] accepted=${verified.changes.length} dropped=${verified.dropped} sentences=${source.sentences.length} batches=${batches.length}`,
  );

  return {
    cacheValue: {
      format: "sentence-word-select-v2",
      payload: {
        version: 2,
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
