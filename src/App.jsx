import { useState, useCallback, useEffect } from 'react';
import { useSettings } from './hooks/useSettings';
import Library from './components/Library';
import Reader  from './components/Reader';
import Settings from './components/Settings';
import { initCfAuth, isLoggedIn, onAuthChange } from './sync/cfAuth';
import { syncAll } from './sync/cfSync';

let startupSyncPromise = null;
let lastStartupSyncAttemptAt = 0;

function shouldRunStartupSync(intervalMinutes) {
  const minutes = Number(intervalMinutes ?? 30);
  if (!minutes || minutes < 1 || !navigator.onLine || !isLoggedIn()) return false;

  const lastSyncRaw = localStorage.getItem('vocabapp:lastSync');
  const lastSync = lastSyncRaw ? Number(lastSyncRaw) : null;
  if (!lastSync || Number.isNaN(lastSync)) return true;

  return Date.now() - lastSync >= minutes * 60 * 1000;
}

function scheduleStartupSync(intervalMinutes) {
  if (!shouldRunStartupSync(intervalMinutes)) return;

  const now = Date.now();
  if (startupSyncPromise || now - lastStartupSyncAttemptAt < 10_000) return;

  lastStartupSyncAttemptAt = now;
  startupSyncPromise = syncAll()
    .catch(() => {})
    .finally(() => {
      startupSyncPromise = null;
    });
}

export default function App() {
  const { settings, updateSetting, updateLanguage, loaded } = useSettings();
  const [view, setView] = useState('library');          // 'library' | 'reader'
  const [currentBookId, setCurrentBookId] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [cfConnected, setCfConnected] = useState(() => isLoggedIn());

  useEffect(() => onAuthChange(setCfConnected), []);

  // Load CF JWT from Dexie into memory on startup
  useEffect(() => { initCfAuth(); }, []);

  useEffect(() => {
    if (!loaded || !cfConnected) return;
    scheduleStartupSync(settings.syncIntervalMinutes);
  }, [cfConnected, loaded, settings.syncIntervalMinutes]);

  useEffect(() => {
    const intervalMinutes = Number(settings.syncIntervalMinutes ?? 30);
    if (!intervalMinutes || intervalMinutes < 1) return undefined;

    const timer = window.setInterval(() => {
      if (!navigator.onLine || !isLoggedIn()) return;
      syncAll().catch(() => {});
    }, intervalMinutes * 60 * 1000);

    return () => window.clearInterval(timer);
  }, [settings.syncIntervalMinutes]);

  const openBook = useCallback((bookId) => {
    setCurrentBookId(bookId);
    setView('reader');
  }, []);

  const goToLibrary = useCallback(() => {
    setView('library');
    setCurrentBookId(null);
  }, []);

  if (!loaded) {
    return (
      <div className="loading-screen">
        <div className="spin-ring" />
        <div className="loading-msg">Ładowanie…</div>
      </div>
    );
  }

  return (
    <>
      {view === 'library' && (
        <Library
          onOpenBook={openBook}
          onOpenSettings={() => setShowSettings(true)}
          settings={settings}
        />
      )}
      {view === 'reader' && (
        <Reader
          bookId={currentBookId}
          settings={settings}
          onUpdateSetting={updateSetting}
          onBack={goToLibrary}
          onOpenSettings={() => setShowSettings(true)}
        />
      )}
      {showSettings && (
        <Settings
          settings={settings}
          onUpdateSetting={updateSetting}
          onUpdateLanguage={updateLanguage}
          onClose={() => setShowSettings(false)}
        />
      )}
    </>
  );
}
