import { useState, useEffect, useMemo } from 'react';
import { getBookChaptersWithCacheStatus, savePolyglotCache } from '../db';
import { generatePolyglot } from '../lib/polyglotApi';
import { uploadPolyglot } from '../sync/cfSync';

/* Cost table: USD per 1M tokens */
const MODEL_PRICES = {
  'deepseek-chat':                        { in: 0.07,  out: 0.28  },
  'deepseek-reasoner':                    { in: 0.55,  out: 2.19  },
  'gpt-4o-mini':                          { in: 0.15,  out: 0.60  },
  'gpt-4o':                               { in: 2.50,  out: 10.00 },
  'google/gemini-flash-1.5':              { in: 0.075, out: 0.30  },
  'meta-llama/llama-3.3-70b-instruct':   { in: 0,     out: 0     },
  'anthropic/claude-3.5-haiku':          { in: 0.80,  out: 4.00  },
};

function estimateCostUSD(chars, modelId) {
  const tokens = chars / 4;
  const p = MODEL_PRICES[modelId] ?? { in: 0.5, out: 1.0 };
  return (p.in * tokens + p.out * tokens * 1.3) / 1_000_000;
}

function estimateTimeSec(chars) {
  return Math.ceil(chars / 3500) * 7;
}

function fmtTime(s) {
  if (s < 60) return `~${s}s`;
  return `~${Math.ceil(s / 60)} min`;
}

function fmtCost(usd) {
  if (usd < 0.001) return '< $0.001';
  return `~$${usd.toFixed(3)}`;
}

export default function BatchGenModal({ bookId, book, settings, onClose }) {
  const [chapters, setChapters]   = useState([]);
  const [loading, setLoading]     = useState(true);
  const [selected, setSelected]   = useState(new Set());
  const [generating, setGenerating] = useState(false);
  const [genStep, setGenStep]     = useState(null);  // { chIdx, total, batchDone, batchTotal }
  const [errors, setErrors]       = useState({});    // chapterId → message
  const [done, setDone]           = useState(false);

  useEffect(() => {
    getBookChaptersWithCacheStatus(bookId, settings.targetLang).then(chs => {
      setChapters(chs);
      // Pre-select chapters without polyglot cache
      setSelected(new Set(chs.filter(c => !c.hasPoly).map(c => c.id)));
      setLoading(false);
    });
  }, [bookId, settings.targetLang]);

  const toGenerate = useMemo(
    () => chapters.filter(c => selected.has(c.id) && !c.hasPoly),
    [chapters, selected]
  );

  const { totalChars, costUSD, timeSec } = useMemo(() => {
    const totalChars = toGenerate.reduce((s, c) => s + (c.text?.length ?? 0), 0);
    return {
      totalChars,
      costUSD: estimateCostUSD(totalChars, settings.polyglotModel),
      timeSec: estimateTimeSec(totalChars),
    };
  }, [toGenerate, settings.polyglotModel]);

  function toggleChapter(id) {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function selectAll() { setSelected(new Set(chapters.filter(c => !c.hasPoly).map(c => c.id))); }
  function selectNone() { setSelected(new Set()); }

  async function handleGenerate() {
    setGenerating(true);
    setErrors({});
    setDone(false);

    for (let i = 0; i < toGenerate.length; i++) {
      const ch = toGenerate[i];
      setGenStep({ chIdx: i, total: toGenerate.length, batchDone: 0, batchTotal: 0 });
      try {
        const { rawText } = await generatePolyglot(
          ch.text,
          { targetLangName: settings.targetLangName, model: settings.polyglotModel },
          (done, total) => setGenStep(s => ({ ...s, batchDone: done, batchTotal: total }))
        );
        await savePolyglotCache(ch.id, settings.targetLang, rawText);
        uploadPolyglot(bookId, ch.chapterIndex, settings.targetLang, rawText);
        // Mark chapter as done
        setChapters(prev => prev.map(c => c.id === ch.id ? { ...c, hasPoly: true } : c));
        setSelected(prev => { const n = new Set(prev); n.delete(ch.id); return n; });
      } catch (err) {
        setErrors(prev => ({ ...prev, [ch.id]: err.message || 'Błąd API' }));
      }
    }

    setGenerating(false);
    setGenStep(null);
    setDone(true);
  }

  const currentChapter = genStep ? toGenerate[genStep.chIdx] : null;

  return (
    <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget && !generating) onClose(); }}>
      <div className="modal bgen-modal">
        <div className="modal-head">
          <div className="modal-title">Generuj Poliglotę — {book?.title}</div>
          <button className="modal-close" onClick={onClose} disabled={generating}>✕</button>
        </div>

        <div className="modal-body">

          {loading ? (
            <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}>
              <div className="spin-ring" />
            </div>
          ) : (
            <>
              {/* Language + model info */}
              <div className="bgen-info">
                <span>{settings.targetLangFlag} <strong>{settings.targetLangName}</strong></span>
                <span className="bgen-sep">·</span>
                <span>{settings.polyglotModel}</span>
                <span className="bgen-sep">·</span>
                <span>{settings.provider}</span>
              </div>

              {/* Chapter list */}
              <div className="bgen-chapter-list">
                <div className="bgen-ch-header">
                  <span className="bgen-ch-label">Rozdziały ({chapters.length})</span>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button className="ctl" onClick={selectAll} disabled={generating}>Wszystkie</button>
                    <button className="ctl" onClick={selectNone} disabled={generating}>Żadne</button>
                  </div>
                </div>
                {chapters.map((ch, i) => (
                  <label
                    key={ch.id}
                    className={`bgen-ch-row ${ch.hasPoly ? 'has-poly' : ''} ${errors[ch.id] ? 'has-error' : ''}`}
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(ch.id) && !ch.hasPoly}
                      disabled={ch.hasPoly || generating}
                      onChange={() => toggleChapter(ch.id)}
                    />
                    <span className="bgen-ch-num">{i + 1}.</span>
                    <span className="bgen-ch-title">{ch.title || `Rozdział ${i + 1}`}</span>
                    <span className="bgen-ch-status">
                      {ch.hasPoly
                        ? <span className="bgen-dot done" title="Gotowe">✓</span>
                        : errors[ch.id]
                          ? <span className="bgen-dot error" title={errors[ch.id]}>✕</span>
                          : <span className="bgen-dot empty" title="Brak">○</span>
                      }
                    </span>
                  </label>
                ))}
              </div>

              {/* Estimates */}
              {toGenerate.length > 0 && !generating && !done && (
                <div className="bgen-estimate">
                  <span><strong>{toGenerate.length}</strong> {toGenerate.length === 1 ? 'rozdział' : 'rozdziały/ów'}</span>
                  <span className="bgen-sep">·</span>
                  <span>Czas: <strong>{fmtTime(timeSec)}</strong></span>
                  <span className="bgen-sep">·</span>
                  <span>Koszt: <strong>{fmtCost(costUSD)}</strong></span>
                </div>
              )}

              {/* Progress during generation */}
              {generating && genStep && (
                <div className="bgen-progress">
                  <div className="bgen-progress-label">
                    Rozdział {genStep.chIdx + 1} / {genStep.total}
                    {currentChapter?.title ? ` · ${currentChapter.title}` : ''}
                    {genStep.batchTotal > 0
                      ? ` — partia ${genStep.batchDone}/${genStep.batchTotal}`
                      : ' — łączenie…'}
                  </div>
                  {genStep.batchTotal > 0 && (
                    <div className="poly-progress-bar" style={{ width: '100%', marginTop: 8 }}>
                      <div
                        className="poly-progress-fill"
                        style={{ width: `${(genStep.batchDone / genStep.batchTotal) * 100}%` }}
                      />
                    </div>
                  )}
                  <div className="poly-progress-bar" style={{ width: '100%', marginTop: 6 }}>
                    <div
                      className="poly-progress-fill"
                      style={{ width: `${(genStep.chIdx / genStep.total) * 100}%`, background: 'rgba(192,144,80,.35)' }}
                    />
                  </div>
                </div>
              )}

              {done && (
                <div className="bgen-done">
                  Generowanie zakończone. {Object.keys(errors).length > 0
                    ? `${Object.keys(errors).length} błędów.`
                    : 'Wszystko gotowe ✓'}
                </div>
              )}
            </>
          )}
        </div>

        <div className="modal-foot">
          {!done ? (
            <button
              className="btn-primary"
              onClick={handleGenerate}
              disabled={generating || toGenerate.length === 0}
            >
              {generating ? 'Generuję…' : `Generuj ${toGenerate.length > 0 ? `(${toGenerate.length})` : ''}`}
            </button>
          ) : (
            <button className="btn-primary" onClick={onClose}>Zamknij</button>
          )}
          {!generating && <button className="btn-ghost" onClick={onClose}>Anuluj</button>}
        </div>
      </div>
    </div>
  );
}
