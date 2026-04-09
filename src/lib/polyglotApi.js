import { getToken } from '../sync/cfAuth';

const WORKER_URL = import.meta.env.VITE_WORKER_URL ?? '';

/** Approximate pricing in USD per 1 000 tokens (input / output) */
export const MODEL_PRICING = {
  'deepseek-chat':                       { input: 0.000070, output: 0.000280 },
  'deepseek-reasoner':                   { input: 0.000550, output: 0.002190 },
  'gpt-4o-mini':                         { input: 0.000150, output: 0.000600 },
  'gpt-4o':                              { input: 0.002500, output: 0.010000 },
  'google/gemini-flash-1.5':             { input: 0.000075, output: 0.000300 },
  'meta-llama/llama-3.3-70b-instruct':   { input: 0,        output: 0        },
  'anthropic/claude-3.5-haiku':          { input: 0.000800, output: 0.004000 },
};

function buildSystemPrompt(targetLangName, sourceLangName) {
  const sourceHint = sourceLangName ? ` Tekst źródłowy jest w języku ${sourceLangName}.` : '';
  return `Jesteś asystentem do nauki języka ${targetLangName}.${sourceHint} Przerób poniższy tekst zastępując około 20–25% rzeczowników i przymiotników ich odpowiednikami w języku ${targetLangName}.

Format każdego zastąpionego słowa: [SŁOWO::ORYGINAŁ]
Przykłady (dla hiszpańskiego): [el perro::pies], [negro::czarny], [la casa::dom], [grande::duży]

Zasady:
• Zastępuj TYLKO rzeczowniki i przymiotniki — nie czasowniki, zaimki, przyimki ani spójniki
• Zachowaj oryginalną strukturę zdania: gramatykę, szyk wyrazów, interpunkcję, akapity
• Używaj naturalnych form słów w języku docelowym (z rodzajnikami jeśli wskazane)
• Rozłóż zamiany równomiernie w całym tekście (nie tylko na początku)
• Nie zamieniaj słów bezpośrednio sąsiadujących — między dwoma zamienionymi słowami musi być co najmniej jedno niezamienione słowo
• Odpowiedz WYŁĄCZNIE przerobioną wersją tekstu — zero komentarzy, wstępu ani podsumowania`;
}

async function processBatch(batchText, langName, model, sourceLangName = '') {
  const token = getToken();
  if (!token) throw new Error('Nie jesteś zalogowany. Zaloguj się w Ustawieniach.');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);

  try {
    const resp = await fetch(`${WORKER_URL}/translate`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: buildSystemPrompt(langName, sourceLangName) },
          { role: 'user',   content: batchText },
        ],
      }),
      signal: controller.signal,
    });

    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      throw new Error(body.error || `Worker error ${resp.status}`);
    }

    const { content, usage } = await resp.json();
    return {
      text:             content ?? '',
      promptTokens:     usage?.prompt_tokens     ?? 0,
      completionTokens: usage?.completion_tokens ?? 0,
    };
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Przekroczono limit czasu (90s). Sprawdź połączenie z API.');
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

async function processBatchWithRetry(batchText, langName, model, sourceLangName, batchIdx, attempt = 0) {
  const t0 = Date.now();
  console.log(`[Polyglot] Fragment ${batchIdx + 1} → wysyłam (${batchText.length} znaków, model: ${model})`);
  try {
    const result = await processBatch(batchText, langName, model, sourceLangName);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[Polyglot] Fragment ${batchIdx + 1} ✓ — ${secs}s, in:${result.promptTokens} out:${result.completionTokens} tokens`);
    return result;
  } catch (err) {
    console.warn(`[Polyglot] Fragment ${batchIdx + 1} ✗ (próba ${attempt + 1}): ${err.message}`);
    if (attempt < 1) {
      console.log(`[Polyglot] Fragment ${batchIdx + 1} — ponawiam za 3s…`);
      await new Promise(r => setTimeout(r, 3000));
      return processBatchWithRetry(batchText, langName, model, sourceLangName, batchIdx, attempt + 1);
    }
    throw err;
  }
}

/**
 * Generate polyglot text for a chapter.
 * Splits long text into batches to avoid LLM token limits.
 *
 * @param {string} chapterText  - plain text of the chapter
 * @param {object} opts
 *   @param {string} opts.targetLangName  - e.g. "hiszpański"
 *   @param {string} [opts.sourceLangName] - e.g. "polski" (source language of the book)
 *   @param {string} [opts.model]         - default "deepseek-chat"
 * @param {(done: number, total: number, cost: number, secs: number) => void} [onProgress]
 * @returns {Promise<{rawText: string, cost: number, elapsedMs: number}>}
 */
export async function generatePolyglot(chapterText, { targetLangName, sourceLangName = '', model = 'deepseek-chat' }, onProgress) {
  const paragraphs = chapterText
    .split(/\n\n+/)
    .map(p => p.trim())
    .filter(p => p.length > 5);

  const BATCH_CHARS = 1000;
  const batches = [];
  let cur = [], len = 0;

  // Split a single long paragraph at word boundaries
  function splitAtWords(text) {
    if (text.length <= BATCH_CHARS) return [text];
    const parts = [];
    let start = 0;
    while (start < text.length) {
      if (start + BATCH_CHARS >= text.length) { parts.push(text.slice(start)); break; }
      let end = start + BATCH_CHARS;
      const lastSpace = text.lastIndexOf(' ', end);
      if (lastSpace > start) end = lastSpace;
      parts.push(text.slice(start, end));
      start = end + 1;
    }
    return parts;
  }

  for (const p of paragraphs) {
    const parts = splitAtWords(p);
    for (const part of parts) {
      if (len + part.length > BATCH_CHARS && cur.length > 0) {
        batches.push(cur.join('\n\n'));
        cur = [part];
        len = part.length;
      } else {
        cur.push(part);
        len += part.length + 2;
      }
    }
  }
  if (cur.length > 0) batches.push(cur.join('\n\n'));

  if (batches.length === 0) {
    throw new Error('Rozdział nie zawiera wystarczającej ilości tekstu.');
  }

  console.log(`[Polyglot] Start: ${batches.length} fragmentów, język: ${targetLangName}, model: ${model}`);
  console.log(`[Polyglot] Łączna liczba znaków: ${chapterText.length}`);

  // Emit initial state immediately so UI shows total count
  onProgress?.(0, batches.length, 0, 0);

  const pricing = MODEL_PRICING[model] ?? { input: 0, output: 0 };
  const startTime = Date.now();
  let totalCost = 0;
  let done = 0;
  const results = new Array(batches.length);

  // Concurrency=2 — avoids rate-limit and worker timeout cascades
  const CONCURRENCY = 5;
  for (let i = 0; i < batches.length; i += CONCURRENCY) {
    const chunk = batches.slice(i, i + CONCURRENCY);
    await Promise.all(chunk.map(async (batchText, j) => {
      const idx = i + j;
      const { text, promptTokens, completionTokens } = await processBatchWithRetry(
        batchText, targetLangName, model, sourceLangName, idx,
      );
      totalCost += (promptTokens / 1000) * pricing.input + (completionTokens / 1000) * pricing.output;
      results[idx] = text;
      done++;
      const secs = (Date.now() - startTime) / 1000;
      console.log(`[Polyglot] Postęp: ${done}/${batches.length} fragmentów, koszt: $${totalCost.toFixed(5)}, czas: ${secs.toFixed(1)}s`);
      onProgress?.(done, batches.length, totalCost, secs);
    }));
  }

  const elapsedMs = Date.now() - startTime;
  console.log(`[Polyglot] Zakończono: ${batches.length} fragmentów w ${(elapsedMs/1000).toFixed(1)}s, koszt: $${totalCost.toFixed(5)}`);

  return { rawText: results.join('\n\n'), cost: totalCost, elapsedMs };
}
