export function toggleFullscreen() {
  if (document.fullscreenElement) {
    document.exitFullscreen?.()?.catch(() => {});
  } else {
    document.documentElement.requestFullscreen?.()?.catch(() => {});
  }
}
