import { UiIcon } from "./ReaderIcons";
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
  isTtsPlaying,
  isTtsPaused,
  hasTtsAvailable,
  fontSize,
  onChangeFontSize,
  showAddTranslation,
  showRegenerateTranslation,
  onAddTranslation,
  onRegenerateTranslation,
  sourceLanguageLabel,
  targetLanguageLabel,
  sourceVoices,
  targetVoices,
  showTargetVoiceSelect,
  showVoiceNote,
  voiceLoadState,
  tooltipReadOnClick,
  onToggleTooltipReadOnClick,
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
          <span className="settings-tool-icon">
            <UiIcon name="search" />
          </span>
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
      </div>

      <div className="settings-menu-divider" />

      <div className="settings-menu-section-label">Widok</div>
      <div className="settings-menu-row settings-menu-row-compact">
        <span className="settings-menu-label settings-menu-label-with-icon">
          <UiIcon name="type" />
          <span>Czcionka</span>
        </span>
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
            <button className="ctl ctl-gold ctl-wide" onClick={onAddTranslation}>
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
          <div className="settings-menu-ctrl">
            <button className="ctl ctl-wide" onClick={onRegenerateTranslation}>
              <UiIcon name="refresh" />
              Regeneruj
            </button>
          </div>
        </div>
      )}

      <div className="settings-menu-divider" />

      <div className="settings-menu-section-label">Kliknięcie słowa</div>
      <div className="settings-menu-row settings-menu-row-switch">
        <div className="settings-menu-copy">
          <span className="settings-menu-label settings-menu-label-with-icon">
            <UiIcon name="pointer" />
            <span>Czytaj tooltip</span>
          </span>
          <span className="settings-menu-subtle">
            Tooltip otwiera się zawsze, a głos po kliknięciu jest opcjonalny.
          </span>
        </div>
        <button
          type="button"
          className={`settings-toggle${tooltipReadOnClick ? " is-on" : ""}`}
          aria-pressed={tooltipReadOnClick}
          onClick={onToggleTooltipReadOnClick}
          title={
            tooltipReadOnClick
              ? "Wyłącz czytanie tooltipów po kliknięciu"
              : "Włącz czytanie tooltipów po kliknięciu"
          }
        >
          <span className="settings-toggle-track">
            <span className="settings-toggle-thumb" />
          </span>
          <span className="settings-toggle-text">
            {tooltipReadOnClick ? "Wł." : "Wył."}
          </span>
        </button>
      </div>

      <div className="settings-menu-divider" />
      <div className="settings-menu-section-label">Głosy TTS</div>

      <div className="settings-menu-row settings-menu-row-compact settings-menu-row-select">
        <div className="settings-menu-copy settings-menu-copy-compact">
          <span className="settings-menu-label settings-menu-label-with-icon">
            <UiIcon name="voice" />
            <span>Oryginał</span>
          </span>
          <span className="settings-menu-subtle">{sourceLanguageLabel}</span>
        </div>
        <div className="settings-menu-select-wrap">
          <select
            className="tts-voice-sel"
            value={ttsSourceVoice}
            disabled={!sourceVoices.length}
            onChange={(event) => onSourceVoiceChange(event.target.value)}
          >
            <option value="">{sourceVoices.length ? "Domyślny głos" : "Głos systemowy"}</option>
            {sourceVoices.map((voice) => (
              <option key={getVoiceId(voice)} value={getVoiceId(voice)}>
                {voice.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {showTargetVoiceSelect && (
        <div className="settings-menu-row settings-menu-row-compact settings-menu-row-select">
          <div className="settings-menu-copy settings-menu-copy-compact">
            <span className="settings-menu-label settings-menu-label-with-icon">
              <UiIcon name="translate" />
              <span>Tłumaczenie</span>
            </span>
            <span className="settings-menu-subtle">{targetLanguageLabel}</span>
          </div>
          <div className="settings-menu-select-wrap">
            <select
              className="tts-voice-sel"
              value={ttsTargetVoice}
              disabled={!targetVoices.length}
              onChange={(event) => onTargetVoiceChange(event.target.value)}
            >
              <option value="">{targetVoices.length ? "Domyślny głos" : "Głos systemowy"}</option>
              {targetVoices.map((voice) => (
                <option key={getVoiceId(voice)} value={getVoiceId(voice)}>
                  {voice.name}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      {showVoiceNote && (
        <div className="settings-menu-note">{getVoiceNoteText(voiceLoadState)}</div>
      )}
    </div>
  );
}
