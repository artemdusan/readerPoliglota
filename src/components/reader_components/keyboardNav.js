const NEXT_PAGE_KEY_NAMES = new Set([
  "ArrowRight",
  "PageDown",
  "VolumeDown",
  "AudioVolumeDown",
  "BrowserForward",
  "MediaTrackNext",
]);
const PREV_PAGE_KEY_NAMES = new Set([
  "ArrowLeft",
  "PageUp",
  "VolumeUp",
  "AudioVolumeUp",
  "BrowserBack",
  "MediaTrackPrevious",
]);
const NEXT_PAGE_CODES = new Set(["ArrowRight", "PageDown", "VolumeDown", "Space"]);
const PREV_PAGE_CODES = new Set(["ArrowLeft", "PageUp", "VolumeUp"]);

export function getPageTurnDirection(event) {
  const key = event.key;
  const code = event.code;

  if (key === " " || key === "Spacebar" || code === "Space") {
    return event.shiftKey ? -1 : 1;
  }
  if (NEXT_PAGE_KEY_NAMES.has(key) || NEXT_PAGE_CODES.has(code)) {
    return 1;
  }
  if (PREV_PAGE_KEY_NAMES.has(key) || PREV_PAGE_CODES.has(code)) {
    return -1;
  }
  return 0;
}

export function isTextEntryElement(element) {
  if (!element) return false;
  const tag = element.tagName;
  if (element.isContentEditable || tag === "TEXTAREA" || tag === "SELECT") {
    return true;
  }
  if (tag !== "INPUT") return false;
  return !["button", "checkbox", "radio", "range", "submit"].includes(
    element.type,
  );
}
