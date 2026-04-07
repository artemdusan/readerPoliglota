import { useState, useEffect } from 'react';
import { LANGUAGES, PROVIDERS } from '../hooks/useSettings';
import { isLoggedIn, onAuthChange, login, register, logout } from '../sync/cfAuth';
import { syncAll } from '../sync/cfSync';

const deepseekProvider = PROVIDERS.find(p => p.id === 'deepseek') ?? PROVIDERS[0];

export default function Settings({ settings, onUpdateSetting, onUpdateLanguage, onClose }) {
  const [cfConnected, setCfConnected]   = useState(isLoggedIn());
  const [authMode, setAuthMode]         = useState('login'); // 'login' | 'register'
  const [email, setEmail]               = useState('');
  const [password, setPassword]         = useState('');
  const [authError, setAuthError]       = useState('');
  const [authWorking, setAuthWorking]   = useState(false);
  const [syncStatus, setSyncStatus]     = useState(null); // null | 'syncing' | { synced, error }
  const [syncProgress, setSyncProgress] = useState(null); // null | { done, total }
  const [lastSync, setLastSync]         = useState(() => {
    const v = localStorage.getItem('vocabapp:lastSync');
    return v ? Number(v) : null;
  });

  useEffect(() => {
    return onAuthChange(setCfConnected);
  }, []);

  async function handleAuth(e) {
    e.preventDefault();
    setAuthWorking(true);
    setAuthError('');
    try {
      if (authMode === 'login') await login(email, password);
      else await register(email, password);
      setEmail('');
      setPassword('');
    } catch (err) {
      setAuthError(err.message);
    } finally {
      setAuthWorking(false);
    }
  }

  async function handleManualSync() {
    setSyncStatus('syncing');
    setSyncProgress(null);
    const result = await syncAll((done, total) => setSyncProgress({ done, total }));
    setSyncStatus(result);
    setSyncProgress(null);
    if (result.lastSync) setLastSync(result.lastSync);
    setTimeout(() => setSyncStatus(null), 8000);
  }

  function formatLastSync(ts) {
    if (!ts) return null;
    const d = new Date(ts);
    return d.toLocaleString('pl-PL', { dateStyle: 'short', timeStyle: 'short' });
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

          {/* Sync / Auth */}
          <div className="form-group">
            <label className="form-label">Synchronizacja (Cloudflare)</label>

            {cfConnected ? (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 13, color: 'var(--gold)' }}>● Zalogowano</span>
                  <button className="btn-ghost" onClick={logout}>Wyloguj</button>
                  <button
                    className="btn-ghost"
                    onClick={handleManualSync}
                    disabled={syncStatus === 'syncing'}
                  >
                    {syncStatus === 'syncing' ? '⟳ Synchronizuję…' : '↻ Synchronizuj teraz'}
                  </button>
                </div>
                {syncStatus === 'syncing' && syncProgress && (
                  <div style={{ marginTop: 8 }}>
                    <div style={{ height: 4, borderRadius: 2, background: 'var(--bg-2, #333)', overflow: 'hidden' }}>
                      <div style={{
                        height: '100%', borderRadius: 2, background: 'var(--gold)',
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
                      : `✓ Zsynchronizowano ${syncStatus.synced} ${syncStatus.synced === 1 ? 'plik' : 'pliki/plików'} · ↑ ${syncStatus.sentMB} MB · ↓ ${syncStatus.receivedMB} MB`
                    }
                  </p>
                )}
                {lastSync && (
                  <p style={{ fontSize: 11, color: 'var(--txt-2)', marginTop: 4 }}>
                    Ostatni sync: {formatLastSync(lastSync)}
                  </p>
                )}
              </>
            ) : (
              <form onSubmit={handleAuth} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', gap: 8, marginBottom: 2 }}>
                  <button
                    type="button"
                    className={`ctl ${authMode === 'login' ? 'ctl-active' : ''}`}
                    onClick={() => { setAuthMode('login'); setAuthError(''); }}
                  >
                    Zaloguj
                  </button>
                  <button
                    type="button"
                    className={`ctl ${authMode === 'register' ? 'ctl-active' : ''}`}
                    onClick={() => { setAuthMode('register'); setAuthError(''); }}
                  >
                    Zarejestruj
                  </button>
                </div>
                <input
                  type="email"
                  className="form-input"
                  placeholder="Email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  required
                  autoComplete="email"
                />
                <input
                  type="password"
                  className="form-input"
                  placeholder="Hasło (min. 8 znaków)"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  required
                  minLength={8}
                  autoComplete={authMode === 'login' ? 'current-password' : 'new-password'}
                />
                {authError && (
                  <p style={{ fontSize: 12, color: 'var(--err, #e55)', margin: 0 }}>{authError}</p>
                )}
                <button
                  type="submit"
                  className="btn-primary"
                  disabled={authWorking}
                  style={{ alignSelf: 'flex-start' }}
                >
                  {authWorking
                    ? (authMode === 'login' ? 'Logowanie…' : 'Rejestracja…')
                    : (authMode === 'login' ? 'Zaloguj' : 'Zarejestruj')
                  }
                </button>
              </form>
            )}
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
            <label className="form-label">Model (DeepSeek)</label>
            <select
              className="form-select"
              value={settings.polyglotModel}
              onChange={e => onUpdateSetting('polyglotModel', e.target.value)}
            >
              {deepseekProvider.models.map(m => (
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
