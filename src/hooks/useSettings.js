import { useState, useEffect, useCallback } from 'react';
import { getAllSettings, setSetting } from '../db';

export const LANGUAGES = [
  { code: 'es', name: 'hiszpański', flag: '🇪🇸', label: 'Español' },
  { code: 'fr', name: 'francuski',  flag: '🇫🇷', label: 'Français' },
  { code: 'de', name: 'niemiecki',  flag: '🇩🇪', label: 'Deutsch' },
  { code: 'it', name: 'włoski',     flag: '🇮🇹', label: 'Italiano' },
  { code: 'pt', name: 'portugalski', flag: '🇵🇹', label: 'Português' },
  { code: 'en', name: 'angielski',  flag: '🇬🇧', label: 'English' },
];

export const PROVIDERS = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseURL: 'https://api.deepseek.com/v1',
    keyPlaceholder: 'sk-...',
    models: [
      { id: 'deepseek-chat',   label: 'DeepSeek Chat (szybki, tani)' },
      { id: 'deepseek-reasoner', label: 'DeepSeek Reasoner (wyższa jakość)' },
    ],
    defaultModel: 'deepseek-chat',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
    keyPlaceholder: 'sk-...',
    models: [
      { id: 'gpt-4o-mini', label: 'GPT-4o mini (szybki, tani)' },
      { id: 'gpt-4o',      label: 'GPT-4o (najlepsza jakość)' },
    ],
    defaultModel: 'gpt-4o-mini',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseURL: 'https://openrouter.ai/api/v1',
    keyPlaceholder: 'sk-or-...',
    models: [
      { id: 'google/gemini-flash-1.5',        label: 'Gemini Flash 1.5 (szybki, tani)' },
      { id: 'meta-llama/llama-3.3-70b-instruct', label: 'Llama 3.3 70B (darmowy)' },
      { id: 'anthropic/claude-3.5-haiku',     label: 'Claude 3.5 Haiku' },
    ],
    defaultModel: 'google/gemini-flash-1.5',
  },
];

// Legacy — kept so existing stored model IDs still render
export const MODELS = PROVIDERS.flatMap(p => p.models);

const DEFAULTS = {
  apiKey: '',
  provider: 'deepseek',
  targetLang: 'es',
  targetLangName: 'hiszpański',
  targetLangFlag: '🇪🇸',
  polyglotModel: 'deepseek-chat',
  fontSize: 19,
  ttsMode: 'mixed',
  ttsVoiceName: '',        // SpeechSynthesisVoice.name for pl-PL, '' = auto
  ttsVoiceNameForeign: '', // SpeechSynthesisVoice.name for target lang, '' = auto
};

export function useSettings() {
  const [settings, setSettings] = useState(DEFAULTS);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    getAllSettings().then(stored => {
      setSettings(prev => ({ ...prev, ...stored }));
      setLoaded(true);
    });
  }, []);

  const updateSetting = useCallback(async (key, value) => {
    await setSetting(key, value);
    setSettings(prev => ({ ...prev, [key]: value }));
  }, []);

  const updateLanguage = useCallback(async (langCode) => {
    const lang = LANGUAGES.find(l => l.code === langCode);
    if (!lang) return;
    await Promise.all([
      setSetting('targetLang', lang.code),
      setSetting('targetLangName', lang.name),
      setSetting('targetLangFlag', lang.flag),
    ]);
    setSettings(prev => ({
      ...prev,
      targetLang: lang.code,
      targetLangName: lang.name,
      targetLangFlag: lang.flag,
    }));
  }, []);

  return { settings, updateSetting, updateLanguage, loaded };
}
