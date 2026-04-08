import { useState, useEffect, useRef, useCallback } from "react";
import { EpubParser } from "../lib/epubParser";
import {
  getActiveBooks,
  saveBook,
  softDeleteBook,
  getReadingPosition,
} from "../db";
import BatchGenModal from "./BatchGenModal";
import ImportDialog from "./ImportDialog";
import { version } from "../../package.json";
import { uploadBook } from "../sync/cfSync";

export default function Library({ onOpenBook, onOpenSettings, settings }) {
  const [books, setBooks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState("");
  const [dragging, setDragging] = useState(false);
  const [positions, setPositions] = useState({});
  const [batchBook, setBatchBook] = useState(null); // book opened in BatchGenModal
  const [importDraft, setImportDraft] = useState(null); // parsed EPUB awaiting user confirmation
  const fileInputRef = useRef(null);

  const loadBooks = useCallback(async () => {
    const list = await getActiveBooks();
    setBooks(list);
    const pos = {};
    for (const b of list) {
      const p = await getReadingPosition(b.id);
      if (p) pos[b.id] = p;
    }
    setPositions(pos);
    setLoading(false);
  }, []);

  useEffect(() => {
    loadBooks();
  }, [loadBooks]);

  useEffect(() => {
    window.addEventListener("vocabapp:synced", loadBooks);
    return () => window.removeEventListener("vocabapp:synced", loadBooks);
  }, [loadBooks]);

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
      if (!parsed.chapters.length)
        throw new Error("EPUB nie zawiera żadnych rozdziałów.");
      setAdding(false);
      setImportDraft(parsed);
    } catch (err) {
      setAddError(err.message || "Nie udało się otworzyć pliku EPUB.");
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
    await softDeleteBook(bookId);
    setBooks((prev) => prev.filter((b) => b.id !== bookId));
  }

  const progressLabel = (bookId, chapterCount) => {
    const pos = positions[bookId];
    if (!pos || !chapterCount) return "";
    return `${pos.chapterIndex + 1} / ${chapterCount} rozdz.`;
  };

  return (
    <div className="lib-layout">
      <header className="lib-header">
        <div className="wordmark">
          <em>Reader</em>
        </div>
        <div className="lib-header-actions">
          <button
            className="btn-ghost"
            onClick={() => fileInputRef.current?.click()}
            disabled={adding}
          >
            {adding ? "Ładowanie…" : "+ Dodaj książkę"}
          </button>
          <button
            className="ctl ctl-icon"
            onClick={onOpenSettings}
            title="Ustawienia"
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
        {addError && (
          <div style={{ color: "var(--red)", fontSize: 13, marginBottom: 20 }}>
            ⚠ {addError}
          </div>
        )}

        {loading ? (
          <div
            style={{
              display: "flex",
              justifyContent: "center",
              paddingTop: 80,
            }}
          >
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
            style={{ marginTop: 40 }}
          >
            <div className="dropzone-glyph">📚</div>
            <div className="dropzone-title">Twoja biblioteka jest pusta</div>
            <p className="dropzone-sub">
              Przeciągnij plik <strong>.epub</strong> tutaj lub kliknij, by
              wybrać
            </p>
            <button className="btn-primary" disabled={adding}>
              {adding ? "Ładowanie…" : "Wybierz plik EPUB"}
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
              <div
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
                  className="book-delete-btn"
                  onClick={(e) => handleDelete(e, book.id)}
                  title="Usuń"
                >
                  ✕
                </button>
                <div className="book-title">{book.title}</div>
                {book.author && (
                  <div className="book-author">{book.author}</div>
                )}
                {positions[book.id] && (
                  <div className="book-progress">
                    {progressLabel(book.id, book.chapterCount)}
                  </div>
                )}
                {settings && (
                  <button
                    className="book-poly-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      setBatchBook(book);
                    }}
                    title="Generuj teksty Poligloty"
                  >
                    {settings.targetLangFlag} Poliglota
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
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

      <footer
        style={{
          textAlign: "center",
          padding: "12px 0",
          fontSize: 11,
          color: "var(--txt-3, #555)",
        }}
      >
        v{version}
      </footer>
    </div>
  );
}
