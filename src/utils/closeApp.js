// Zamyka okno instalowanej PWA / karty; poza tym kontekstem przeglądarka
// może zignorować window.close() — wtedy zostaje systemowe zamknięcie.
export function closeApp() {
  if (document.fullscreenElement) {
    document.exitFullscreen?.()?.catch(() => {});
  }
  window.close();
}
