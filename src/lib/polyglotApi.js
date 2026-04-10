import { getToken } from '../sync/cfAuth';
import { getWorkerUrl } from '../config/workerUrl';
import { buildSentencePatchSource } from './polyglotStructure';

const WORKER_URL = getWorkerUrl();

/** Approximate pricing in USD per 1 000 tokens (input / output) */
export const MODEL_PRICING = {
  'deepseek-chat':                     { input: 0.000070, output: 0.000280 },
  'deepseek-reasoner':                 { input: 0.000550, output: 0.002190 },
  'gpt-4o-mini':                       { input: 0.000150, output: 0.000600 },
  'gpt-4o':                            { input: 0.002500, output: 0.010000 },
  'google/gemini-flash-1.5':           { input: 0.000075, output: 0.000300 },
  'meta-llama/llama-3.3-70b-instruct': { input: 0, output: 0 },
  'anthropic/claude-3.5-haiku':        { input: 0.000800, output: 0.004000 },
};

function buildSentencePatchSystemPrompt(targetLangName, sourceLangName) {
  const sourceHint = sourceLangName ? ` Tekst zrodlowy jest w jezyku ${sourceLangName}.` : '';
  return `Jestes asystentem do nauki jezyka ${targetLangName}.${sourceHint}
Otrzymasz JSON z lista zdan, gdzie kazde zdanie ma pole "id" i "text".

Twoje zadanie:
- zmien tylko okolo 20-25% rzeczownikow i przymiotnikow na odpowiedniki w jezyku ${targetLangName}
- zachowaj to samo zdanie, kolejnosc slow, interpunkcje i sens
- nie zmieniaj czasownikow, zaimkow, przyimkow ani spojnikow
- nie lacz, nie dziel i nie przepisuj zdania od nowa bardziej niz to konieczne
- uzyj formatu [SLOWO::ORYGINAL] tylko dla podmienionych slow
- po podstawieniu prawej strony kazdego markera zdanie musi byc identyczne z oryginalnym zdaniem wejsciowym
- lewa strona markera zawsze musi byc w jezyku docelowym, prawa zawsze dokladnie z oryginalnego zdania
- lewa strona markera nie moze byc po prostu ta sama angielska forma co po prawej stronie
- jesli nie jestes pewny podmiany, zostaw slowo bez zmiany zamiast ryzykowac zly marker
- zwroc tylko zdania, ktore rzeczywiscie zmieniles

Format odpowiedzi:
{"changes":[{"id":"s12","text":"..."}]}

Wazne:
- zwroc poprawny JSON bez markdownu i bez dodatkowego tekstu
- zachowaj te same identyfikatory id
- jesli w paczce nic nie trzeba zmienic, zwroc {"changes":[]}`;
}

function buildSentenceVerifySystemPrompt(targetLangName, sourceLangName) {
  const sourceHint = sourceLangName ? ` Tekst zrodlowy jest w jezyku ${sourceLangName}.` : '';
  return `Jestes walidatorem zmian zdan do nauki jezyka ${targetLangName}.${sourceHint}
Otrzymasz JSON z lista zdan:
- "sourceText" to oryginalne zdanie
- "candidateText" to zdanie z markerami [TARGET::SOURCE]
- kazde zdanie trzeba zweryfikowac, nawet jesli wyglada poprawnie

Zweryfikuj i znormalizuj candidateText tak, aby:
- lewa strona markera byla zawsze w jezyku docelowym
- prawa strona markera byla zawsze dokladnym fragmentem sourceText
- lewa strona markera nie byla ta sama angielska forma co prawa strona
- po podstawieniu prawej strony kazdego markera otrzymac dokladnie sourceText
- nie zmieniac kolejnosci slow, interpunkcji ani struktury sourceText
- nie dodawac nowych podmian, jesli nie sa konieczne
- jesli marker jest odwrocony, zamien strony
- jesli candidateText jest poprawny, zwroc go po prostu w postaci znormalizowanej
- jesli nie da sie bezpiecznie naprawic zdania, zwroc dokladnie sourceText bez markerow

Zwroc tylko poprawny JSON bez markdownu:
{"changes":[{"id":"s12","text":"..."}]}`;
}

function buildSentenceBatches(sentences) {
  const batches = [];
  const maxChars = 2200;
  const maxSentences = 14;
  let current = [];
  let length = 0;

  for (const sentence of sentences) {
    const sentenceSize = sentence.text.length + sentence.id.length + 32;
    if (current.length > 0 && (length + sentenceSize > maxChars || current.length >= maxSentences)) {
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

async function processBatch(messages, model, maxTokens = 4096) {
  const token = getToken();
  if (!token) throw new Error('Nie jestes zalogowany. Zaloguj sie w Ustawieniach.');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);

  try {
    const resp = await fetch(`${WORKER_URL}/translate`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
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
      text: content ?? '',
      promptTokens: usage?.prompt_tokens ?? 0,
      completionTokens: usage?.completion_tokens ?? 0,
    };
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Przekroczono limit czasu (90s). Sprawdz polaczenie z API.');
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

async function processBatchWithRetry({ messages, model, maxTokens, label, batchIdx }, attempt = 0) {
  const startedAt = Date.now();
  console.log(`[Polyglot] ${label} ${batchIdx + 1} -> wysylam (${model}, max_tokens=${maxTokens})`);

  try {
    const result = await processBatch(messages, model, maxTokens);
    const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(`[Polyglot] ${label} ${batchIdx + 1} ok - ${secs}s, in:${result.promptTokens} out:${result.completionTokens}`);
    return result;
  } catch (err) {
    console.warn(`[Polyglot] ${label} ${batchIdx + 1} blad (proba ${attempt + 1}): ${err.message}`);
    if (attempt < 1) {
      await new Promise(resolve => setTimeout(resolve, 3000));
      return processBatchWithRetry({ messages, model, maxTokens, label, batchIdx }, attempt + 1);
    }
    throw err;
  }
}

function parseJsonResponse(text) {
  const raw = String(text ?? '').trim();
  const cleaned = raw
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  return JSON.parse(cleaned);
}

function normalizeComparisonText(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function extractMarkers(text) {
  const markers = [];
  const rx = /\[([^\]]+?)::([^\]]+?)\]/g;
  let match;

  while ((match = rx.exec(String(text ?? ''))) !== null) {
    markers.push({
      full: match[0],
      target: match[1].trim(),
      original: match[2].trim(),
    });
  }

  return markers;
}

function replaceMarkers(text, replacer) {
  const sourceText = String(text ?? '');
  const rx = /\[([^\]]+?)::([^\]]+?)\]/g;
  let result = '';
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

function validateSentenceChange(sourceText, candidateText) {
  const sourceNormalized = normalizeComparisonText(sourceText);
  const candidate = String(candidateText ?? '').trim();
  if (!candidate) return { ok: false, reasons: ['empty'] };

  const markers = extractMarkers(candidate);
  if (!markers.length) return { ok: false, reasons: ['no_markers'] };

  let targetLooksUntranslated = false;
  let missingOriginalSide = false;

  for (const marker of markers) {
    const targetNormalized = normalizeComparisonText(marker.target);
    const originalNormalized = normalizeComparisonText(marker.original);
    const targetInSource = targetNormalized && sourceNormalized.includes(targetNormalized);
    const originalInSource = originalNormalized && sourceNormalized.includes(originalNormalized);

    if (!originalInSource) missingOriginalSide = true;
    if (targetInSource || (targetNormalized && targetNormalized === originalNormalized)) {
      targetLooksUntranslated = true;
    }
  }

  const recoveredOriginal = normalizeComparisonText(replaceMarkers(candidate, marker => marker.original));
  if (recoveredOriginal !== sourceNormalized) {
    return { ok: false, reasons: ['structure_mismatch'] };
  }

  if (missingOriginalSide) {
    return { ok: false, reasons: ['source_side_mismatch'] };
  }

  if (targetLooksUntranslated) {
    return { ok: false, reasons: ['target_still_source_language'] };
  }

  return { ok: true, text: candidate };
}

function parseSentencePatchResponse(text, batchSentences) {
  let data;
  try {
    data = parseJsonResponse(text);
  } catch {
    throw new Error('Model nie zwrocil poprawnego JSON dla paczki zmian.');
  }

  if (!data || !Array.isArray(data.changes)) {
    throw new Error('Model zwrocil nieprawidlowy format zmian.');
  }

  const originalById = new Map(batchSentences.map(sentence => [sentence.id, sentence.text]));
  return data.changes
    .filter(change => change && typeof change.id === 'string' && typeof change.text === 'string')
    .map(change => ({
      id: change.id.trim(),
      text: change.text.trim(),
    }))
    .filter(change => originalById.has(change.id) && change.text && change.text !== originalById.get(change.id));
}

function parseSentenceVerifyResponse(text, batchItems) {
  let data;
  try {
    data = parseJsonResponse(text);
  } catch {
    throw new Error('Model nie zwrocil poprawnego JSON dla paczki weryfikacyjnej.');
  }

  if (!data || !Array.isArray(data.changes)) {
    throw new Error('Model zwrocil nieprawidlowy format weryfikacji.');
  }

  const allowedIds = new Set(batchItems.map(item => item.id));
  return data.changes
    .filter(change => change && typeof change.id === 'string' && typeof change.text === 'string')
    .map(change => ({
      id: change.id.trim(),
      text: change.text.trim(),
    }))
    .filter(change => allowedIds.has(change.id) && change.text);
}

async function runBatches(batchRequests, pricing, onProgress) {
  const startTime = Date.now();
  let totalCost = 0;
  let done = 0;
  const results = new Array(batchRequests.length);

  onProgress?.(0, batchRequests.length, 0, 0);

  const concurrency = 5;
  for (let index = 0; index < batchRequests.length; index += concurrency) {
    const chunk = batchRequests.slice(index, index + concurrency);
    await Promise.all(chunk.map(async (request, innerIdx) => {
      const absoluteIdx = index + innerIdx;
      const { text, promptTokens, completionTokens } = await processBatchWithRetry({
        ...request,
        batchIdx: absoluteIdx,
      });
      totalCost += (promptTokens / 1000) * pricing.input + (completionTokens / 1000) * pricing.output;
      results[absoluteIdx] = text;
      done += 1;
      const secs = (Date.now() - startTime) / 1000;
      onProgress?.(done, batchRequests.length, totalCost, secs);
    }));
  }

  return {
    texts: results,
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
    const itemSize = item.id.length + item.sourceText.length + item.candidateText.length + 64;
    if (current.length > 0 && (length + itemSize > maxChars || current.length >= maxItems)) {
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

async function verifySentenceChangesWithLlm(changes, sourceSentences, { targetLangName, sourceLangName = '', model = 'deepseek-chat' }) {
  const sourceById = new Map(sourceSentences.map(sentence => [sentence.id, sentence.text]));
  const items = changes
    .map(change => {
      const sourceText = sourceById.get(change.id);
      if (!sourceText) return null;
      return { id: change.id, sourceText, candidateText: change.text };
    })
    .filter(Boolean);

  if (!items.length) {
    return { changes: [], cost: 0, elapsedMs: 0, verified: 0, dropped: 0 };
  }

  const verifyBatches = buildVerifyBatches(items);
  const pricing = MODEL_PRICING[model] ?? { input: 0, output: 0 };
  const verifyRequests = verifyBatches.map(batchItems => ({
    label: 'verify',
    model,
    maxTokens: Math.min(1800, Math.max(420, 180 + batchItems.length * 130)),
    messages: [
      { role: 'system', content: buildSentenceVerifySystemPrompt(targetLangName, sourceLangName) },
      {
        role: 'user',
        content: JSON.stringify({
          sentences: batchItems.map(item => ({
            id: item.id,
            sourceText: item.sourceText,
            candidateText: item.candidateText,
          })),
        }),
      },
    ],
  }));

  const { texts, cost, elapsedMs } = await runBatches(verifyRequests, pricing);
  const accepted = new Map();

  texts.forEach((text, batchIdx) => {
    const verifiedChanges = parseSentenceVerifyResponse(text, verifyBatches[batchIdx]);
    verifiedChanges.forEach(change => {
      const sourceText = sourceById.get(change.id);
      if (!sourceText) return;
      const validation = validateSentenceChange(sourceText, change.text);
      if (!validation.ok) return;
      accepted.set(change.id, validation.text);
    });
  });

  const dropped = items.filter(item => !accepted.has(item.id)).length;
  if (dropped > 0) {
    console.warn(`[Polyglot] Dropped ${dropped} unsafe sentence changes after LLM verification`);
  }

  return {
    changes: sourceSentences
      .map(sentence => sentence.id)
      .filter(id => accepted.has(id))
      .map(id => ({ id, text: accepted.get(id) })),
    cost,
    elapsedMs,
    verified: accepted.size,
    dropped,
  };
}

async function generateStructuredPolyglot(chapterHtml, { targetLangName, sourceLangName = '', model = 'deepseek-chat' }, onProgress) {
  const source = buildSentencePatchSource(chapterHtml);
  if (!source.sentences.length) throw new Error('Rozdzial nie zawiera wystarczajacej ilosci tekstu do tlumaczenia.');

  const batches = buildSentenceBatches(source.sentences);
  const pricing = MODEL_PRICING[model] ?? { input: 0, output: 0 };

  console.log(`[Polyglot] Start patches: ${batches.length} paczek, ${source.sentences.length} zdan, jezyk: ${targetLangName}, model: ${model}`);

  const requests = batches.map(sentences => ({
    label: 'patch',
    model,
    maxTokens: Math.min(1400, Math.max(300, 120 + sentences.length * 70)),
    messages: [
      { role: 'system', content: buildSentencePatchSystemPrompt(targetLangName, sourceLangName) },
      {
        role: 'user',
        content: JSON.stringify({
          sentences: sentences.map(sentence => ({ id: sentence.id, text: sentence.text })),
        }),
      },
    ],
  }));

  const { texts, cost, elapsedMs } = await runBatches(requests, pricing, onProgress);
  const rawChanges = [];

  texts.forEach((text, idx) => {
    rawChanges.push(...parseSentencePatchResponse(text, batches[idx]));
  });

  const verified = await verifySentenceChangesWithLlm(
    rawChanges,
    source.sentences,
    { targetLangName, sourceLangName, model }
  );

  console.log(
    `[Polyglot] Verification summary: raw=${rawChanges.length}, accepted=${verified.changes.length}, verified=${verified.verified}, dropped=${verified.dropped}`
  );

  return {
    cacheValue: {
      format: 'sentence-patches-v1',
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
 * @param {(done: number, total: number, cost: number, secs: number) => void} [onProgress]
 * @returns {Promise<{cacheValue: object, cost: number, elapsedMs: number}>}
 */
export async function generatePolyglot(chapterInput, opts, onProgress) {
  const chapterHtml = chapterInput?.html ?? '';
  if (!chapterHtml) {
    throw new Error('Obslugiwany jest juz tylko nowy format generowania oparty o HTML rozdzialu.');
  }

  return generateStructuredPolyglot(chapterHtml, opts, onProgress);
}
