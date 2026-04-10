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
      <div className="import-dialog" onClick={(e) => e.stopPropagation()}>
        <h2 className="import-dialog-title">{title}</h2>

        <div className="import-dialog-body is-metadata-only">
          <div className="import-fields">
            <label className="import-field">
              <span>Tytuł</span>
              <input
                type="text"
                value={bookTitle}
                onChange={(e) => setBookTitle(e.target.value)}
                placeholder="Tytuł książki"
                autoFocus
              />
            </label>

            <label className="import-field">
              <span>Autor</span>
              <input
                type="text"
                value={author}
                onChange={(e) => setAuthor(e.target.value)}
                placeholder="Autor"
              />
            </label>

            <label className="import-field">
              <span>Język książki</span>
              <select value={lang} onChange={(e) => setLang(e.target.value)}>
                {BOOK_SOURCE_LANGUAGES.map((language) => (
                  <option key={language.code} value={language.code}>
                    {language.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>

        <div className="import-dialog-footer">
          <button className="btn-ghost" onClick={onCancel}>
            Anuluj
          </button>
          <button className="btn-primary" onClick={handleConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
