import { ActionIcon, NativeSelect } from "@mantine/core";
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
      <ActionIcon variant="subtle" size="lg" onClick={onToggleSidebar} title="Spis treści">
        <UiIcon name="menu" />
      </ActionIcon>

      <div className="tb-chapter">
        {chapter ? (
          <NativeSelect
            variant="unstyled"
            value={activeLang ?? ""}
            onChange={(event) => onSwitchLang(event.target.value || null)}
            data={[
              { value: "", label: `${chapterLabel} — Oryginał` },
              ...orderedCachedLangs.map((lang) => ({
                value: lang.code,
                label: `${chapterLabel} — ${lang.name}`,
              })),
            ]}
          />
        ) : null}
      </div>

      <ActionIcon
        ref={settingsToggleRef}
        variant={settingsMenuOpen ? "filled" : "subtle"}
        size="lg"
        onClick={onToggleSettings}
        title="Ustawienia"
      >
        <UiIcon name="settings" />
      </ActionIcon>
    </div>
  );
}
