import { useState, useEffect, useMemo } from 'react';
import {
  Button,
  Checkbox,
  Group,
  Loader,
  Modal,
  ScrollArea,
  Select,
  Stack,
  Text,
} from '@mantine/core';
import { getBookChaptersWithCacheStatus, getChapterStatusMap, getPolyglotCache } from '../db';
import { parseStoredPolyglot } from '../lib/polyglotParser';
import { buildEpub } from '../lib/epubBuilder';
import { LANGUAGES } from '../hooks/useSettings';

const LANG_META = Object.fromEntries(LANGUAGES.map(l => [l.code, l]));

export default function EpubExportDialog({ bookId, book, onClose }) {
  const [statusMap, setStatusMap] = useState({});
  const [selectedLang, setSelectedLang] = useState('');
  const [chapters, setChapters] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(new Set());
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState('');

  // Load which languages exist across all chapters
  useEffect(() => {
    getChapterStatusMap(bookId).then(map => {
      setStatusMap(map);
      // Pick first available language
      const codes = new Set();
      Object.values(map).forEach(s => s.translationLangs?.forEach(l => codes.add(l)));
      if (codes.size > 0) setSelectedLang([...codes][0]);
    });
  }, [bookId]);

  const availableLangs = useMemo(() => {
    const codes = new Set();
    Object.values(statusMap).forEach(s => s.translationLangs?.forEach(l => codes.add(l)));
    return [...codes].map(code => LANG_META[code] || { code, flag: '', name: code, label: code });
  }, [statusMap]);

  // Reload chapter list with hasPoly flag when language changes
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
  const translatedChapters = chapters.filter(ch => ch.hasPoly);
  const withPolyCount = toExport.filter(ch => ch.hasPoly).length;

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(chapters.map(ch => ch.id)));
  }

  function selectTranslated() {
    setSelected(new Set(translatedChapters.map(ch => ch.id)));
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
              try { polyHtml = parseStoredPolyglot(entry, ch.html).html; } catch { /* fallback to original */ }
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
    <Modal
      opened
      onClose={() => { if (!exporting) onClose(); }}
      title="Eksport EPUB"
      centered
    >
      <Stack gap="md">
        {availableLangs.length > 0 && (
          <Select
            label="Język tłumaczenia"
            data={[
              { value: '', label: 'Oryginał (bez tłumaczenia)' },
              ...availableLangs.map(l => ({
                value: l.code,
                label: `${l.flag} ${l.label || l.name}`.trim(),
              })),
            ]}
            value={selectedLang}
            onChange={(value) => setSelectedLang(value ?? '')}
            disabled={exporting}
            allowDeselect={false}
          />
        )}

        <Stack gap="xs">
          <Group justify="space-between">
            <Text size="sm" fw={600}>
              Rozdziały ({toExport.length}/{chapters.length})
            </Text>
            <Group gap={6}>
              {selectedLang && translatedChapters.length > 0 && (
                <Button
                  variant="default"
                  size="compact-xs"
                  onClick={selectTranslated}
                  disabled={exporting || loading}
                  title="Zaznacz tylko rozdziały z tłumaczeniem"
                >
                  Z tłumaczeniem
                </Button>
              )}
              <Button variant="default" size="compact-xs" onClick={toggleAll} disabled={exporting || loading}>
                {allSelected ? 'Żadne' : 'Wszystkie'}
              </Button>
            </Group>
          </Group>

          {loading ? (
            <Group justify="center" p="xl"><Loader size="sm" /></Group>
          ) : (
            <ScrollArea.Autosize mah={300}>
              <Stack gap={6}>
                {chapters.map((ch, i) => (
                  <Checkbox
                    key={ch.id}
                    checked={selected.has(ch.id)}
                    onChange={() => toggleChapter(ch.id)}
                    disabled={exporting}
                    label={`${i + 1}. ${ch.title || `Rozdział ${i + 1}`}${selectedLang && ch.hasPoly ? ' ●' : ''}`}
                  />
                ))}
              </Stack>
            </ScrollArea.Autosize>
          )}
        </Stack>

        {!loading && selectedLang && toExport.length > 0 && (
          <Text size="xs" c="dimmed">
            {withPolyCount} z {toExport.length} wybranych rozdziałów zawiera tłumaczenie.
            {withPolyCount < toExport.length && ' Pozostałe zostaną wyeksportowane w oryginale.'}
          </Text>
        )}

        {error && <Text size="sm" c="red">{error}</Text>}

        <Group justify="flex-end">
          <Button variant="subtle" onClick={onClose} disabled={exporting}>Anuluj</Button>
          <Button
            onClick={handleExport}
            loading={exporting}
            disabled={!toExport.length || loading}
          >
            {`Pobierz EPUB${toExport.length ? ` (${toExport.length})` : ''}`}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
