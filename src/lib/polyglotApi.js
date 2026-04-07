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

function buildSystemPrompt(langName) {
  return `Jesteś asystentem do nauki języka ${langName}. Przerób poniższy tekst zastępując około 20–25% rzeczowników i przymiotników ich odpowiednikami w języku ${langName}.

Format każdego zastąpionego słowa: [SŁOWO::ORYGINAŁ]
Przykłady (dla hiszpańskiego): [el perro::pies], [negro::czarny], [la casa::dom], [grande::duży]

Zasady:
• Zastępuj TYLKO rzeczowniki i przymiotniki — nie czasowniki, zaimki, przyimki ani spójniki
• Zachowaj oryginalną strukturę zdania: gramatykę, szyk wyrazów, interpunkcję, akapity
• Używaj naturalnych form słów w języku docelowym (z rodzajnikami jeśli wskazane)
• Rozłóż zamiany równomiernie w całym tekście (nie tylko na początku)
• Odpowiedz WYŁĄCZNIE przerobioną wersją tekstu — zero komentarzy, wstępu ani podsumowania`;
}

async function processBatch(batchText, langName, model) {
  const token = getToken();
  if (!token) throw new Error('Nie jesteś zalogowany. Zaloguj się w Ustawieniach.');

  const resp = await fetch(`${WORKER_URL}/translate`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: buildSystemPrompt(langName) },
        { role: 'user',   content: batchText },
      ],
    }),
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
}

/**
 * Generate polyglot text for a chapter.
 * Splits long text into batches to avoid LLM token limits.
 *
 * @param {string} chapterText  - plain text of the chapter
 * @param {object} opts
 *   @param {string} opts.targetLangName  - e.g. "hiszpański"
 *   @param {string} [opts.model]         - default "deepseek-chat"
 * @param {(done: number, total: number, cost: number, secs: number) => void} [onProgress]
 * @returns {Promise<{rawText: string, cost: number, elapsedMs: number}>}
 */
export async function generatePolyglot(chapterText, { targetLangName, model = 'deepseek-chat' }, onProgress) {
  const paragraphs = chapterText
    .split(/\n\n+/)
    .map(p => p.trim())
    .filter(p => p.length > 5);

  const BATCH_CHARS = 3500;
  const batches = [];
  let cur = [], len = 0;

  for (const p of paragraphs) {
    if (len + p.length > BATCH_CHARS && cur.length > 0) {
      batches.push(cur.join('\n\n'));
      cur = [p];
      len = p.length;
    } else {
      cur.push(p);
      len += p.length + 2;
    }
  }
  if (cur.length > 0) batches.push(cur.join('\n\n'));

  if (batches.length === 0) {
    throw new Error('Rozdział nie zawiera wystarczającej ilości tekstu.');
  }

  const pricing = MODEL_PRICING[model] ?? { input: 0, output: 0 };
  const startTime = Date.now();
  let totalCost = 0;
  const results = [];

  for (let i = 0; i < batches.length; i++) {
    onProgress?.(i + 1, batches.length, totalCost, (Date.now() - startTime) / 1000);
    const { text, promptTokens, completionTokens } = await processBatch(batches[i], targetLangName, model);
    totalCost += (promptTokens / 1000) * pricing.input + (completionTokens / 1000) * pricing.output;
    results.push(text);
    onProgress?.(i + 1, batches.length, totalCost, (Date.now() - startTime) / 1000);
  }

  return { rawText: results.join('\n\n'), cost: totalCost, elapsedMs: Date.now() - startTime };
}
