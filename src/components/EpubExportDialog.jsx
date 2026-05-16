import { useState, useEffect, useMemo } from 'react';
import { getBookChaptersWithCacheStatus, getPolyglotCache } from '../db';
import { parseStoredPolyglot } from '../lib/polyglotParser';
import { buildEpub } from '../lib/epubBuilder';
import { LANGUAGES } from '../hooks/useSettings';

const LANG_META = Object.fromEntries(LANGUAGES.map(l => [l.code, l]));

export default function EpubExportDialog({ bookId, book, chapterStatusMap, onClose }) {
  const availableLangs = useMemo(() => {
    const codes = new Set();
    Object.values(chapterStatusMap).forEach(s =>
      s.translationLangs?.forEach(l => codes.add(l))
    );
    return [...codes].map(code => LANG_META[code] || { code, flag: '', name: code, label: code });
  }, [chapterStatusMap]);

  const [selectedLang, setSelectedLang] = useState('');
  const [chapters, setChapters] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(new Set());
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState('');

  // Pick first available lang by default
  useEffect(() => {
    if (availableLangs.length > 0 && !selectedLang) {
      setSelectedLang(availableLangs[0].code);
    }
  }, [availableLangs, selectedLang]);

  // Reload chapter list (with hasPoly flag) when lang selection changes
  useEffect(() => {
    setLoading(true);
    getBookChaptersWithCacheStatus(bookId, selectedLang || '\x00').then(chs => {
      setChapters(chs);
      setSelected(new Set(chs.map(ch => ch.id)));
      setLoading(false);
    });
  }, [bookId, selectedLang]);

  const toExport = chapters.filter(ch => selected.has(ch.id));
  const allSelected = chapters.length > 0 && selected.size === chapters.length;
  const withPolyCount = toExport.filter(ch => ch.hasPoly).length;

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(chapters.map(ch => ch.id)));
  }

  function toggleChapter(id) {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  async function handleExport() {
    if (!toExport.length) return;
    setExporting(true);
    setError('');
    try {
      const items = await Promise.all(
        toExport.map(async ch => {
          let polyHtml = null;
          if (ch.hasPoly && selectedLang) {
            const entry = await getPolyglotCache(ch.id, selectedLang);
            if (entry) {
              try { polyHtml = parseStoredPolyglot(entry, ch.html).html; } catch { /* use original */ }
            }
          }
          return { chapter: ch, polyHtml };
        })
      );
      const bytes = buildEpub(book, items);
      const blob = new Blob([bytes], { type: 'application/epub+zip' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const safeName = (book.title || 'ksiazka')
        .replace(/[^\wÀ-ɏ\s-]/g, '')
        .trim()
        .replace(/\s+/g, '_') || 'ksiazka';
      a.download = `${safeName}.epub`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      onClose();
    } catch (err) {
      setError(err.message || 'Błąd podczas generowania EPUB.');
    } finally {
      setExporting(false);
    }
  }

  return (
    <div
      className="modal-overlay"
      onClick={e => { if (e.target === e.currentTarget && !exporting) onClose(); }}
    >
      <div className="modal bgen-modal">
        <div className="modal-head">
          <div className="modal-title">Eksport EPUB</div>
          <button className="modal-close" onClick={onClose} disabled={exporting}>✕</button>
        </div>

        <div className="modal-body">
          {availableLangs.length > 0 && (
            <div className="form-group">
              <label className="form-label">Język tłumaczenia</label>
              <select
                className="form-select"
                value={selectedLang}
                onChange={e => setSelectedLang(e.target.value)}
                disabled={exporting}
              >
                <option value="">Oryginał (bez tłumaczenia)</option>
                {availableLangs.map(l => (
                  <option key={l.code} value={l.code}>
                    {l.flag} {l.label || l.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="bgen-chapter-list">
            <div className="bgen-ch-header">
              <span className="bgen-ch-label">
                Rozdziały ({toExport.length}/{chapters.length})
              </span>
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="ctl" onClick={toggleAll} disabled={exporting || loading}>
                  {allSelected ? 'Żadne' : 'Wszystkie'}
                </button>
              </div>
            </div>
            {loading ? (
              <div style={{ display: 'flex', justifyContent: 'center', padding: 32 }}>
                <div className="spin-ring" />
              </div>
            ) : (
              chapters.map((ch, i) => (
                <label key={ch.id} className="bgen-ch-row">
                  <input
                    type="checkbox"
                    checked={selected.has(ch.id)}
                    onChange={() => toggleChapter(ch.id)}
                    disabled={exporting}
                  />
                  <span className="bgen-ch-num">{i + 1}.</span>
                  <span className="bgen-ch-title">{ch.title || `Rozdział ${i + 1}`}</span>
                  {selectedLang && (
                    <span className="bgen-ch-status">
                      <span
                        className={`bgen-dot ${ch.hasPoly ? 'done' : 'empty'}`}
                        title={ch.hasPoly ? 'Ma tłumaczenie' : 'Brak tłumaczenia'}
                      />
                    </span>
                  )}
                </label>
              ))
            )}
          </div>

          {!loading && selectedLang && toExport.length > 0 && (
            <div style={{ fontSize: 12, color: 'var(--txt-3)' }}>
              {withPolyCount} z {toExport.length} wybranych rozdziałów zawiera tłumaczenie inline.
              {withPolyCount < toExport.length && ' Pozostałe zostaną wyeksportowane w oryginale.'}
            </div>
          )}

          {error && (
            <div style={{ color: 'var(--error, #e07070)', fontSize: 13 }}>{error}</div>
          )}
        </div>

        <div className="modal-foot">
          <button className="btn-ghost" onClick={onClose} disabled={exporting}>Anuluj</button>
          <button
            className="btn-primary"
            onClick={handleExport}
            disabled={exporting || !toExport.length || loading}
          >
            {exporting
              ? 'Generowanie…'
              : `Pobierz EPUB${toExport.length ? ` (${toExport.length})` : ''}`}
          </button>
        </div>
      </div>
    </div>
  );
}
