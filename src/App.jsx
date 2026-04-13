import { useState, useCallback, useEffect, useRef } from 'react';
import { useSettings } from './hooks/useSettings';
import Library from './components/Library';
import Reader  from './components/Reader';
import Settings from './components/Settings';
import { initCfAuth, isLoggedIn, onAuthChange } from './sync/cfAuth';
import { syncAll } from './sync/cfSync';
import { getSyncActivity } from './sync/syncActivity';

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
  if (getSyncActivity().phase === 'syncing') return;

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
      if (getSyncActivity().phase === 'syncing') return;
      syncAll().catch(() => {});
    }, intervalMinutes * 60 * 1000);

    return () => window.clearInterval(timer);
  }, [settings.syncIntervalMinutes]);

  // Track view in ref so event listeners always see fresh value
  const viewRef = useRef(view);
  useEffect(() => { viewRef.current = view; }, [view]);

  // Push a history entry when entering reader so Android back button works
  useEffect(() => {
    if (view === 'reader') {
      history.pushState({ appView: 'reader' }, '');
    }
  }, [view]);

  // Handle Android hardware back button (popstate)
  useEffect(() => {
    function onPopstate() {
      if (viewRef.current === 'reader') {
        setView('library');
        setCurrentBookId(null);
      }
    }
    window.addEventListener('popstate', onPopstate);
    return () => window.removeEventListener('popstate', onPopstate);
  }, []);

  const openBook = useCallback((bookId) => {
    setCurrentBookId(bookId);
    setView('reader');
  }, []);

  const goToLibrary = useCallback(() => {
    // Pop the history entry we pushed when entering reader
    if (history.state?.appView === 'reader') {
      history.back(); // fires popstate which updates state; also update directly below for safety
    }
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
          onUpdateSetting={updateSetting}
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
