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
