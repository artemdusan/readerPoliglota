import { useState, useEffect } from 'react';
import { LANGUAGES, PROVIDERS } from '../hooks/useSettings';
import { isSignedIn, onAuthChange, signIn, signOut } from '../sync/googleAuth';
import { syncAll } from '../sync/syncManager';

export default function Settings({ settings, onUpdateSetting, onUpdateLanguage, onClose }) {
  const [apiKey, setApiKey]         = useState(settings.apiKey || '');
  const [showKey, setShowKey]       = useState(false);
  const [saved, setSaved]           = useState(false);
  const [driveConnected, setDriveConnected] = useState(isSignedIn());
  const [syncStatus, setSyncStatus] = useState(null); // null | 'syncing' | { synced, error }
  const [syncProgress, setSyncProgress] = useState(null); // null | { done, total }
  const driveEnabled = !!import.meta.env.VITE_GOOGLE_CLIENT_ID;

  useEffect(() => {
    return onAuthChange(setDriveConnected);
  }, []);

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

  async function handleManualSync() {
    setSyncStatus('syncing');
    setSyncProgress(null);
    const result = await syncAll((done, total) => setSyncProgress({ done, total }));
    setSyncStatus(result);
    setSyncProgress(null);
    setTimeout(() => setSyncStatus(null), 5000);
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

          {/* Google Drive Sync */}
          {driveEnabled && (
            <div className="form-group">
              <label className="form-label">Synchronizacja Google Drive</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 13, color: driveConnected ? 'var(--gold)' : 'var(--txt-2)' }}>
                  {driveConnected ? '● Połączono z Drive' : '○ Niepołączono'}
                </span>
                {driveConnected
                  ? <button className="btn-ghost" onClick={signOut}>Rozłącz</button>
                  : <button className="btn-ghost" onClick={signIn}>Połącz z Google Drive</button>
                }
                {driveConnected && (
                  <button
                    className="btn-ghost"
                    onClick={handleManualSync}
                    disabled={syncStatus === 'syncing'}
                  >
                    {syncStatus === 'syncing' ? '⟳ Synchronizuję…' : '↻ Synchronizuj teraz'}
                  </button>
                )}
              </div>
              {syncStatus === 'syncing' && syncProgress && (
                <div style={{ marginTop: 8 }}>
                  <div style={{ height: 4, borderRadius: 2, background: 'var(--bg-2, #333)', overflow: 'hidden' }}>
                    <div style={{
                      height: '100%',
                      borderRadius: 2,
                      background: 'var(--gold)',
                      width: syncProgress.total > 0 ? `${(syncProgress.done / syncProgress.total) * 100}%` : '0%',
                      transition: 'width 0.2s ease',
                    }} />
                  </div>
                  <p style={{ fontSize: 11, color: 'var(--txt-2)', marginTop: 4 }}>
                    {syncProgress.done} / {syncProgress.total}
                  </p>
                </div>
              )}
              {syncStatus && syncStatus !== 'syncing' && (
                <p style={{ fontSize: 12, marginTop: 6, color: syncStatus.error ? 'var(--err, #e55)' : 'var(--txt-2)' }}>
                  {syncStatus.error
                    ? `Błąd: ${syncStatus.error}`
                    : `✓ Zsynchronizowano ${syncStatus.synced} ${syncStatus.synced === 1 ? 'plik' : 'pliki/plików'}`
                  }
                </p>
              )}
            </div>
          )}

        </div>
      </div>
    </div>
  );
}
