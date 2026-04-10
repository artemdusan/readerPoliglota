import { useState, useEffect } from 'react';
import { isLoggedIn, onAuthChange, login, register, logout } from '../sync/cfAuth';
import { syncAll } from '../sync/cfSync';

const SYNC_INTERVAL_OPTIONS = [
  { value: 5, label: 'Co 5 minut' },
  { value: 15, label: 'Co 15 minut' },
  { value: 30, label: 'Co 30 minut' },
  { value: 60, label: 'Co 1 godzinę' },
  { value: 180, label: 'Co 3 godziny' },
  { value: 360, label: 'Co 6 godzin' },
  { value: 720, label: 'Co 12 godzin' },
];

export default function Settings({ settings, onUpdateSetting, onClose }) {
  const [cfConnected, setCfConnected] = useState(isLoggedIn());
  const [authMode, setAuthMode] = useState('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [authError, setAuthError] = useState('');
  const [authWorking, setAuthWorking] = useState(false);
  const [syncStatus, setSyncStatus] = useState(null);
  const [syncProgress, setSyncProgress] = useState(null);
  const [lastSync, setLastSync] = useState(() => {
    const value = localStorage.getItem('vocabapp:lastSync');
    return value ? Number(value) : null;
  });

  useEffect(() => onAuthChange(setCfConnected), []);

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
    if (!ts) return 'Jeszcze nie synchronizowano';
    return new Date(ts).toLocaleString('pl-PL', {
      dateStyle: 'short',
      timeStyle: 'short',
    });
  }

  function handleOverlayClick(e) {
    if (e.target === e.currentTarget) onClose();
  }

  return (
    <div className="modal-overlay" onClick={handleOverlayClick}>
      <div className="modal" role="dialog" aria-modal="true">
        <div className="modal-head">
          <div className="modal-title">Konto</div>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        <div className="modal-body">
          <div className="form-group">
            <label className="form-label">Konto</label>

            {cfConnected ? (
              <>
                <div className="settings-account-row">
                  <span className="settings-account-badge">● Połączono</span>
                  <button className="btn-ghost" onClick={logout}>Wyloguj</button>
                  <button
                    className="btn-ghost"
                    onClick={handleManualSync}
                    disabled={syncStatus === 'syncing'}
                  >
                    {syncStatus === 'syncing' ? 'Synchronizuję...' : 'Synchronizuj teraz'}
                  </button>
                </div>

                <p className="settings-inline-note">
                  Ostatni sync: {formatLastSync(lastSync)}
                </p>

                {syncStatus === 'syncing' && syncProgress && (
                  <div className="settings-sync-progress">
                    <div className="settings-sync-progress-track">
                      <div
                        className="settings-sync-progress-fill"
                        style={{
                          width: syncProgress.total > 0
                            ? `${(syncProgress.done / syncProgress.total) * 100}%`
                            : '0%',
                        }}
                      />
                    </div>
                    <p className="settings-inline-note">
                      {syncProgress.done} / {syncProgress.total}
                    </p>
                  </div>
                )}

                {syncStatus && syncStatus !== 'syncing' && (
                  <p className={`settings-inline-note ${syncStatus.error ? 'is-error' : ''}`}>
                    {syncStatus.error
                      ? `Błąd: ${syncStatus.error}`
                      : `Zsynchronizowano ${syncStatus.synced} elementów · ↑ ${syncStatus.sentMB} MB · ↓ ${syncStatus.receivedMB} MB`}
                  </p>
                )}
              </>
            ) : (
              <form onSubmit={handleAuth} className="settings-auth-form">
                <div className="settings-auth-switch">
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
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoComplete="email"
                />

                <input
                  type="password"
                  className="form-input"
                  placeholder="Hasło (min. 8 znaków)"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={8}
                  autoComplete={authMode === 'login' ? 'current-password' : 'new-password'}
                />

                {authError && <p className="settings-inline-note is-error">{authError}</p>}

                <button
                  type="submit"
                  className="btn-primary"
                  disabled={authWorking}
                  style={{ alignSelf: 'flex-start' }}
                >
                  {authWorking
                    ? (authMode === 'login' ? 'Logowanie...' : 'Rejestracja...')
                    : (authMode === 'login' ? 'Zaloguj' : 'Zarejestruj')}
                </button>
              </form>
            )}
          </div>

          <div className="form-group">
            <label className="form-label">Synchronizacja w tle</label>
            <select
              className="form-select"
              value={settings.syncIntervalMinutes ?? 30}
              onChange={(e) => onUpdateSetting('syncIntervalMinutes', Number(e.target.value))}
            >
              {SYNC_INTERVAL_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
            <div className="form-hint">
              Aplikacja będzie próbowała odświeżać dane w tle w wybranym odstępie czasu, gdy jesteś online i konto jest połączone.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
