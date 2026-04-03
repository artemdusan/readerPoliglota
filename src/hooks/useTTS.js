import { useState, useRef, useCallback, useEffect } from 'react';

export function useTTS() {
  const [isPlaying, setIsPlaying] = useState(false);
  const [rate, setRateState] = useState(1);
  const [progress, setProgress] = useState({ idx: 0, total: 0 });

  const segmentsRef       = useRef([]);
  const idxRef            = useRef(0);
  const rateRef           = useRef(1);
  const playingRef        = useRef(false);
  const preferredVoicesRef = useRef({});  // { 'pl-PL': 'voice name', 'es-ES': 'voice name', ... }
  const voiceCacheRef      = useRef({});  // key → SpeechSynthesisVoice|null

  function findVoice(lang) {
    const preferred = preferredVoicesRef.current[lang] ?? '';
    const key = `${lang}:${preferred}`;
    if (key in voiceCacheRef.current) return voiceCacheRef.current[key];
    const voices = window.speechSynthesis.getVoices();
    let v = null;
    if (preferred) v = voices.find(v => v.name === preferred) ?? null;
    if (!v) {
      const prefix = lang.split('-')[0];
      v = voices.find(v => v.lang === lang) || voices.find(v => v.lang.startsWith(prefix)) || null;
    }
    voiceCacheRef.current[key] = v;
    return v;
  }

  // speakRef updated every render — closures inside always see current state via refs
  const speakRef = useRef(null);
  speakRef.current = (idx) => {
    const segs = segmentsRef.current;
    if (!playingRef.current || idx >= segs.length) {
      if (idx >= segs.length) {
        playingRef.current = false;
        setIsPlaying(false);
        idxRef.current = 0;
        setProgress(p => ({ ...p, idx: 0 }));
      }
      return;
    }
    const seg = segs[idx];
    const utt = new SpeechSynthesisUtterance(seg.text);
    utt.lang = seg.lang;
    utt.rate = rateRef.current;
    const voice = findVoice(seg.lang);
    if (voice) utt.voice = voice;

    utt.onend = () => {
      if (!playingRef.current) return;
      const next = idx + 1;
      idxRef.current = next;
      setProgress({ idx: next, total: segs.length });
      speakRef.current(next);
    };
    utt.onerror = (e) => {
      if (e.error === 'interrupted' || e.error === 'canceled') return;
      const next = idx + 1;
      idxRef.current = next;
      speakRef.current(next);
    };
    window.speechSynthesis.speak(utt);
  };

  const load = useCallback((segments) => {
    window.speechSynthesis.cancel();
    playingRef.current = false;
    setIsPlaying(false);
    segmentsRef.current = segments;
    idxRef.current = 0;
    setProgress({ idx: 0, total: segments.length });
  }, []);

  const loadAndPlay = useCallback((segments) => {
    window.speechSynthesis.cancel();
    segmentsRef.current = segments;
    idxRef.current = 0;
    setProgress({ idx: 0, total: segments.length });
    playingRef.current = true;
    setIsPlaying(true);
    setTimeout(() => speakRef.current(0), 60);
  }, []);

  const toggle = useCallback(() => {
    if (playingRef.current) {
      window.speechSynthesis.cancel();
      playingRef.current = false;
      setIsPlaying(false);
    } else {
      playingRef.current = true;
      setIsPlaying(true);
      speakRef.current(idxRef.current);
    }
  }, []);

  const stop = useCallback(() => {
    window.speechSynthesis.cancel();
    playingRef.current = false;
    setIsPlaying(false);
    idxRef.current = 0;
    setProgress(p => ({ ...p, idx: 0 }));
  }, []);

  const setRate = useCallback((r) => {
    rateRef.current = r;
    setRateState(r);
    if (playingRef.current) {
      window.speechSynthesis.cancel();
      setTimeout(() => speakRef.current(idxRef.current), 60);
    }
  }, []);

  /** Jump to a specific segment index (and keep playing if already playing). */
  const jumpTo = useCallback((idx) => {
    const clamped = Math.max(0, Math.min(idx, segmentsRef.current.length - 1));
    idxRef.current = clamped;
    setProgress(p => ({ ...p, idx: clamped }));
    if (playingRef.current) {
      window.speechSynthesis.cancel();
      setTimeout(() => speakRef.current(clamped), 60);
    }
  }, []);

  /** Set preferred voice name for a specific BCP47 lang; clears cache so next utterance picks it up. */
  const setPreferredVoice = useCallback((lang, voiceName) => {
    preferredVoicesRef.current = { ...preferredVoicesRef.current, [lang]: voiceName };
    voiceCacheRef.current = {}; // clear all cached voice lookups
    if (playingRef.current) {
      window.speechSynthesis.cancel();
      setTimeout(() => speakRef.current(idxRef.current), 60);
    }
  }, []);

  useEffect(() => {
    window.speechSynthesis.getVoices(); // trigger load
    const onChanged = () => { voiceCacheRef.current = {}; };
    window.speechSynthesis.addEventListener('voiceschanged', onChanged);
    return () => {
      window.speechSynthesis.removeEventListener('voiceschanged', onChanged);
      window.speechSynthesis.cancel();
    };
  }, []);

  return { isPlaying, toggle, stop, load, loadAndPlay, rate, setRate, jumpTo, setPreferredVoice, progress };
}
