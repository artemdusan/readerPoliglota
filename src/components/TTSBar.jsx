import { useState, useEffect, useRef } from 'react';

const RATES = [0.75, 1, 1.25, 1.5, 2];
const RATE_LABELS = { 0.75: '¾×', 1: '1×', 1.25: '1¼×', 1.5: '1½×', 2: '2×' };

export default function TTSBar({
  isPlaying, toggle, onStop, rate, setRate, progress,
  voiceName, onVoiceChange,
  foreignLang, foreignVoiceName, onForeignVoiceChange,
}) {
  const [plVoices, setPlVoices]           = useState([]);
  const [foreignVoices, setForeignVoices] = useState([]);
  const [showVoices, setShowVoices]       = useState(false);   // 'pl' | 'foreign' | false
  const popoverRef                        = useRef(null);

  const pct = progress.total > 0 ? (progress.idx / progress.total) * 100 : 0;

  // Load voices filtered by language
  useEffect(() => {
    function load() {
      const all = window.speechSynthesis.getVoices();
      setPlVoices(all.filter(v => v.lang.startsWith('pl')));
      if (foreignLang) {
        const prefix = foreignLang.split('-')[0];
        setForeignVoices(all.filter(v => v.lang.startsWith(prefix)));
      }
    }
    load();
    window.speechSynthesis.addEventListener('voiceschanged', load);
    return () => window.speechSynthesis.removeEventListener('voiceschanged', load);
  }, [foreignLang]);

  // Close popover on outside click
  useEffect(() => {
    if (!showVoices) return;
    function onDown(e) {
      if (popoverRef.current && !popoverRef.current.contains(e.target)) setShowVoices(false);
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [showVoices]);

  function VoiceList({ voices, current, onChange, label }) {
    return (
      <div className="tts-voice-list">
        <div className="tts-voice-head">{label}</div>
        <button
          className={`tts-voice-opt ${!current ? 'active' : ''}`}
          onClick={() => { onChange(''); setShowVoices(false); }}
        >Auto</button>
        {voices.map(v => (
          <button
            key={v.name}
            className={`tts-voice-opt ${current === v.name ? 'active' : ''}`}
            onClick={() => { onChange(v.name); setShowVoices(false); }}
          >{v.name}</button>
        ))}
      </div>
    );
  }

  return (
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

      {/* Polish voice selector */}
      {plVoices.length > 1 && (
        <div className="tts-voice-wrap" ref={showVoices === 'pl' ? popoverRef : null}>
          <button
            className={`tts-btn ${showVoices === 'pl' ? 'active' : ''}`}
            onClick={() => setShowVoices(s => s === 'pl' ? false : 'pl')}
            title="Głos polski"
          >🗣 PL</button>
          {showVoices === 'pl' && (
            <VoiceList voices={plVoices} current={voiceName} onChange={onVoiceChange} label="Głos polski" />
          )}
        </div>
      )}

      {/* Foreign voice selector */}
      {foreignVoices.length > 0 && (
        <div className="tts-voice-wrap" ref={showVoices === 'foreign' ? popoverRef : null}>
          <button
            className={`tts-btn ${showVoices === 'foreign' ? 'active' : ''}`}
            onClick={() => setShowVoices(s => s === 'foreign' ? false : 'foreign')}
            title="Głos obcy"
          >🗣 {foreignLang?.split('-')[0].toUpperCase()}</button>
          {showVoices === 'foreign' && (
            <VoiceList voices={foreignVoices} current={foreignVoiceName} onChange={onForeignVoiceChange} label={`Głos (${foreignLang?.split('-')[0]})`} />
          )}
        </div>
      )}
    </div>
  );
}
