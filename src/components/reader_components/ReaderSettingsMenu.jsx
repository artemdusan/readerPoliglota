import { useState, useEffect } from "react";
import { UiIcon } from "./ReaderIcons";
import {
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  READER_FONT_OPTIONS,
  getVoiceId,
} from "./readerUtils";

const THEME_OPTIONS = [
  { value: "dark", label: "Ciemny", icon: "moon" },
  { value: "light", label: "Jasny", icon: "sun" },
  { value: "boox", label: "BOOX", icon: "book" },
];

function getVoiceNoteText(voiceLoadState) {
  if (voiceLoadState === "unsupported") {
    return "Ta przeglądarka nie udostępnia listy głosów Web Speech.";
  }
  if (voiceLoadState === "empty") {
    return "Lista głosów jest pusta. Na mobilnym Chromium pojawia się to często, gdy system nie ma zainstalowanych danych TTS albo przeglądarka nie odsłoniła jeszcze głosów.";
  }
  return "Brak osobnych głosów dla tego języka. Przeglądarka użyje domyślnego głosu systemowego.";
}

export default function ReaderSettingsMenu({
  menuRef,
  bookmarkToggleRef,
  searchOpen,
  bookmarkMenuOpen,
  hasCurrentPageBookmarks,
  isTtsActive,
  onSearchToolClick,
  onBookmarksToolClick,
  onToggleTts,
  isFullscreen,
  onToggleFullscreen,
  ttsButtonTitle,
  ttsButtonLabel,
  isTtsPlaying,
  isTtsPaused,
  hasTtsAvailable,
  fontSize,
  readerFont,
  onChangeFontSize,
  onSetFontSize,
  onChangeReaderFont,
  showAddTranslation,
  showRegenerateTranslation,
  onAddTranslation,
  onRegenerateTranslation,
  onDeleteTranslation,
  sourceLanguageLabel,
  targetLanguageLabel,
  sourceVoices,
  targetVoices,
  showTargetVoiceSelect,
  showVoiceNote,
  voiceLoadState,
  theme,
  onChangeTheme,
  tooltipReadOnClick,
  onToggleTooltipReadOnClick,
  showAllTranslations,
  onToggleShowAllTranslations,
  ttsSourceVoice,
  ttsTargetVoice,
  onSourceVoiceChange,
  onTargetVoiceChange,
}) {
  const [fsInput, setFsInput] = useState(String(fontSize));
  useEffect(() => {
    setFsInput(String(fontSize));
  }, [fontSize]);

  return (
    <div className="settings-menu" ref={menuRef}>
      <div className="settings-menu-toolbar">
        <button
          className={`settings-tool${searchOpen ? " settings-tool-active" : ""}`}
          onClick={onSearchToolClick}
          title="Szukaj w rozdziale"
        >
          <span className="settings-tool-icon">
            <UiIcon name="search" />
          </span>
          <span className="settings-tool-text">Szukaj</span>
        </button>

        <button
          ref={bookmarkToggleRef}
          className={`settings-tool`}
          onClick={onBookmarksToolClick}
          title="Zakładki"
        >
          <span className="settings-tool-icon">
            <UiIcon name="bookmark" />
          </span>
          <span className="settings-tool-text">Zakładki</span>
        </button>

        <button
          className={`settings-tool${isTtsActive ? " settings-tool-active" : ""}`}
          onClick={onToggleTts}
          title={ttsButtonTitle}
          disabled={!hasTtsAvailable}
        >
          <span className="settings-tool-icon">
            <UiIcon
              name={isTtsPlaying && !isTtsPaused ? "pause" : "play"}
              strokeWidth={2}
            />
          </span>
          <span className="settings-tool-text">{ttsButtonLabel}</span>
        </button>

        <button
          className={`settings-tool`}
          onClick={onToggleFullscreen}
          title={isFullscreen ? "Wyjdź z pełnego ekranu" : "Peły ekran"}
        >
          <span className="settings-tool-icon">
            <UiIcon name={isFullscreen ? "fullscreenExit" : "fullscreen"} />
          </span>
          <span className="settings-tool-text">Ekran</span>
        </button>
      </div>

      <div className="settings-menu-divider" />

      <div className="settings-menu-section-label">Widok</div>
      <div className="settings-menu-row settings-menu-row-compact">
        <span className="settings-menu-label settings-menu-label-with-icon">
          <UiIcon name="type" />
          <span>Rozmiar</span>
        </span>
        <div className="settings-menu-ctrl">
          <button className="ctl" onClick={() => onChangeFontSize(-1)}>
            A-
          </button>
          <input
            className="fs-val fs-input"
            type="number"
            min={FONT_SIZE_MIN}
            max={FONT_SIZE_MAX}
            value={fsInput}
            onChange={(e) => setFsInput(e.target.value)}
            onBlur={() => {
              const n = Number(fsInput);
              if (Number.isFinite(n) && n >= 1) onSetFontSize?.(n);
              else setFsInput(String(fontSize));
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.target.blur();
            }}
            aria-label="Rozmiar czcionki"
          />
          <button className="ctl" onClick={() => onChangeFontSize(1)}>
            A+
          </button>
        </div>
      </div>

      <div className="settings-menu-row settings-menu-row-font">
        <span className="settings-menu-label settings-menu-label-with-icon">
          <UiIcon name="book" />
          <span>Krój</span>
        </span>
        <select
          className="reader-font-sel"
          value={readerFont}
          onChange={(event) => onChangeReaderFont?.(event.target.value)}
          aria-label="Krój czcionki"
        >
          {READER_FONT_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      <div className="settings-menu-row settings-menu-row-theme">
        <span className="settings-menu-label settings-menu-label-with-icon">
          <UiIcon
            name={
              theme === "light" ? "sun" : theme === "boox" ? "book" : "moon"
            }
          />
          <span>Motyw</span>
        </span>
        <div className="theme-segmented" role="radiogroup" aria-label="Motyw">
          {THEME_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              className={`theme-segment${theme === option.value ? " is-active" : ""}`}
              role="radio"
              aria-checked={theme === option.value}
              onClick={() => onChangeTheme?.(option.value)}
              title={option.label}
            >
              <UiIcon name={option.icon} />
              <span>{option.label}</span>
            </button>
          ))}
        </div>
      </div>

      {(showAddTranslation || showRegenerateTranslation) && (
        <>
          <div className="settings-menu-divider" />
          <div className="settings-menu-section-label">Tłumaczenie</div>
        </>
      )}

      {showAddTranslation && (
        <div className="settings-menu-row settings-menu-row-compact">
          <span className="settings-menu-label settings-menu-label-with-icon">
            <UiIcon name="translate" />
            <span>Rozdział</span>
          </span>
          <div className="settings-menu-ctrl">
            <button
              className="ctl ctl-gold ctl-wide"
              onClick={onAddTranslation}
            >
              <UiIcon name="sparkles" />
              Dodaj
            </button>
          </div>
        </div>
      )}

      {showRegenerateTranslation && (
        <div className="settings-menu-row settings-menu-row-compact">
          <span className="settings-menu-label settings-menu-label-with-icon">
            <UiIcon name="translate" />
            <span>Rozdział</span>
          </span>
          <div className="settings-menu-ctrl" style={{ gap: 6 }}>
            <button className="ctl ctl-wide" onClick={onRegenerateTranslation}>
              <UiIcon name="refresh" />
              Regeneruj
            </button>
            <button
              className="ctl"
              onClick={onDeleteTranslation}
              title="Usuń tłumaczenie"
            >
              <UiIcon name="delete" />
            </button>
          </div>
        </div>
      )}

      <div className="settings-menu-divider" />

      <div className="settings-menu-section-label">Kliknięcie słowa</div>
      <div className="settings-menu-row settings-menu-row-switch">
        <span className="settings-menu-label settings-menu-label-with-icon">
          <UiIcon name="pointer" />
          <span>Czytaj tooltip</span>
        </span>
        <div className="settings-toggle-wrap">
          <span className="settings-toggle-hint">
            {tooltipReadOnClick ? "Wł." : "Wył."}
          </span>
          <button
            type="button"
            className={`settings-toggle${tooltipReadOnClick ? " is-on" : ""}`}
            aria-pressed={tooltipReadOnClick}
            onClick={onToggleTooltipReadOnClick}
            title={tooltipReadOnClick ? "Wyłącz" : "Włącz"}
          >
            <span className="settings-toggle-track">
              <span className="settings-toggle-thumb" />
            </span>
          </button>
        </div>
      </div>

      <div className="settings-menu-row settings-menu-row-switch">
        <span className="settings-menu-label settings-menu-label-with-icon">
          <UiIcon name="translate" />
          <span>Pokaż tłumaczenia</span>
        </span>
        <div className="settings-toggle-wrap">
          <span className="settings-toggle-hint">
            {showAllTranslations ? "Wł." : "Wył."}
          </span>
          <button
            type="button"
            className={`settings-toggle${showAllTranslations ? " is-on" : ""}`}
            aria-pressed={showAllTranslations}
            onClick={onToggleShowAllTranslations}
            title={showAllTranslations ? "Wyłącz" : "Włącz"}
          >
            <span className="settings-toggle-track">
              <span className="settings-toggle-thumb" />
            </span>
          </button>
        </div>
      </div>

      <div className="settings-menu-divider" />
      <div className="settings-menu-section-label">Głosy TTS</div>

      <div className="settings-voice-row">
        <span className="settings-menu-label settings-menu-label-with-icon">
          <UiIcon name="voice" />
          <span>Oryginał</span>
          <span className="settings-voice-lang">{sourceLanguageLabel}</span>
        </span>
        <select
          className="tts-voice-sel"
          value={ttsSourceVoice}
          disabled={!sourceVoices.length}
          onChange={(event) => onSourceVoiceChange(event.target.value)}
        >
          <option value="">
            {sourceVoices.length ? "Domyślny głos" : "Głos systemowy"}
          </option>
          {sourceVoices.map((voice) => (
            <option key={getVoiceId(voice)} value={getVoiceId(voice)}>
              {voice.name}
            </option>
          ))}
        </select>
      </div>

      {showTargetVoiceSelect && (
        <div className="settings-voice-row">
          <span className="settings-menu-label settings-menu-label-with-icon">
            <UiIcon name="translate" />
            <span>Tłumaczenie</span>
            <span className="settings-voice-lang">{targetLanguageLabel}</span>
          </span>
          <select
            className="tts-voice-sel"
            value={ttsTargetVoice}
            disabled={!targetVoices.length}
            onChange={(event) => onTargetVoiceChange(event.target.value)}
          >
            <option value="">
              {targetVoices.length ? "Domyślny głos" : "Głos systemowy"}
            </option>
            {targetVoices.map((voice) => (
              <option key={getVoiceId(voice)} value={getVoiceId(voice)}>
                {voice.name}
              </option>
            ))}
          </select>
        </div>
      )}

      {showVoiceNote && (
        <div className="settings-menu-note">
          {getVoiceNoteText(voiceLoadState)}
        </div>
      )}
    </div>
  );
}
