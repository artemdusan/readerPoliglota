import { useState, useEffect, useRef, useCallback } from "react";
import { BsSun, BsMoon, BsGear, BsArrowRepeat, BsPlus, BsBook } from "react-icons/bs";
import { EpubParser } from "../lib/epubParser";
import {
  getActiveBooks,
  saveBook,
  updateBookMetadata,
  softDeleteBook,
  purgeBookData,
  getReadingPosition,
  setBookStatus,
} from "../db";
import BatchGenModal from "./BatchGenModal";
import BookMetadataDialog from "./BookMetadataDialog";
import ImportDialog from "./ImportDialog";
import { version } from "../../package.json";
import { getUsername, isLoggedIn, onAuthChange } from "../sync/cfAuth";
import { syncAll, uploadBook, deleteRemoteBook, syncBookStatus } from "../sync/cfSync";
import { getSyncActivity, subscribeSyncActivity } from "../sync/syncActivity";

function getDroppedFiles(dataTransfer) {
  if (!dataTransfer) return [];
  if (dataTransfer.files?.length) return Array.from(dataTransfer.files);

  return Array.from(dataTransfer.items || [])
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter(Boolean);
}

function hasDraggedFiles(event) {
  const types = event.dataTransfer?.types;
  return Array.isArray(types)
    ? types.includes("Files")
    : Array.from(types || []).includes("Files");
}

function formatLastSync(ts) {
  if (!ts) return "Jeszcze nie synchronizowano";
  return new Date(ts).toLocaleString("pl-PL", {
    dateStyle: "short",
    timeStyle: "short",
  });
}

function formatRelativeSync(ts, now) {
  if (!ts) return "";

  const diffMs = Math.max(0, now - ts);
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (diffMs < minute) return "przed chwilą";

  if (diffMs < hour) {
    const minutes = Math.floor(diffMs / minute);
    return `${minutes} min temu`;
  }

  if (diffMs < day) {
    const hours = Math.floor(diffMs / hour);
    return `${hours} godz. temu`;
  }

  const days = Math.floor(diffMs / day);
  return `${days} dni temu`;
}

function formatTransfer(bytes, fallbackMB = 0) {
  if (typeof bytes === "number" && Number.isFinite(bytes)) {
    if (bytes < 1_048_576) {
      return `${Math.max(0.01, bytes / 1024).toFixed(2)} KB`;
    }
    return `${(bytes / 1_048_576).toFixed(2)} MB`;
  }
  return `${fallbackMB} MB`;
}

function formatPolishCount(count, forms) {
  const mod10 = count % 10;
  const mod100 = count % 100;

  if (count === 1) return `1 ${forms[0]}`;
  if (mod10 >= 2 && mod10 <= 4 && !(mod100 >= 12 && mod100 <= 14)) {
    return `${count} ${forms[1]}`;
  }
  return `${count} ${forms[2]}`;
}

function getSyncCardTone(cfConnected, phase) {
  if (!cfConnected) return "is-offline";
  if (phase === "syncing") return "is-syncing";
  if (phase === "error") return "is-error";
  return "is-idle";
}

function getSyncCardTitle(cfConnected, phase) {
  if (!cfConnected) return "Konto niepołączone";
  if (phase === "syncing") return "Synchronizowanie...";
  if (phase === "error") return "Błąd synchronizacji";
  return "Zalogowany";
}

export default function Library({
  onOpenBook,
  onOpenSettings,
  onUpdateSetting,
  settings,
}) {
  const [books, setBooks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState("");
  const [dragging, setDragging] = useState(false);
  const [positions, setPositions] = useState({});
  const [batchBook, setBatchBook] = useState(null);
  const [importDraft, setImportDraft] = useState(null);
  const [editingBook, setEditingBook] = useState(null);
  const [ctxBookId, setCtxBookId] = useState(null);
  const [cfConnected, setCfConnected] = useState(() => isLoggedIn());
  const [accountName, setAccountName] = useState(() => getUsername());
  const [syncActivity, setSyncActivity] = useState(() => getSyncActivity());
  const [syncNow, setSyncNow] = useState(() => Date.now());
  const [lastSync, setLastSync] = useState(() => {
    const value = localStorage.getItem("vocabapp:lastSync");
    return value ? Number(value) : null;
  });
  const [showFeedback, setShowFeedback] = useState(false);
  const [activeTab, setActiveTab] = useState('active');
  const [search, setSearch] = useState('');
  const fileInputRef = useRef(null);

  useEffect(
    () =>
      onAuthChange((loggedIn, nextUsername) => {
        setCfConnected(loggedIn);
        setAccountName(nextUsername);
      }),
    [],
  );

  useEffect(() => {
    const timer = window.setInterval(() => setSyncNow(Date.now()), 60 * 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => subscribeSyncActivity(setSyncActivity), []);

  useEffect(() => {
    if (!syncActivity.result) return;
    setShowFeedback(true);
    const t = setTimeout(() => setShowFeedback(false), 4000);
    return () => clearTimeout(t);
  }, [syncActivity.result]);

  useEffect(() => {
    if (!ctxBookId) return;
    const close = () => setCtxBookId(null);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [ctxBookId]);

  // Drag & Drop dla całego okna
  useEffect(() => {
    let dragDepth = 0;

    function handleWindowDragEnter(event) {
      if (!hasDraggedFiles(event)) return;
      event.preventDefault();
      dragDepth += 1;
      setDragging(true);
    }

    function handleWindowDragOver(event) {
      if (!hasDraggedFiles(event)) return;
      event.preventDefault();
      setDragging(true);
    }

    function handleWindowDragLeave(event) {
      if (!hasDraggedFiles(event)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) setDragging(false);
    }

    function handleWindowDrop(event) {
      if (!hasDraggedFiles(event)) return;
      event.preventDefault();
      dragDepth = 0;
      setDragging(false);
      const file = getDroppedFiles(event.dataTransfer)[0];
      if (file) handleFile(file);
    }

    window.addEventListener("dragenter", handleWindowDragEnter);
    window.addEventListener("dragover", handleWindowDragOver);
    window.addEventListener("dragleave", handleWindowDragLeave);
    window.addEventListener("drop", handleWindowDrop);

    return () => {
      window.removeEventListener("dragenter", handleWindowDragEnter);
      window.removeEventListener("dragover", handleWindowDragOver);
      window.removeEventListener("dragleave", handleWindowDragLeave);
      window.removeEventListener("drop", handleWindowDrop);
    };
  }, []);

  const loadBooks = useCallback(async () => {
    const list = await getActiveBooks();
    const nextPositions = {};
    for (const book of list) {
      const position = await getReadingPosition(book.id);
      if (position) nextPositions[book.id] = position;
    }

    const sorted = [...list].sort((a, b) => {
      const aTs = nextPositions[a.id]?.updatedAt ?? a.createdAt ?? 0;
      const bTs = nextPositions[b.id]?.updatedAt ?? b.createdAt ?? 0;
      return bTs - aTs;
    });

    setBooks(sorted);
    setPositions(nextPositions);
    setLoading(false);
  }, []);

  useEffect(() => {
    loadBooks();
  }, [loadBooks]);

  useEffect(() => {
    function handleSynced() {
      const value = localStorage.getItem("vocabapp:lastSync");
      setLastSync(value ? Number(value) : Date.now());
      loadBooks();
    }

    window.addEventListener("vocabapp:synced", handleSynced);
    return () => window.removeEventListener("vocabapp:synced", handleSynced);
  }, [loadBooks]);

  const handleManualSync = useCallback(
    async ({ silent = false } = {}) => {
      if (!cfConnected) {
        if (!silent) onOpenSettings();
        return;
      }

      if (syncActivity.phase === "syncing") return;
      const result = await syncAll();
      if (result.lastSync) setLastSync(result.lastSync);
    },
    [cfConnected, onOpenSettings, syncActivity.phase],
  );

  useEffect(() => {
    if (!cfConnected) return;

    function handleOnline() {
      handleManualSync({ silent: true });
    }

    window.addEventListener("online", handleOnline);
    return () => window.removeEventListener("online", handleOnline);
  }, [cfConnected, handleManualSync]);

  async function handleSyncButton() {
    if (!cfConnected) {
      onOpenSettings();
      return;
    }

    handleManualSync();
  }

  async function handleFile(file) {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".epub")) {
      setAddError("Wybierz plik z rozszerzeniem .epub");
      return;
    }

    setAdding(true);
    setAddError("");

    try {
      const parsed = await EpubParser.parse(file);
      if (!parsed.chapters.length) {
        throw new Error("EPUB nie zawiera żadnych rozdziałów.");
      }
      setImportDraft(parsed);
    } catch (err) {
      setAddError(err.message || "Nie udało się otworzyć pliku EPUB.");
    } finally {
      setAdding(false);
    }
  }

  async function handleImportConfirm(draft) {
    setImportDraft(null);
    setAdding(true);

    try {
      const bookId = await saveBook(draft, draft.chapters);
      uploadBook(bookId);
      await loadBooks();
    } catch (err) {
      setAddError(err.message || "Nie udało się zapisać książki.");
    } finally {
      setAdding(false);
    }
  }

  async function handleMetadataSave(updatedBook) {
    setEditingBook(null);
    setAdding(true);
    setAddError("");

    try {
      const savedBook = await updateBookMetadata(updatedBook.id, updatedBook);
      await uploadBook(savedBook.id);
      await loadBooks();
    } catch (err) {
      setAddError(err.message || "Nie udało się zapisać metadanych książki.");
    } finally {
      setAdding(false);
    }
  }

  function handleDrop(e) {
    e.preventDefault();
    setDragging(false);
    const file = getDroppedFiles(e.dataTransfer)[0];
    if (file) handleFile(file);
  }

  async function handleDelete(e, bookId) {
    e.stopPropagation();
    if (!confirm("Usunąć tę książkę z biblioteki?")) return;
    const deletedAt = await softDeleteBook(bookId);
    await purgeBookData(bookId, { keepBookRecord: true });
    setBooks((prev) => prev.filter((book) => book.id !== bookId));
    setPositions((prev) => {
      const next = { ...prev };
      delete next[bookId];
      return next;
    });

    if (cfConnected) {
      await deleteRemoteBook(bookId, deletedAt);
    }
  }

  async function handleStatusChange(e, bookId, status) {
    e.stopPropagation();
    await setBookStatus(bookId, status);
    setBooks(prev => prev.map(b => b.id === bookId ? { ...b, status } : b));
    setCtxBookId(null);
    syncBookStatus(bookId, status);
  }

  function progressLabel(bookId, chapterCount) {
    const pos = positions[bookId];
    if (!pos || !chapterCount) return "Nieotwarta";
    return `Rozdział ${pos.chapterIndex + 1} z ${chapterCount}`;
  }

  function progressPercent(bookId, chapterCount) {
    const pos = positions[bookId];
    if (!pos || !chapterCount) return 0;
    return Math.max(
      0,
      Math.min(100, Math.round(((pos.chapterIndex + 1) / chapterCount) * 100)),
    );
  }

  const activeBooks   = books.filter(b => !b.status || b.status === 'active');
  const readBooks     = books.filter(b => b.status === 'read');
  const archivedBooks = books.filter(b => b.status === 'archived');

  const q = search.trim().toLowerCase();
  const allFiltered = q
    ? books.filter(b => b.title.toLowerCase().includes(q) || b.author?.toLowerCase().includes(q))
    : null;

  const baseTabBooks = allFiltered
    ? allFiltered
    : activeTab === 'read' ? readBooks : activeTab === 'archived' ? archivedBooks : activeBooks;

  const tabBooks = (!allFiltered && activeTab === 'active')
    ? [...baseTabBooks].sort((a, b) => {
        const aTs = positions[a.id]?.updatedAt ?? 0;
        const bTs = positions[b.id]?.updatedAt ?? 0;
        if (bTs !== aTs) return bTs - aTs;
        return (b.createdAt ?? 0) - (a.createdAt ?? 0);
      })
    : baseTabBooks;

  const syncTone = getSyncCardTone(cfConnected, syncActivity.phase);
  const syncTitle = getSyncCardTitle(cfConnected, syncActivity.phase);
  const isSyncing = cfConnected && syncActivity.phase === "syncing";
  const syncProgress = syncActivity.progress;
  const syncResult = syncActivity.result;
  const startedBooksCount = books.filter((book) =>
    Boolean(positions[book.id]),
  ).length;
  const syncMetaText = !cfConnected
    ? "Zaloguj się, aby synchronizować bibliotekę, postęp i tłumaczenia."
    : syncActivity.phase === "error"
      ? "Ostatnia próba się nie powiodła. Możesz spróbować ponownie ręcznie."
      : lastSync
        ? `Ostatni sync: ${formatLastSync(lastSync)} (${formatRelativeSync(lastSync, syncNow)})`
        : "Jeszcze nie wykonano pierwszej synchronizacji.";

  const currentTheme = settings?.theme ?? "dark";

  const THEME_CYCLE = { dark: "light", light: "boox", boox: "dark" };
  const THEME_NEXT_LABEL = { dark: "Tryb jasny", light: "BOOX", boox: "Tryb ciemny" };
  const THEME_NEXT_ICON = {
    dark: <BsSun />,
    light: <BsBook />,
    boox: <BsMoon />,
  };

  function handleThemeToggle() {
    onUpdateSetting("theme", THEME_CYCLE[currentTheme] ?? "dark");
  }

  return (
    <div className="lib-layout">
      <header className="lib-topbar">
        <div className="lib-topbar-inner">
          <div className="lib-topbar-left">
            <span className={`lib-topbar-dot ${syncTone}`} aria-hidden="true" />
            {cfConnected && accountName
              ? <span className="lib-topbar-account">{accountName}</span>
              : <span className="lib-topbar-account is-offline">Offline</span>
            }
            {cfConnected && lastSync && (
              <span className="lib-topbar-sync-time">
                {formatRelativeSync(lastSync, syncNow)}
              </span>
            )}
          </div>

          <div className="lib-topbar-actions">
            <button
              className="lib-topbar-btn"
              onClick={handleThemeToggle}
              title={THEME_NEXT_LABEL[currentTheme] ?? "Motyw"}
            >
              {THEME_NEXT_ICON[currentTheme] ?? <BsMoon />}
            </button>
            <button
              className="lib-topbar-btn"
              onClick={onOpenSettings}
              title="Ustawienia"
            >
              <BsGear />
            </button>
            <button
              className={`lib-topbar-btn ${isSyncing ? "is-spinning" : ""}`}
              onClick={handleSyncButton}
              disabled={isSyncing}
              title={cfConnected ? "Synchronizuj" : "Połącz konto"}
            >
              <BsArrowRepeat />
            </button>
          </div>
        </div>

        {isSyncing && syncProgress && (
          <div className="lib-topbar-progress">
            <div
              className="lib-topbar-progress-fill"
              style={{
                width: syncProgress.total > 0
                  ? `${(syncProgress.done / syncProgress.total) * 100}%`
                  : "10%",
              }}
            />
          </div>
        )}
      </header>

      {cfConnected && syncResult && !isSyncing && showFeedback && (
        <div className={`lib-toast ${syncResult.error ? "is-error" : "is-success"}`}>
          {syncResult.error
            ? `Błąd: ${syncResult.error}`
            : `Zsynchronizowano ↑ ${formatTransfer(syncResult.sentBytes)} · ↓ ${formatTransfer(syncResult.receivedBytes)}`}
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept=".epub"
        hidden
        onChange={(e) => {
          handleFile(e.target.files[0]);
          e.target.value = "";
        }}
      />

      <div className="lib-body">
        <div className="lib-content">
          <section className="lib-toolbar">
            <div className="lib-search-wrap">
              <input
                className="lib-search"
                type="search"
                placeholder="Szukaj książki…"
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
            </div>
            <div className="lib-tabs">
              <button
                className={`lib-tab ${activeTab === 'active' ? 'is-active' : ''}`}
                onClick={() => setActiveTab('active')}
              >
                Czytane
                {activeBooks.length > 0 && <span className="lib-tab-count">{activeBooks.length}</span>}
              </button>
              <button
                className={`lib-tab ${activeTab === 'read' ? 'is-active' : ''}`}
                onClick={() => setActiveTab('read')}
              >
                Przeczytane
                {readBooks.length > 0 && <span className="lib-tab-count">{readBooks.length}</span>}
              </button>
              <button
                className={`lib-tab ${activeTab === 'archived' ? 'is-active' : ''}`}
                onClick={() => setActiveTab('archived')}
              >
                Archiwum
                {archivedBooks.length > 0 && <span className="lib-tab-count">{archivedBooks.length}</span>}
              </button>
            </div>
          </section>

          {addError && <div className="lib-error-banner">⚠ {addError}</div>}

          {loading ? (
            <div className="lib-loading">
              <div className="spin-ring" />
            </div>
          ) : tabBooks.length === 0 ? (
            activeTab === 'active' ? (
            <div
              className={`dropzone ${dragging ? "over" : ""}`}
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={handleDrop}
            >
              <div className="dropzone-glyph">📚</div>
              <div className="dropzone-title">Twoja biblioteka jest pusta</div>
              <p className="dropzone-sub">
                Przeciągnij plik <strong>.epub</strong> tutaj lub kliknij, aby
                go dodać.
              </p>
              <button className="btn-primary" disabled={adding}>
                {adding ? "Ładowanie..." : "Wybierz plik EPUB"}
              </button>
            </div>
            ) : (
              <div className="lib-empty-tab">
                {activeTab === 'read' ? 'Brak przeczytanych książek.' : 'Archiwum jest puste.'}
              </div>
            )
          ) : (
            <div
              className="lib-grid"
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={handleDrop}
            >
              {tabBooks.map((book) => {
                const isStarted = Boolean(positions[book.id]);
                const percent = progressPercent(book.id, book.chapterCount);

                return (
                  <article
                    key={book.id}
                    className={`book-card ${ctxBookId === book.id ? 'has-open-menu' : ''}`}
                    onClick={() => onOpenBook(book.id)}
                  >
                    <div className="book-cover">
                      {book.cover ? (
                        <img src={book.cover} alt="okładka" />
                      ) : (
                        <span className="book-cover-ph">📖</span>
                      )}
                    </div>

                    <button
                      className="book-menu-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        setCtxBookId((id) => (id === book.id ? null : book.id));
                      }}
                      title="Menu książki"
                    >
                      ⋮
                    </button>

                    {ctxBookId === book.id && (
                      <div
                        className="book-ctx-menu"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {settings && (
                          <button
                            className="book-ctx-primary"
                            onClick={() => {
                              setBatchBook(book);
                              setCtxBookId(null);
                            }}
                          >
                            Generuj tłumaczenia
                          </button>
                        )}
                        <button
                          onClick={() => {
                            setEditingBook(book);
                            setCtxBookId(null);
                          }}
                        >
                          Edytuj
                        </button>
                        {(!book.status || book.status === 'active') && (
                          <button onClick={(e) => handleStatusChange(e, book.id, 'read')}>
                            ✓ Oznacz jako przeczytaną
                          </button>
                        )}
                        {(!book.status || book.status === 'active') && (
                          <button onClick={(e) => handleStatusChange(e, book.id, 'archived')}>
                            ⬛ Archiwizuj
                          </button>
                        )}
                        {(book.status === 'read' || book.status === 'archived') && (
                          <button onClick={(e) => handleStatusChange(e, book.id, 'active')}>
                            ↩ Przywróć do biblioteki
                          </button>
                        )}
                        {book.status === 'read' && (
                          <button onClick={(e) => handleStatusChange(e, book.id, 'archived')}>
                            ⬛ Archiwizuj
                          </button>
                        )}
                        {book.status === 'archived' && (
                          <button onClick={(e) => handleStatusChange(e, book.id, 'read')}>
                            ✓ Przenieś do przeczytanych
                          </button>
                        )}
                        <button
                          className="book-ctx-delete"
                          onClick={(e) => {
                            handleDelete(e, book.id);
                            setCtxBookId(null);
                          }}
                        >
                          Usuń
                        </button>
                      </div>
                    )}

                    <div className="book-meta">
                      {book.status === 'read' && (
                        <span className="book-status-badge is-read">Przeczytana</span>
                      )}
                      {book.status === 'archived' && (
                        <span className="book-status-badge is-archived">Archiwum</span>
                      )}
                      <div className="book-title">{book.title}</div>
                      {book.author && (
                        <div className="book-author">{book.author}</div>
                      )}

                      <div className="book-progress-block">
                        <div className="book-progress-row">
                          <div className="book-progress">
                            {progressLabel(book.id, book.chapterCount)}
                          </div>
                          <div
                            className={`book-progress-pct ${isStarted ? "" : "is-idle"}`}
                          >
                            {isStarted ? `${percent}%` : "Start"}
                          </div>
                        </div>

                        <div className="book-progress-bar" aria-hidden="true">
                          <div
                            className="book-progress-fill"
                            style={{ width: `${percent}%` }}
                          />
                        </div>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {importDraft && (
        <ImportDialog
          parsed={importDraft}
          onConfirm={handleImportConfirm}
          onCancel={() => setImportDraft(null)}
        />
      )}

      {editingBook && (
        <BookMetadataDialog
          book={editingBook}
          onConfirm={handleMetadataSave}
          onCancel={() => setEditingBook(null)}
        />
      )}

      {batchBook && settings && (
        <BatchGenModal
          bookId={batchBook.id}
          book={batchBook}
          settings={settings}
          onUpdateSetting={onUpdateSetting}
          onClose={() => setBatchBook(null)}
        />
      )}

      <button
        className={`lib-fab ${adding ? "is-loading" : ""}`}
        onClick={() => fileInputRef.current?.click()}
        disabled={adding}
        title="Dodaj książkę EPUB"
        aria-label="Dodaj książkę"
      >
        {adding ? <span className="lib-fab-spin" /> : <BsPlus />}
      </button>

      <div className="lib-version">v{version}</div>
    </div>
  );
}
