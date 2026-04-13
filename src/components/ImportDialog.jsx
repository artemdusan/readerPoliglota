import { useState, useRef } from "react";
import { BOOK_SOURCE_LANGUAGES } from "../constants/bookLanguages";

export default function ImportDialog({ parsed, onConfirm, onCancel }) {
  const [title, setTitle] = useState(parsed.title || "");
  const [author, setAuthor] = useState(parsed.author || "");
  const [lang, setLang] = useState(parsed.lang || "");
  const [cover, setCover] = useState(parsed.cover || null);
  const coverInputRef = useRef(null);

  function handleCoverFile(file) {
    if (!file || !file.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = (e) => setCover(e.target.result);
    reader.readAsDataURL(file);
  }

  function handleConfirm() {
    onConfirm({
      ...parsed,
      title: title.trim() || "Bez tytułu",
      author: author.trim(),
      lang,
      cover,
    });
  }

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">Dodaj książkę</div>
          <button className="modal-close" onClick={onCancel}>✕</button>
        </div>

        <div className="modal-body">
          <div className="import-cover-row">
            <div
              className="import-cover"
              onClick={() => coverInputRef.current?.click()}
              title="Kliknij, aby zmienić okładkę"
            >
              {cover ? (
                <img src={cover} alt="okładka" />
              ) : (
                <span className="cover-ph cover-ph-lg">📖</span>
              )}
              <div className="import-cover-hint">zmień</div>
            </div>

            <input
              ref={coverInputRef}
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => {
                handleCoverFile(e.target.files[0]);
                e.target.value = "";
              }}
            />

            <div className="form-fields">
              <div className="form-group">
                <label className="form-label">Tytuł</label>
                <input
                  type="text"
                  className="form-input"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
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
          </div>
        </div>

        <div className="modal-foot">
          <button className="btn-ghost" onClick={onCancel}>Anuluj</button>
          <button className="btn-primary" onClick={handleConfirm}>Dodaj książkę</button>
        </div>
      </div>
    </div>
  );
}
