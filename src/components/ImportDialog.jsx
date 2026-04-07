import { useState, useRef } from 'react';

const SOURCE_LANGUAGES = [
  { code: '',   label: 'Nieznany' },
  { code: 'pl', label: 'Polski' },
  { code: 'en', label: 'English' },
  { code: 'de', label: 'Deutsch' },
  { code: 'fr', label: 'Français' },
  { code: 'es', label: 'Español' },
  { code: 'it', label: 'Italiano' },
  { code: 'pt', label: 'Português' },
  { code: 'ru', label: 'Русский' },
  { code: 'cs', label: 'Čeština' },
  { code: 'uk', label: 'Українська' },
];

export default function ImportDialog({ parsed, onConfirm, onCancel }) {
  const [title,  setTitle]  = useState(parsed.title  || '');
  const [author, setAuthor] = useState(parsed.author || '');
  const [lang,   setLang]   = useState(parsed.lang   || '');
  const [cover,  setCover]  = useState(parsed.cover  || null);
  const coverInputRef = useRef(null);

  function handleCoverFile(file) {
    if (!file || !file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = e => setCover(e.target.result);
    reader.readAsDataURL(file);
  }

  function handleConfirm() {
    onConfirm({ ...parsed, title: title.trim() || 'Bez tytułu', author: author.trim(), lang, cover });
  }

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="import-dialog" onClick={e => e.stopPropagation()}>
        <h2 className="import-dialog-title">Dodaj książkę</h2>

        <div className="import-dialog-body">
          {/* Cover */}
          <div
            className="import-cover"
            onClick={() => coverInputRef.current?.click()}
            title="Kliknij, aby zmienić okładkę"
          >
            {cover
              ? <img src={cover} alt="okładka" />
              : <span className="cover-ph cover-ph-lg">📖</span>
            }
            <div className="import-cover-hint">zmień</div>
          </div>
          <input
            ref={coverInputRef}
            type="file"
            accept="image/*"
            hidden
            onChange={e => { handleCoverFile(e.target.files[0]); e.target.value = ''; }}
          />

          {/* Fields */}
          <div className="import-fields">
            <label className="import-field">
              <span>Tytuł</span>
              <input
                type="text"
                value={title}
                onChange={e => setTitle(e.target.value)}
                placeholder="Tytuł książki"
                autoFocus
              />
            </label>
            <label className="import-field">
              <span>Autor</span>
              <input
                type="text"
                value={author}
                onChange={e => setAuthor(e.target.value)}
                placeholder="Autor"
              />
            </label>
            <label className="import-field">
              <span>Język książki</span>
              <select value={lang} onChange={e => setLang(e.target.value)}>
                {SOURCE_LANGUAGES.map(l => (
                  <option key={l.code} value={l.code}>{l.label}</option>
                ))}
              </select>
            </label>
          </div>
        </div>

        <div className="import-dialog-footer">
          <button className="btn-ghost" onClick={onCancel}>Anuluj</button>
          <button className="btn-primary" onClick={handleConfirm}>
            Dodaj książkę
          </button>
        </div>
      </div>
    </div>
  );
}
