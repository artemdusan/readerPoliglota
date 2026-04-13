import { useState } from "react";
import { BOOK_SOURCE_LANGUAGES } from "../constants/bookLanguages";

export default function BookMetadataDialog({
  book,
  title = "Edytuj metadane",
  confirmLabel = "Zapisz zmiany",
  onConfirm,
  onCancel,
}) {
  const [bookTitle, setBookTitle] = useState(book?.title || "");
  const [author, setAuthor] = useState(book?.author || "");
  const [lang, setLang] = useState(book?.lang || "");

  function handleConfirm() {
    onConfirm({
      ...book,
      title: bookTitle.trim() || "Bez tytułu",
      author: author.trim(),
      lang,
    });
  }

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">{title}</div>
          <button className="modal-close" onClick={onCancel}>✕</button>
        </div>

        <div className="modal-body">
          <div className="form-group">
            <label className="form-label">Tytuł</label>
            <input
              type="text"
              className="form-input"
              value={bookTitle}
              onChange={(e) => setBookTitle(e.target.value)}
              placeholder="Tytuł książki"
              autoFocus
            />
          </div>

          <div className="form-group">
            <label className="form-label">Autor</label>
            <input
              type="text"
              className="form-input"
              value={author}
              onChange={(e) => setAuthor(e.target.value)}
              placeholder="Autor"
            />
          </div>

          <div className="form-group">
            <label className="form-label">Język książki</label>
            <select
              className="form-select"
              value={lang}
              onChange={(e) => setLang(e.target.value)}
            >
              {BOOK_SOURCE_LANGUAGES.map((language) => (
                <option key={language.code} value={language.code}>
                  {language.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="modal-foot">
          <button className="btn-ghost" onClick={onCancel}>Anuluj</button>
          <button className="btn-primary" onClick={handleConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}
