import { UiIcon } from "./ReaderIcons";

export default function ReaderTopbar({
  chapter,
  chapterLabel,
  activeLang,
  orderedCachedLangs,
  onSwitchLang,
  settingsMenuOpen,
  settingsToggleRef,
  onToggleSidebar,
  onToggleSettings,
  onHideBars,
  fontSize,
  onFontSizeDown,
  onFontSizeUp,
}) {
  return (
    <div className="topbar">
      <button
        className="sb-tog-inline ctl ctl-icon"
        onClick={onToggleSidebar}
        title="Spis treści"
      >
        <UiIcon name="menu" />
      </button>

      <div className="tb-chapter">
        {chapter ? (
          <select
            className="tb-ver-select"
            value={activeLang ?? ""}
            onChange={(event) => onSwitchLang(event.target.value || null)}
          >
            <option value="">{`${chapterLabel} — Oryginał`}</option>
            {orderedCachedLangs.map((lang) => (
              <option key={`display-${lang.code}`} value={lang.code}>
                {`${chapterLabel} — ${lang.name}`}
              </option>
            ))}
          </select>
        ) : null}
      </div>

      <div className="tb-controls">
        <button
          className="ctl ctl-icon"
          onClick={onFontSizeDown}
          disabled={fontSize <= 13}
          title="Zmniejsz czcionkę"
          aria-label="Zmniejsz czcionkę"
        >
          A−
        </button>
        <button
          className="ctl ctl-icon"
          onClick={onFontSizeUp}
          disabled={fontSize >= 99}
          title="Powiększ czcionkę"
          aria-label="Powiększ czcionkę"
        >
          A+
        </button>
        <button
          className="ctl ctl-icon"
          onClick={onHideBars}
          title="Ukryj paski"
        >
          <UiIcon name="chevron-up" />
        </button>
        <button
          ref={settingsToggleRef}
          className={`ctl ctl-icon${settingsMenuOpen ? " ctl-active" : ""}`}
          onClick={onToggleSettings}
          title="Ustawienia"
        >
          <UiIcon name="settings" />
        </button>
      </div>
    </div>
  );
}
