import { useState, useEffect, useCallback } from "react";
import { getAllSettings, setSetting } from "../db";

export const LANGUAGES = [
  { code: "es", name: "hiszpański", flag: "🇪🇸", label: "Español" },
  { code: "fr", name: "francuski", flag: "🇫🇷", label: "Français" },
  { code: "de", name: "niemiecki", flag: "🇩🇪", label: "Deutsch" },
  { code: "it", name: "włoski", flag: "🇮🇹", label: "Italiano" },
  { code: "pt", name: "portugalski", flag: "🇵🇹", label: "Português" },
  { code: "en", name: "angielski", flag: "🇬🇧", label: "English" },
];

const DEFAULTS = {
  targetLang: "es",
  targetLangName: "hiszpański",
  targetLangFlag: "🇪🇸",
  fontSize: 30,
  theme: "boox",
  syncIntervalMinutes: 30,
  ttsMode: "mixed",
  ttsVoiceName: "", // SpeechSynthesisVoice.name for pl-PL, '' = auto
  ttsVoiceNameForeign: "", // SpeechSynthesisVoice.name for target lang, '' = auto
};

export function useSettings() {
  const [settings, setSettings] = useState(DEFAULTS);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    getAllSettings().then((stored) => {
      setSettings((prev) => ({
        ...prev,
        ...stored,
      }));
      setLoaded(true);
    });
  }, []);

  const updateSetting = useCallback(async (key, value) => {
    await setSetting(key, value);
    setSettings((prev) => ({ ...prev, [key]: value }));
  }, []);

  const updateLanguage = useCallback(async (langCode) => {
    const lang = LANGUAGES.find((l) => l.code === langCode);
    if (!lang) return;
    await Promise.all([
      setSetting("targetLang", lang.code),
      setSetting("targetLangName", lang.name),
      setSetting("targetLangFlag", lang.flag),
    ]);
    setSettings((prev) => ({
      ...prev,
      targetLang: lang.code,
      targetLangName: lang.name,
      targetLangFlag: lang.flag,
    }));
  }, []);

  return { settings, updateSetting, updateLanguage, loaded };
}
