import { getToken } from "../sync/cfAuth";
import { getWorkerUrl } from "../config/workerUrl";
import { buildSentencePatchSource } from "./polyglotStructure";

const WORKER_URL = getWorkerUrl();

/** Approximate pricing in USD per 1 000 tokens (input / output) */
export const MODEL_PRICING = {
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
  { singleSentence = false, strictJson = false } = {},
) {
  const sourceHint = sourceLangName
    ? ` Tekst zrodlowy jest w jezyku ${sourceLangName}.`
    : "";
  const singleHint = singleSentence
    ? `
Masz dokladnie jedno zdanie na wejsciu. Jesli je zmieniasz, zwroc tablice changes z jednym elementem.`
    : "";
  const strictHint = strictJson
    ? `
- odpowiedz ma byc pojedynczym obiektem JSON, bez komentarzy, bez markdownu i bez dodatkowego tekstu
- kazdy element changes ma miec dokladnie pola "id" i "text"
- jesli nie jestes pewny formatu, zwroc {"changes":[]}`
    : "";
  return `Wstaw markery do nauki jezyka ${targetLangName}.${sourceHint}
Wejscie: {"sentences":[{"id":"s1","text":"..."}]}

Zasady:
- zmieniaj tylko losowe: rzeczowniki i przymiotniki 
- nie zmieniaj słów bezposrednio obok siebie
- kazda zmiana ma miec format [tłumaczenie::oryginał]
- lewa strona markera: słowo w jezyku ${targetLangName}
- prawa strona markera: słowo w oryginale
- zwroc tylko zdania, ktore rzeczywiscie zmieniles
${singleHint}
${strictHint}

Zwroc tylko JSON bez markdownu:
{"changes":[{"id":"s1","text":"..."}]}
Jesli nic nie zmieniasz, zwroc {"changes":[]}.`;
}

function buildSentenceBatches(sentences) {
  const batches = [];
  const maxChars = 2200;
  const maxSentences = 14;
  let current = [];
  let length = 0;

  for (const sentence of sentences) {
    const sentenceSize = sentence.text.length + sentence.id.length + 32;
    if (
      current.length > 0 &&
      (length + sentenceSize > maxChars || current.length >= maxSentences)
    ) {
      batches.push(current);
      current = [sentence];
      length = sentenceSize;
    } else {
      current.push(sentence);
      length += sentenceSize;
    }
  }

  if (current.length > 0) batches.push(current);
  return batches;
}

export function estimatePolyglotGeneration(chapterInput) {
  const chapterHtml =
    typeof chapterInput === "string"
      ? chapterInput
      : (chapterInput?.html ?? "");

  if (!chapterHtml) {
    return { generationBatches: 0, sentenceCount: 0 };
  }

  const source = buildSentencePatchSource(chapterHtml);
  return {
    generationBatches: buildSentenceBatches(source.sentences).length,
    sentenceCount: source.sentences.length,
  };
}

async function processBatch(messages, model, maxTokens = 4096) {
  const token = getToken();
  if (!token)
    throw new Error("Nie jestes zalogowany. Zaloguj sie w Ustawieniach.");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);

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
      signal: controller.signal,
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
    if (err.name === "AbortError")
      throw new Error(
        "Przekroczono limit czasu (90s). Sprawdz polaczenie z API.",
      );
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

async function processBatchWithRetry(
  { messages, model, maxTokens, label, batchIdx },
  attempt = 0,
) {
  const startedAt = Date.now();
  console.log(
    `[Polyglot] ${label} ${batchIdx + 1} -> wysylam (${model}, max_tokens=${maxTokens})`,
  );

  try {
    const result = await processBatch(messages, model, maxTokens);
    const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(
      `[Polyglot] ${label} ${batchIdx + 1} ok - ${secs}s, in:${result.promptTokens} out:${result.completionTokens}`,
    );
    return result;
  } catch (err) {
    console.warn(
      `[Polyglot] ${label} ${batchIdx + 1} blad (proba ${attempt + 1}): ${err.message}`,
    );
    if (attempt < 1) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      return processBatchWithRetry(
        { messages, model, maxTokens, label, batchIdx },
        attempt + 1,
      );
    }
    throw err;
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
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
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

function formatMarker(target, original) {
  return `[${String(target ?? "").trim()}::${String(original ?? "").trim()}]`;
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

function replaceMarkersSequentially(text, markerTexts) {
  const replacements = Array.isArray(markerTexts) ? markerTexts : [];
  let markerIndex = 0;

  return replaceMarkers(text, (marker) => {
    const next = replacements[markerIndex];
    markerIndex += 1;
    return typeof next === "string" && next.trim() ? next.trim() : marker.full;
  });
}

function validateSentenceChange(sourceText, candidateText) {
  const sourceNormalized = normalizeComparisonText(sourceText);
  const candidate = String(candidateText ?? "").trim();
  if (!candidate) return { ok: false, reasons: ["empty"] };

  const markers = extractMarkers(candidate);
  if (!markers.length) return { ok: false, reasons: ["no_markers"] };

  let targetLooksUntranslated = false;
  let missingOriginalSide = false;

  for (const marker of markers) {
    const targetNormalized = normalizeComparisonText(marker.target);
    const originalNormalized = normalizeComparisonText(marker.original);
    const originalInSource =
      originalNormalized && sourceNormalized.includes(originalNormalized);

    if (!originalInSource) missingOriginalSide = true;
    if (
      !targetNormalized ||
      !originalNormalized ||
      targetNormalized === originalNormalized
    ) {
      targetLooksUntranslated = true;
    }
  }

  const recoveredOriginal = normalizeComparisonText(
    replaceMarkers(candidate, (marker) => marker.original),
  );
  if (recoveredOriginal !== sourceNormalized) {
    return { ok: false, reasons: ["structure_mismatch"] };
  }

  if (missingOriginalSide) {
    return { ok: false, reasons: ["source_side_mismatch"] };
  }

  if (targetLooksUntranslated) {
    return { ok: false, reasons: ["target_still_source_language"] };
  }

  return { ok: true, text: candidate };
}

function buildMarkerOptions(marker, sourceNormalized) {
  const variants = [
    { target: marker.target, original: marker.original, bias: 0.1 },
    { target: marker.original, original: marker.target, bias: 0 },
  ];
  const seen = new Set();

  return variants
    .map((variant) => {
      const targetNormalized = normalizeComparisonText(variant.target);
      const originalNormalized = normalizeComparisonText(variant.original);
      const key = `${targetNormalized}::${originalNormalized}`;
      if (!targetNormalized || !originalNormalized || seen.has(key))
        return null;
      seen.add(key);

      const originalInSource = sourceNormalized.includes(originalNormalized);
      const targetInSource = sourceNormalized.includes(targetNormalized);
      let score = variant.bias;

      if (targetNormalized !== originalNormalized) score += 2;
      if (originalInSource) score += 4;
      if (!targetInSource) score += 1;

      return {
        text: formatMarker(variant.target, variant.original),
        score,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);
}

function normalizeSentenceChange(sourceText, candidateText) {
  const candidate = String(candidateText ?? "").trim();
  if (!candidate) return { ok: false, reasons: ["empty"] };

  const directValidation = validateSentenceChange(sourceText, candidate);
  if (directValidation.ok) return directValidation;

  const markers = extractMarkers(candidate);
  if (!markers.length) return directValidation;

  const sourceNormalized = normalizeComparisonText(sourceText);
  const optionSets = markers.map((marker) =>
    buildMarkerOptions(marker, sourceNormalized),
  );
  const maxVariants = optionSets.reduce(
    (product, options) => product * Math.max(options.length, 1),
    1,
  );

  let bestResult = null;
  const selected = [];

  function visit(index, score) {
    if (index >= optionSets.length) {
      const rebuiltText = replaceMarkersSequentially(
        candidate,
        selected.map((option) => option.text),
      );
      const validation = validateSentenceChange(sourceText, rebuiltText);
      if (!validation.ok) return;
      if (!bestResult || score > bestResult.score) {
        bestResult = { score, text: validation.text };
      }
      return;
    }

    for (const option of optionSets[index]) {
      selected.push(option);
      visit(index + 1, score + option.score);
      selected.pop();
    }
  }

  if (maxVariants <= 256) {
    visit(0, 0);
  } else {
    const greedyText = replaceMarkersSequentially(
      candidate,
      optionSets.map((options) => options[0]?.text),
    );
    const greedyValidation = validateSentenceChange(sourceText, greedyText);
    if (greedyValidation.ok) return greedyValidation;
  }

  return bestResult ? { ok: true, text: bestResult.text } : directValidation;
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
    throw new Error("Model nie zwrocil poprawnego JSON dla paczki zmian.");
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
  { strictJson = false } = {},
) {
  return {
    label: strictJson ? "patch-recover" : "patch",
    model,
    maxTokens: Math.min(1400, Math.max(220, 120 + sentences.length * 70)),
    messages: [
      {
        role: "system",
        content: buildSentencePatchSystemPrompt(
          targetLangName,
          sourceLangName,
          {
            singleSentence: sentences.length === 1,
            strictJson,
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

async function generateSentenceBatchWithRecovery(
  sentences,
  options,
  pricing,
  trace = { batchIdx: 0, strictJson: false },
) {
  const didUseStrictJson = trace.strictJson || sentences.length === 1;
  const request = buildSentencePatchRequest(sentences, options, {
    strictJson: didUseStrictJson,
  });
  const startedAt = Date.now();
  const { text, promptTokens, completionTokens } = await processBatchWithRetry({
    ...request,
    batchIdx: trace.batchIdx,
  });
  const ownCost = estimateBatchCost(pricing, promptTokens, completionTokens);
  const ownElapsedMs = Date.now() - startedAt;

  try {
    return {
      changes: parseSentencePatchResponse(text, sentences),
      cost: ownCost,
      elapsedMs: ownElapsedMs,
    };
  } catch (error) {
    console.warn(
      `[Polyglot] patch ${trace.batchIdx + 1} parse fallback for ${sentences.length} zd. (${error.message})`,
    );

    if (sentences.length === 1) {
      if (!didUseStrictJson) {
        const retry = await generateSentenceBatchWithRecovery(
          sentences,
          options,
          pricing,
          {
            ...trace,
            strictJson: true,
          },
        );
        return {
          changes: retry.changes,
          cost: ownCost + retry.cost,
          elapsedMs: ownElapsedMs + retry.elapsedMs,
        };
      }

      console.warn(
        `[Polyglot] patch ${trace.batchIdx + 1} pomijam zdanie ${sentences[0]?.id} po nieudanych probach odzyskania JSON`,
      );
      return {
        changes: [],
        cost: ownCost,
        elapsedMs: ownElapsedMs,
      };
    }

    const middle = Math.ceil(sentences.length / 2);
    const [left, right] = await Promise.all([
      generateSentenceBatchWithRecovery(
        sentences.slice(0, middle),
        options,
        pricing,
        { ...trace, strictJson: true },
      ),
      generateSentenceBatchWithRecovery(
        sentences.slice(middle),
        options,
        pricing,
        { ...trace, strictJson: true },
      ),
    ]);

    return {
      changes: [...left.changes, ...right.changes],
      cost: ownCost + left.cost + right.cost,
      elapsedMs: ownElapsedMs + left.elapsedMs + right.elapsedMs,
    };
  }
}

async function runSentencePatchBatches(batches, options, pricing, onProgress) {
  const startTime = Date.now();
  let totalCost = 0;
  let done = 0;
  const results = new Array(batches.length);

  onProgress?.(0, batches.length, 0, 0);

  const concurrency = 5;
  for (let index = 0; index < batches.length; index += concurrency) {
    const chunk = batches.slice(index, index + concurrency);
    await Promise.all(
      chunk.map(async (sentences, innerIdx) => {
        const absoluteIdx = index + innerIdx;
        const batchResult = await generateSentenceBatchWithRecovery(
          sentences,
          options,
          pricing,
          {
            batchIdx: absoluteIdx,
            strictJson: false,
          },
        );
        totalCost += batchResult.cost;
        results[absoluteIdx] = batchResult.changes;
        done += 1;
        const secs = (Date.now() - startTime) / 1000;
        onProgress?.(done, batches.length, totalCost, secs);
      }),
    );
  }

  return {
    changes: results.flat(),
    cost: totalCost,
    elapsedMs: Date.now() - startTime,
  };
}

function buildVerifyBatches(items) {
  const batches = [];
  const maxChars = 2400;
  const maxItems = 10;
  let current = [];
  let length = 0;

  for (const item of items) {
    const markersSize = item.markers.reduce(
      (sum, marker) => sum + marker.length,
      0,
    );
    const itemSize = item.id.length + item.sourceText.length + markersSize + 64;
    if (
      current.length > 0 &&
      (length + itemSize > maxChars || current.length >= maxItems)
    ) {
      batches.push(current);
      current = [item];
      length = itemSize;
    } else {
      current.push(item);
      length += itemSize;
    }
  }

  if (current.length > 0) batches.push(current);
  return batches;
}

async function verifySentenceChangesLocally(
  changes,
  sourceSentences,
  { targetLangName },
  onProgress,
  progressBase = { cost: 0, secs: 0 },
) {
  void targetLangName;
  const sourceById = new Map(
    sourceSentences.map((sentence) => [sentence.id, sentence.text]),
  );
  const items = changes
    .map((change) => {
      const sourceText = sourceById.get(change.id);
      if (!sourceText) return null;
      const markers = extractMarkers(change.text).map((marker) =>
        formatMarker(marker.target, marker.original),
      );
      if (!markers.length) return null;
      return { id: change.id, sourceText, candidateText: change.text, markers };
    })
    .filter(Boolean);

  if (!items.length) {
    return { changes: [], cost: 0, elapsedMs: 0, verified: 0, dropped: 0 };
  }

  const verifyBatches = buildVerifyBatches(items);
  const startedAt = Date.now();
  const accepted = new Map();

  onProgress?.({
    phase: "verify",
    done: 0,
    total: verifyBatches.length,
    cost: progressBase.cost,
    secs: progressBase.secs,
  });

  for (let batchIdx = 0; batchIdx < verifyBatches.length; batchIdx += 1) {
    const batchItems = verifyBatches[batchIdx];
    batchItems.forEach((item) => {
      const normalized = normalizeSentenceChange(
        item.sourceText,
        item.candidateText,
      );
      if (!normalized.ok) return;
      accepted.set(item.id, normalized.text);
    });

    const verifySecs = (Date.now() - startedAt) / 1000;
    onProgress?.({
      phase: "verify",
      done: batchIdx + 1,
      total: verifyBatches.length,
      cost: progressBase.cost,
      secs: progressBase.secs + verifySecs,
    });

    if (batchIdx < verifyBatches.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  const dropped = items.filter((item) => !accepted.has(item.id)).length;
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
  { targetLangName, sourceLangName = "", model = "deepseek-chat" },
  onProgress,
) {
  const source = buildSentencePatchSource(chapterHtml);
  if (!source.sentences.length)
    throw new Error(
      "Rozdzial nie zawiera wystarczajacej ilosci tekstu do tlumaczenia.",
    );

  const batches = buildSentenceBatches(source.sentences);
  const pricing = MODEL_PRICING[model] ?? { input: 0, output: 0 };

  console.log(
    `[Polyglot] Start patches: ${batches.length} paczek, ${source.sentences.length} zdan, jezyk: ${targetLangName}, model: ${model}`,
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
    },
    pricing,
    (done, total, currentCost, secs) => {
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
    { targetLangName, sourceLangName, model },
    onProgress,
    { cost, secs: elapsedMs / 1000 },
  );

  console.log(
    `[Polyglot] Verification summary: raw=${rawChanges.length}, accepted=${verified.changes.length}, verified=${verified.verified}, dropped=${verified.dropped}`,
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

  return generateStructuredPolyglot(chapterHtml, opts, onProgress);
}
