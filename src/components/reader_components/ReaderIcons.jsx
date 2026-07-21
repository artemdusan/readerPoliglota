import {
  RiSearchLine,
  RiBookmarkFill,
  RiBookmarkLine,
  RiPlayFill,
  RiPauseLine,
  RiStopLine,
  RiSkipBackLine,
  RiSkipForwardLine,
  RiFontSize,
  RiSparklingLine,
  RiRefreshLine,
  RiCursorLine,
  RiMicLine,
  RiTranslate2,
  RiMenuLine,
  RiSettings4Line,
  RiBookOpenLine,
  RiFullscreenLine,
  RiFullscreenExitLine,
  RiDeleteBinLine,
  RiShutDownLine,
} from "react-icons/ri";

const ICON_MAP = {
  search:         RiSearchLine,
  bookmark:       RiBookmarkLine,
  bookmarkFill:   RiBookmarkFill,
  play:           RiPlayFill,
  pause:          RiPauseLine,
  stop:           RiStopLine,
  skipBack:       RiSkipBackLine,
  skipForward:    RiSkipForwardLine,
  type:           RiFontSize,
  sparkles:       RiSparklingLine,
  refresh:        RiRefreshLine,
  pointer:        RiCursorLine,
  voice:          RiMicLine,
  translate:      RiTranslate2,
  menu:           RiMenuLine,
  settings:       RiSettings4Line,
  book:           RiBookOpenLine,
  fullscreen:     RiFullscreenLine,
  fullscreenExit: RiFullscreenExitLine,
  delete:         RiDeleteBinLine,
  power:          RiShutDownLine,
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
