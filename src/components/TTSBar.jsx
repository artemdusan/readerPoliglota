import { useState, useEffect } from 'react';

const RATES = [0.75, 1, 1.25, 1.5, 2];
const RATE_LABELS = { 0.75: '¾×', 1: '1×', 1.25: '1¼×', 1.5: '1½×', 2: '2×' };

export default function TTSBar({
  isPlaying, toggle, onStop, rate, setRate, progress,
  voiceName, onVoiceChange,
  foreignLang, foreignVoiceName, onForeignVoiceChange,
}) {
  const [plVoices, setPlVoices]           = useState([]);
  const [foreignVoices, setForeignVoices] = useState([]);
  const [showModal, setShowModal]         = useState(false);

  const pct = progress.total > 0 ? (progress.idx / progress.total) * 100 : 0;

  useEffect(() => {
    function load() {
      const all = window.speechSynthesis.getVoices();
      setPlVoices(all.filter(v => v.lang.startsWith('pl')));
      if (foreignLang) {
        const exact = all.filter(v => v.lang === foreignLang);
        setForeignVoices(
          exact.length > 0 ? exact : all.filter(v => v.lang.startsWith(foreignLang.split('-')[0]))
        );
      }
    }
    load();
    window.speechSynthesis.addEventListener('voiceschanged', load);
    return () => window.speechSynthesis.removeEventListener('voiceschanged', load);
  }, [foreignLang]);

  const hasVoiceOptions = plVoices.length > 1 || foreignVoices.length > 0;

  return (
    <>
      <div className="tts-bar">
        <button className="tts-btn" onClick={toggle} title={isPlaying ? 'Pauza' : 'Odtwarzaj'}>
          {isPlaying ? '⏸' : '▶'}
        </button>
        <button className="tts-btn" onClick={onStop} title="Stop i zamknij">⏹</button>

        <div className="tts-track">
          <div className="tts-fill" style={{ width: `${pct}%` }} />
        </div>

        <div className="tts-rates">
          {RATES.map(r => (
            <button
              key={r}
              className={`tts-rate-btn ${rate === r ? 'active' : ''}`}
              onClick={() => setRate(r)}
            >
              {RATE_LABELS[r]}
            </button>
          ))}
        </div>

        {hasVoiceOptions && (
          <button
            className={`tts-btn ${showModal ? 'active' : ''}`}
            onClick={() => setShowModal(s => !s)}
            title="Ustawienia głosu TTS"
          >🎙</button>
        )}
      </div>

      {showModal && (
        <div className="tts-modal-overlay" onClick={() => setShowModal(false)}>
          <div className="tts-modal" onClick={e => e.stopPropagation()}>
            <div className="tts-modal-head">
              <span>Głos TTS</span>
              <button className="tts-modal-close" onClick={() => setShowModal(false)}>✕</button>
            </div>
            <div className="tts-modal-body">
              {plVoices.length > 1 && (
                <div className="tts-voice-section">
                  <div className="tts-voice-head">Głos polski</div>
                  <button
                    className={`tts-voice-opt ${!voiceName ? 'active' : ''}`}
                    onClick={() => { onVoiceChange(''); setShowModal(false); }}
                  >Auto</button>
                  {plVoices.map(v => (
                    <button
                      key={v.name}
                      className={`tts-voice-opt ${voiceName === v.name ? 'active' : ''}`}
                      onClick={() => { onVoiceChange(v.name); setShowModal(false); }}
                    >{v.name}</button>
                  ))}
                </div>
              )}
              {foreignVoices.length > 0 && (
                <div className="tts-voice-section">
                  <div className="tts-voice-head">Głos {foreignLang?.split('-')[0]?.toUpperCase()}</div>
                  <button
                    className={`tts-voice-opt ${!foreignVoiceName ? 'active' : ''}`}
                    onClick={() => { onForeignVoiceChange(''); setShowModal(false); }}
                  >Auto</button>
                  {foreignVoices.map(v => (
                    <button
                      key={v.name}
                      className={`tts-voice-opt ${foreignVoiceName === v.name ? 'active' : ''}`}
                      onClick={() => { onForeignVoiceChange(v.name); setShowModal(false); }}
                    >{v.name}</button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
