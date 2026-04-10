import { useState, useEffect, useRef, useCallback } from "react";
import { EpubParser } from "../lib/epubParser";
import {
  getActiveBooks,
  saveBook,
  softDeleteBook,
  purgeBookData,
  getReadingPosition,
} from "../db";
import BatchGenModal from "./BatchGenModal";
import ImportDialog from "./ImportDialog";
import { version } from "../../package.json";
import { isLoggedIn, onAuthChange } from "../sync/cfAuth";
import { syncAll, uploadBook, deleteRemoteBook } from "../sync/cfSync";

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

export default function Library({ onOpenBook, onOpenSettings, settings }) {
  const [books, setBooks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState("");
  const [dragging, setDragging] = useState(false);
  const [positions, setPositions] = useState({});
  const [batchBook, setBatchBook] = useState(null);
  const [importDraft, setImportDraft] = useState(null);
  const [ctxBookId, setCtxBookId] = useState(null);
  const [cfConnected, setCfConnected] = useState(() => isLoggedIn());
  const [syncStatus, setSyncStatus] = useState(null);
  const [syncProgress, setSyncProgress] = useState(null);
  const [syncNow, setSyncNow] = useState(() => Date.now());
  const [lastSync, setLastSync] = useState(() => {
    const value = localStorage.getItem("vocabapp:lastSync");
    return value ? Number(value) : null;
  });
  const fileInputRef = useRef(null);

  useEffect(() => onAuthChange(setCfConnected), []);

  useEffect(() => {
    const timer = window.setInterval(() => setSyncNow(Date.now()), 60 * 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!ctxBookId) return;
    const close = () => setCtxBookId(null);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [ctxBookId]);

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

  const handleManualSync = useCallback(async ({ silent = false } = {}) => {
    if (!cfConnected) {
      if (!silent) onOpenSettings();
      return;
    }

    if (syncStatus === "syncing") return;

    if (!silent) {
      setSyncStatus("syncing");
      setSyncProgress(null);
    }

    const result = await syncAll((done, total) => {
      if (!silent) setSyncProgress({ done, total });
    });

    if (!silent) {
      setSyncStatus(result);
      setSyncProgress(null);
      window.setTimeout(() => setSyncStatus(null), 8000);
    }

    if (result.lastSync) setLastSync(result.lastSync);
  }, [cfConnected, onOpenSettings, syncStatus]);

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
      onOpenBook(bookId);
    } catch (err) {
      setAddError(err.message || "Nie udało się zapisać książki.");
    } finally {
      setAdding(false);
    }
  }

  function handleDrop(e) {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
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

  return (
    <div className="lib-layout">
      <header className="lib-header">
        <div className="wordmark">
          <em>Reader</em>
        </div>

        <div className="lib-header-actions">
          <button
            className="ctl ctl-icon lib-header-icon"
            onClick={onOpenSettings}
            title="Ustawienia aplikacji"
            aria-label="Ustawienia aplikacji"
          >
            ⚙
          </button>
        </div>
      </header>

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
            <div className="lib-toolbar-copy">
              <span className="lib-kicker">Biblioteka</span>
              <h1 className="lib-title">Twoje książki</h1>
              <p className="lib-toolbar-note">
                {books.length
                  ? "Wróć do czytania albo dodaj kolejne pliki EPUB."
                  : "Dodaj pierwszy plik EPUB, aby rozpocząć czytanie."}
              </p>
              <div className="lib-toolbar-cta">
                <button
                  className="btn-primary lib-add-book-btn"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={adding}
                  title="Dodaj książkę"
                  aria-label="Dodaj książkę"
                >
                  <span className="lib-add-book-icon" aria-hidden="true">
                    {adding ? "..." : "+"}
                  </span>
                  {books.length ? "Dodaj książkę" : "Dodaj pierwszy EPUB"}
                </button>
                <span className="lib-toolbar-hint">
                  Możesz też przeciągnąć plik EPUB bezpośrednio do biblioteki.
                </span>
              </div>
            </div>

            <div className="lib-sync-strip">
              <div className="lib-sync-main">
                <div className="lib-sync-state">
                  <span
                    className={`lib-sync-dot ${cfConnected ? "is-online" : "is-offline"}`}
                    aria-hidden="true"
                  />
                  {cfConnected ? "Synchronizacja aktywna" : "Konto niepołączone"}
                </div>
                <div className="lib-sync-meta">
                  <span>
                    Ostatni sync: {formatLastSync(lastSync)}
                    {lastSync ? ` (${formatRelativeSync(lastSync, syncNow)})` : ""}
                  </span>
                </div>
              </div>

              <div className="lib-sync-actions">
                <button
                  className={`ctl ${syncStatus === "syncing" ? "ctl-active" : ""}`}
                  onClick={handleSyncButton}
                  disabled={syncStatus === "syncing"}
                >
                  {cfConnected
                    ? syncStatus === "syncing"
                      ? "⟳"
                      : "↻"
                    : "Połącz konto"}
                </button>
              </div>

              {syncStatus === "syncing" && syncProgress && (
                <div className="lib-sync-progress">
                  <div className="lib-sync-progress-track">
                    <div
                      className="lib-sync-progress-fill"
                      style={{
                        width: syncProgress.total > 0
                          ? `${(syncProgress.done / syncProgress.total) * 100}%`
                          : "0%",
                      }}
                    />
                  </div>
                  <div className="lib-sync-progress-label">
                    {syncProgress.done} / {syncProgress.total}
                  </div>
                </div>
              )}

              {syncStatus && syncStatus !== "syncing" && (
                <div
                  className={`lib-sync-feedback ${syncStatus.error ? "is-error" : "is-success"}`}
                >
                  {syncStatus.error
                    ? `Błąd synchronizacji: ${syncStatus.error}`
                    : `Zsynchronizowano ${syncStatus.synced} elementów · ↑ ${syncStatus.sentMB} MB · ↓ ${syncStatus.receivedMB} MB`}
                </div>
              )}
            </div>
          </section>

          {addError && <div className="lib-error-banner">⚠ {addError}</div>}

          {loading ? (
            <div className="lib-loading">
              <div className="spin-ring" />
            </div>
          ) : books.length === 0 ? (
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
                Przeciągnij plik <strong>.epub</strong> tutaj lub kliknij, aby go dodać.
              </p>
              <button className="btn-primary" disabled={adding}>
                {adding ? "Ładowanie..." : "Wybierz plik EPUB"}
              </button>
            </div>
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
              {books.map((book) => (
                <article
                  key={book.id}
                  className="book-card"
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
                    ⋯
                  </button>

                  {ctxBookId === book.id && (
                    <div className="book-ctx-menu" onClick={(e) => e.stopPropagation()}>
                      <button
                        className="book-ctx-primary"
                        onClick={() => {
                          onOpenBook(book.id);
                          setCtxBookId(null);
                        }}
                      >
                        Otwórz książkę
                      </button>
                      {settings && (
                        <button
                          onClick={() => {
                            setBatchBook(book);
                            setCtxBookId(null);
                          }}
                        >
                          {settings.targetLangFlag} Generuj tłumaczenia
                        </button>
                      )}
                      <button
                        className="book-ctx-delete"
                        onClick={(e) => {
                          handleDelete(e, book.id);
                          setCtxBookId(null);
                        }}
                      >
                        Usuń z biblioteki
                      </button>
                    </div>
                  )}

                  <div className="book-meta">
                    <div className="book-title">{book.title}</div>
                    {book.author && <div className="book-author">{book.author}</div>}
                    <div className="book-progress-row">
                      <div className="book-progress">{progressLabel(book.id, book.chapterCount)}</div>
                      {positions[book.id] && (
                        <div className="book-progress-pct">
                          {progressPercent(book.id, book.chapterCount)}%
                        </div>
                      )}
                    </div>
                    {positions[book.id] && (
                      <div className="book-progress-bar" aria-hidden="true">
                        <div
                          className="book-progress-fill"
                          style={{ width: `${progressPercent(book.id, book.chapterCount)}%` }}
                        />
                      </div>
                    )}
                  </div>
                </article>
              ))}
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

      {batchBook && settings && (
        <BatchGenModal
          bookId={batchBook.id}
          book={batchBook}
          settings={settings}
          onClose={() => setBatchBook(null)}
        />
      )}

      <footer className="lib-footer">v{version}</footer>
    </div>
  );
}
