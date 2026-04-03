import { useState, useEffect } from 'react';
import { LANGUAGES, PROVIDERS } from '../hooks/useSettings';

export default function Settings({ settings, onUpdateSetting, onUpdateLanguage, onClose }) {
  const [apiKey, setApiKey]   = useState(settings.apiKey || '');
  const [showKey, setShowKey] = useState(false);
  const [saved, setSaved]     = useState(false);

  const currentProvider = PROVIDERS.find(p => p.id === settings.provider) ?? PROVIDERS[0];

  // Sync if settings change externally
  useEffect(() => {
    setApiKey(settings.apiKey || '');
  }, [settings.apiKey]);

  async function handleProviderChange(providerId) {
    const p = PROVIDERS.find(pr => pr.id === providerId);
    if (!p) return;
    await onUpdateSetting('provider', p.id);
    await onUpdateSetting('polyglotModel', p.defaultModel);
  }

  async function handleSaveApiKey() {
    await onUpdateSetting('apiKey', apiKey.trim());
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  function handleOverlayClick(e) {
    if (e.target === e.currentTarget) onClose();
  }

  return (
    <div className="modal-overlay" onClick={handleOverlayClick}>
      <div className="modal" role="dialog" aria-modal="true">
        <div className="modal-head">
          <div className="modal-title">Ustawienia</div>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        <div className="modal-body">

          {/* Provider */}
          <div className="form-group">
            <label className="form-label">Dostawca API</label>
            <select
              className="form-select"
              value={settings.provider ?? 'deepseek'}
              onChange={e => handleProviderChange(e.target.value)}
            >
              {PROVIDERS.map(p => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
            </select>
          </div>

          {/* API Key */}
          <div className="form-group">
            <label className="form-label">Klucz API — {currentProvider.label}</label>
            <p className="form-hint">
              Klucz jest przechowywany wyłącznie lokalnie w IndexedDB Twojej przeglądarki.
              Wymagany do trybu poligloty.
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                type={showKey ? 'text' : 'password'}
                className={`form-input ${apiKey ? 'has-value' : ''}`}
                value={apiKey}
                onChange={e => setApiKey(e.target.value)}
                placeholder={currentProvider.keyPlaceholder}
                spellCheck={false}
                style={{ flex: 1 }}
              />
              <button
                className="ctl"
                onClick={() => setShowKey(s => !s)}
                title={showKey ? 'Ukryj' : 'Pokaż'}
                style={{ flexShrink: 0 }}
              >
                {showKey ? '🙈' : '👁'}
              </button>
            </div>
            <button
              className={`btn-ghost ${saved ? 'ctl-ok' : ''}`}
              onClick={handleSaveApiKey}
              style={{ alignSelf: 'flex-start', marginTop: 4 }}
            >
              {saved ? '✓ Zapisano' : 'Zapisz klucz'}
            </button>
          </div>

          {/* Target language */}
          <div className="form-group">
            <label className="form-label">Język nauki (tryb poligloty)</label>
            <select
              className="form-select"
              value={settings.targetLang}
              onChange={e => onUpdateLanguage(e.target.value)}
            >
              {LANGUAGES.map(lang => (
                <option key={lang.code} value={lang.code}>
                  {lang.flag} {lang.label} ({lang.name})
                </option>
              ))}
            </select>
          </div>

          {/* Model */}
          <div className="form-group">
            <label className="form-label">Model</label>
            <select
              className="form-select"
              value={settings.polyglotModel}
              onChange={e => onUpdateSetting('polyglotModel', e.target.value)}
            >
              {currentProvider.models.map(m => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </select>
          </div>

          {/* Font size */}
          <div className="form-group">
            <label className="form-label">Domyślna wielkość czcionki</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <input
                type="range"
                min={13}
                max={30}
                value={settings.fontSize}
                onChange={e => onUpdateSetting('fontSize', Number(e.target.value))}
                style={{ flex: 1, accentColor: 'var(--gold)' }}
              />
              <span style={{ fontSize: 13, color: 'var(--txt-2)', minWidth: 32 }}>
                {settings.fontSize}px
              </span>
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}
