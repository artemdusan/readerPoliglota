import { Slider } from "@mantine/core";
import { UiIcon } from "./ReaderIcons";

function Tool({ icon, glyph, label, onClick, active, disabled, title, btnRef }) {
  return (
    <button
      type="button"
      ref={btnRef}
      className={`rbc-tool${active ? " is-active" : ""}`}
      onClick={onClick}
      disabled={disabled}
      title={title || label}
      aria-label={title || label}
    >
      {glyph ? <span className="rbc-tool-glyph">{glyph}</span> : <UiIcon name={icon} />}
      {label && <span className="rbc-tool-label">{label}</span>}
    </button>
  );
}

/* Dolne pływające sterowanie ujawniane ciasteczkiem: nawigacja stron ze
   sliderem (lub transport TTS podczas odtwarzania) + rząd narzędzi. */
export default function ReaderBottomBar({
  currentPage,
  totalPages,
  chapterIdx,
  chapterCount,
  onPrevPage,
  onNextPage,
  onPageSliderChange,
  onPageSliderCommit,
  ttsTransport,
  onBackToLibrary,
  onToggleSidebar,
  searchOpen,
  onToggleSearch,
  bookmarkMenuOpen,
  onToggleBookmarks,
  bookmarkToggleRef,
  hasTtsAvailable,
  isTtsActive,
  onToggleTts,
  ttsButtonTitle,
  onChangeFontSize,
  settingsMenuOpen,
  onToggleSettings,
  settingsToggleRef,
}) {
  return (
    <div className="reader-bottom-chrome">
      {ttsTransport ? (
        <div className="rbc-nav rbc-nav-tts">
          <button
            type="button"
            className="rbc-page-btn"
            onClick={ttsTransport.onPrev}
            disabled={ttsTransport.prevDisabled}
            title="Poprzedni fragment"
          >
            <UiIcon name="skipBack" />
          </button>
          <button
            type="button"
            className="rbc-page-btn"
            onClick={ttsTransport.onToggle}
            title={ttsTransport.paused ? "Wznów" : "Pauza"}
          >
            <UiIcon name={ttsTransport.paused ? "play" : "pause"} />
          </button>
          <button
            type="button"
            className="rbc-page-btn"
            onClick={ttsTransport.onStop}
            title="Zakończ TTS"
          >
            <UiIcon name="stop" />
          </button>
          <button
            type="button"
            className="rbc-page-btn"
            onClick={ttsTransport.onNext}
            disabled={ttsTransport.nextDisabled}
            title="Następny fragment"
          >
            <UiIcon name="skipForward" />
          </button>
        </div>
      ) : (
        <div className="rbc-nav">
          <button
            type="button"
            className="rbc-page-btn"
            onClick={onPrevPage}
            disabled={currentPage === 0 && (chapterIdx ?? 0) === 0}
            title="Poprzednia strona"
          >
            ❮
          </button>
          <Slider
            style={{ flex: 1, minWidth: 0 }}
            size="sm"
            min={0}
            max={Math.max(totalPages - 1, 0)}
            step={1}
            value={Math.min(currentPage, Math.max(totalPages - 1, 0))}
            disabled={totalPages <= 1}
            label={null}
            aria-label="Przesuń do strony"
            onChange={(value) => onPageSliderChange({ target: { value } })}
            onChangeEnd={(value) => onPageSliderCommit({ target: { value } })}
          />
          <button
            type="button"
            className="rbc-page-btn"
            onClick={onNextPage}
            disabled={
              currentPage >= totalPages - 1 &&
              (chapterIdx ?? 0) >= chapterCount - 1
            }
            title="Następna strona"
          >
            ❯
          </button>
        </div>
      )}

      <div className="rbc-tools">
        <Tool icon="library" label={"Biblio­teka"} title="Biblioteka" onClick={onBackToLibrary} />
        <Tool icon="menu" label="Spis" title="Spis treści" onClick={onToggleSidebar} />
        <Tool
          icon="search"
          label="Szukaj"
          title="Szukaj w rozdziale"
          active={searchOpen}
          onClick={onToggleSearch}
        />
        <Tool
          icon="bookmark"
          label="Zakładki"
          active={bookmarkMenuOpen}
          onClick={onToggleBookmarks}
          btnRef={bookmarkToggleRef}
        />
        <Tool
          icon={isTtsActive ? "pause" : "play"}
          label="Słuchaj"
          title={ttsButtonTitle}
          active={isTtsActive}
          disabled={!hasTtsAvailable}
          onClick={onToggleTts}
        />
        <Tool glyph="A−" title="Mniejsza czcionka" onClick={() => onChangeFontSize(-1)} />
        <Tool glyph="A+" title="Większa czcionka" onClick={() => onChangeFontSize(1)} />
        <Tool
          icon="settings"
          label="Opcje"
          title="Ustawienia"
          active={settingsMenuOpen}
          onClick={onToggleSettings}
          btnRef={settingsToggleRef}
        />
      </div>
    </div>
  );
}
