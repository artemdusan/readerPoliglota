import { getVoiceId } from "./readerUtils";

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
  ttsButtonTitle,
  ttsButtonLabel,
  ttsButtonIcon,
  hasTtsAvailable,
  fontSize,
  onChangeFontSize,
  showAddTranslation,
  showRegenerateTranslation,
  onAddTranslation,
  onRegenerateTranslation,
  sourceLangCode,
  targetLangCode,
  sourceVoices,
  targetVoices,
  showTargetVoiceSelect,
  showVoiceNote,
  voiceLoadState,
  ttsSourceVoice,
  ttsTargetVoice,
  onSourceVoiceChange,
  onTargetVoiceChange,
}) {
  return (
    <div className="settings-menu" ref={menuRef}>
      <div className="settings-menu-toolbar">
        <button
          className={`settings-tool${searchOpen ? " settings-tool-active" : ""}`}
          onClick={onSearchToolClick}
          title="Szukaj w rozdziale"
        >
          <span className="settings-tool-icon">/</span>
          <span className="settings-tool-text">Szukaj</span>
        </button>

        <button
          ref={bookmarkToggleRef}
          className={`settings-tool${
            bookmarkMenuOpen || hasCurrentPageBookmarks
              ? " settings-tool-active"
              : ""
          }`}
          onClick={onBookmarksToolClick}
          title="Zakładki"
        >
          <span className="settings-tool-icon">*</span>
          <span className="settings-tool-text">Zakładki</span>
        </button>

        <button
          className={`settings-tool${isTtsActive ? " settings-tool-active" : ""}`}
          onClick={onToggleTts}
          title={ttsButtonTitle}
          disabled={!hasTtsAvailable}
        >
          <span className="settings-tool-icon">{ttsButtonIcon}</span>
          <span className="settings-tool-text">{ttsButtonLabel}</span>
        </button>
      </div>

      <div className="settings-menu-divider" />

      <div className="settings-menu-row settings-menu-row-compact">
        <span className="settings-menu-label">Czcionka</span>
        <div className="settings-menu-ctrl">
          <button className="ctl" onClick={() => onChangeFontSize(-1)}>
            A-
          </button>
          <span className="fs-val">{fontSize}</span>
          <button className="ctl" onClick={() => onChangeFontSize(1)}>
            A+
          </button>
        </div>
      </div>

      {showAddTranslation && (
        <div className="settings-menu-row settings-menu-row-compact">
          <span className="settings-menu-label">Tłumaczenie</span>
          <div className="settings-menu-ctrl">
            <button className="ctl ctl-gold" onClick={onAddTranslation}>
              + Dodaj
            </button>
          </div>
        </div>
      )}

      {showRegenerateTranslation && (
        <div className="settings-menu-row settings-menu-row-compact">
          <span className="settings-menu-label">Tłumaczenie</span>
          <div className="settings-menu-ctrl">
            <button className="ctl" onClick={onRegenerateTranslation}>
              Regeneruj
            </button>
          </div>
        </div>
      )}

      <div className="settings-menu-divider" />

      <div className="settings-menu-row settings-menu-row-compact settings-menu-row-select">
        <span className="settings-menu-label">{sourceLangCode}</span>
        <select
          className="tts-voice-sel"
          value={ttsSourceVoice}
          disabled={!sourceVoices.length}
          onChange={(event) => onSourceVoiceChange(event.target.value)}
        >
          <option value="">{sourceVoices.length ? "Domyślny" : "Systemowy"}</option>
          {sourceVoices.map((voice) => (
            <option key={getVoiceId(voice)} value={getVoiceId(voice)}>
              {voice.name}
            </option>
          ))}
        </select>
      </div>

      {showTargetVoiceSelect && (
        <div className="settings-menu-row settings-menu-row-compact settings-menu-row-select">
          <span className="settings-menu-label">{targetLangCode}</span>
          <select
            className="tts-voice-sel"
            value={ttsTargetVoice}
            disabled={!targetVoices.length}
            onChange={(event) => onTargetVoiceChange(event.target.value)}
          >
            <option value="">{targetVoices.length ? "Domyślny" : "Systemowy"}</option>
            {targetVoices.map((voice) => (
              <option key={getVoiceId(voice)} value={getVoiceId(voice)}>
                {voice.name}
              </option>
            ))}
          </select>
        </div>
      )}

      {showVoiceNote && (
        <div className="settings-menu-note">{getVoiceNoteText(voiceLoadState)}</div>
      )}
    </div>
  );
}
