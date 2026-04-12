import { useEffect, useState } from "react";
import {
  getUsername,
  isLoggedIn,
  login,
  logout,
  onAuthChange,
  register,
} from "../sync/cfAuth";
import { syncAll } from "../sync/cfSync";
import { getSyncActivity, subscribeSyncActivity } from "../sync/syncActivity";

const SYNC_INTERVAL_OPTIONS = [
  { value: 5, label: "Co 5 minut" },
  { value: 15, label: "Co 15 minut" },
  { value: 30, label: "Co 30 minut" },
  { value: 60, label: "Co 1 godzinę" },
  { value: 180, label: "Co 3 godziny" },
  { value: 360, label: "Co 6 godzin" },
  { value: 720, label: "Co 12 godzin" },
];

function formatTransfer(bytes, fallbackMB = 0) {
  if (typeof bytes === "number" && Number.isFinite(bytes)) {
    if (bytes < 1_048_576) {
      return `${Math.max(0.01, bytes / 1024).toFixed(2)} KB`;
    }
    return `${(bytes / 1_048_576).toFixed(2)} MB`;
  }
  return `${fallbackMB} MB`;
}

function formatLastSync(ts) {
  if (!ts) return "Jeszcze nie synchronizowano";
  return new Date(ts).toLocaleString("pl-PL", {
    dateStyle: "short",
    timeStyle: "short",
  });
}

export default function Settings({ settings, onUpdateSetting, onClose }) {
  const [cfConnected, setCfConnected] = useState(() => isLoggedIn());
  const [accountName, setAccountName] = useState(() => getUsername());
  const [authMode, setAuthMode] = useState("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [authWorking, setAuthWorking] = useState(false);
  const [syncActivity, setSyncActivity] = useState(() => getSyncActivity());
  const [lastSync, setLastSync] = useState(() => {
    const value = localStorage.getItem("vocabapp:lastSync");
    return value ? Number(value) : null;
  });

  useEffect(
    () =>
      onAuthChange((loggedIn, nextUsername) => {
        setCfConnected(loggedIn);
        setAccountName(nextUsername);
      }),
    [],
  );

  useEffect(() => subscribeSyncActivity(setSyncActivity), []);

  useEffect(() => {
    function handleSynced() {
      const value = localStorage.getItem("vocabapp:lastSync");
      setLastSync(value ? Number(value) : Date.now());
    }

    window.addEventListener("vocabapp:synced", handleSynced);
    return () => window.removeEventListener("vocabapp:synced", handleSynced);
  }, []);

  async function handleAuth(event) {
    event.preventDefault();
    setAuthWorking(true);
    setAuthError("");

    try {
      if (authMode === "login") await login(username, password);
      else await register(username, password);
      setUsername("");
      setPassword("");
    } catch (error) {
      setAuthError(error.message);
    } finally {
      setAuthWorking(false);
    }
  }

  async function handleManualSync() {
    const result = await syncAll();
    if (result.lastSync) setLastSync(result.lastSync);
  }

  function handleOverlayClick(event) {
    if (event.target === event.currentTarget) onClose();
  }

  const syncProgress = syncActivity.progress;
  const syncResult = syncActivity.result;
  const isSyncing = syncActivity.phase === "syncing";

  return (
    <div className="modal-overlay" onClick={handleOverlayClick}>
      <div className="modal" role="dialog" aria-modal="true">
        <div className="modal-head">
          <div className="modal-title">Konto i synchronizacja</div>
          <button className="modal-close" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="modal-body">
          <div className="form-group">
            <label className="form-label">Konto</label>

            {cfConnected ? (
              <>
                <div className="settings-account-row">
                  {accountName && (
                    <span className="settings-account-name">{accountName}</span>
                  )}
                  <span className="settings-account-badge">• Zalogowany</span>
                  <button className="btn-ghost" onClick={logout}>
                    Wyloguj
                  </button>
                  <button
                    className="btn-ghost"
                    onClick={handleManualSync}
                    disabled={isSyncing}
                  >
                    {isSyncing ? "Synchronizowanie..." : "Synchronizuj teraz"}
                  </button>
                </div>

                {accountName && (
                  <p className="settings-inline-note">
                    Aktywne konto: <strong>{accountName}</strong>
                  </p>
                )}

                <p className="settings-inline-note">
                  Ostatni sync: {formatLastSync(lastSync)}
                </p>

                {isSyncing && syncProgress && (
                  <div className="settings-sync-progress">
                    <div className="settings-sync-progress-track">
                      <div
                        className="settings-sync-progress-fill"
                        style={{
                          width:
                            syncProgress.total > 0
                              ? `${(syncProgress.done / syncProgress.total) * 100}%`
                              : "0%",
                        }}
                      />
                    </div>
                    <p className="settings-inline-note">
                      {syncProgress.done} / {syncProgress.total}
                    </p>
                  </div>
                )}

                {syncResult && !isSyncing && (
                  <p
                    className={`settings-inline-note ${syncResult.error ? "is-error" : ""}`}
                  >
                    {syncResult.error
                      ? `Błąd synchronizacji: ${syncResult.error}`
                      : `Zsynchronizowano ${syncResult.synced} elementów · ↑ ${formatTransfer(syncResult.sentBytes, syncResult.sentMB)} · ↓ ${formatTransfer(syncResult.receivedBytes, syncResult.receivedMB)}`}
                  </p>
                )}
              </>
            ) : (
              <form onSubmit={handleAuth} className="settings-auth-form">
                <div className="settings-auth-switch">
                  <button
                    type="button"
                    className={`ctl ${authMode === "login" ? "ctl-active" : ""}`}
                    onClick={() => {
                      setAuthMode("login");
                      setAuthError("");
                    }}
                  >
                    Zaloguj
                  </button>
                  <button
                    type="button"
                    className={`ctl ${authMode === "register" ? "ctl-active" : ""}`}
                    onClick={() => {
                      setAuthMode("register");
                      setAuthError("");
                    }}
                  >
                    Zarejestruj
                  </button>
                </div>

                <input
                  type="text"
                  className="form-input"
                  placeholder="Nazwa użytkownika"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  required
                  autoComplete="username"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                />

                <input
                  type="password"
                  className="form-input"
                  placeholder="Hasło (min. 8 znaków)"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                  minLength={8}
                  autoComplete={
                    authMode === "login" ? "current-password" : "new-password"
                  }
                />

                {authError && (
                  <p className="settings-inline-note is-error">{authError}</p>
                )}

                <button
                  type="submit"
                  className="btn-primary"
                  disabled={authWorking}
                  style={{ alignSelf: "flex-start" }}
                >
                  {authWorking
                    ? authMode === "login"
                      ? "Logowanie..."
                      : "Rejestracja..."
                    : authMode === "login"
                      ? "Zaloguj"
                      : "Zarejestruj"}
                </button>
              </form>
            )}
          </div>

          <div className="form-group">
            <label className="form-label">Synchronizacja w tle</label>
            <select
              className="form-select"
              value={settings.syncIntervalMinutes ?? 30}
              onChange={(event) =>
                onUpdateSetting("syncIntervalMinutes", Number(event.target.value))
              }
            >
              {SYNC_INTERVAL_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <div className="form-hint">
              Aplikacja będzie próbowała odświeżać dane w tle, gdy jesteś online
              i konto jest połączone.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
