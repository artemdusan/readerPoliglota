import {
  RiSearchLine,
  RiBookmarkLine,
  RiPlayFill,
  RiPauseLine,
  RiFontSize,
  RiSparklingLine,
  RiRefreshLine,
  RiCursorLine,
  RiMicLine,
  RiTranslate2,
  RiMenuLine,
  RiSettings4Line,
  RiSunLine,
  RiMoonLine,
  RiBookOpenLine,
  RiFullscreenLine,
  RiFullscreenExitLine,
  RiArrowUpSLine,
  RiDeleteBinLine,
} from "react-icons/ri";

const ICON_MAP = {
  search:         RiSearchLine,
  bookmark:       RiBookmarkLine,
  play:           RiPlayFill,
  pause:          RiPauseLine,
  type:           RiFontSize,
  sparkles:       RiSparklingLine,
  refresh:        RiRefreshLine,
  pointer:        RiCursorLine,
  voice:          RiMicLine,
  translate:      RiTranslate2,
  menu:           RiMenuLine,
  settings:       RiSettings4Line,
  sun:            RiSunLine,
  moon:           RiMoonLine,
  book:           RiBookOpenLine,
  fullscreen:     RiFullscreenLine,
  fullscreenExit: RiFullscreenExitLine,
  "chevron-up":   RiArrowUpSLine,
  delete:         RiDeleteBinLine,
};

export function UiIcon({ name, className = "", title }) {
  const Icon = ICON_MAP[name];
  if (!Icon) return null;

  return (
    <Icon
      className={`ui-icon ${className}`.trim()}
      aria-hidden={title ? undefined : "true"}
      role={title ? "img" : undefined}
      aria-label={title}
    />
  );
}
