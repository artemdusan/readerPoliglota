import { useState, useCallback, useEffect } from 'react';
import { useSettings } from './hooks/useSettings';
import Library from './components/Library';
import Reader  from './components/Reader';
import Settings from './components/Settings';
import { initGoogleAuth } from './sync/googleAuth';

export default function App() {
  const { settings, updateSetting, updateLanguage, loaded } = useSettings();
  const [view, setView] = useState('library');          // 'library' | 'reader'
  const [currentBookId, setCurrentBookId] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  // Init Google Auth once settings are loaded
  useEffect(() => {
    if (!loaded) return;
    const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID;
    if (!clientId) return;
    initGoogleAuth(clientId);
  }, [loaded]);

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
