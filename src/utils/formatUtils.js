export function formatTransfer(bytes, fallbackMB = 0) {
  if (typeof bytes === "number" && Number.isFinite(bytes)) {
    if (bytes < 1_048_576) {
      return `${Math.max(0.01, bytes / 1024).toFixed(2)} KB`;
    }
    return `${(bytes / 1_048_576).toFixed(2)} MB`;
  }
  return `${fallbackMB} MB`;
}

export function formatLastSync(ts) {
  if (!ts) return "Jeszcze nie synchronizowano";
  return new Date(ts).toLocaleString("pl-PL", {
    dateStyle: "short",
    timeStyle: "short",
  });
}

export function formatRelativeSync(ts, now) {
  if (!ts) return "";
  const diffMin = Math.floor((now - ts) / 60000);
  if (diffMin < 1) return "przed chwilą";
  if (diffMin < 60) return `${diffMin} min temu`;
  const diffHrs = Math.floor(diffMin / 60);
  if (diffHrs < 24) return `${diffHrs} godz. temu`;
  const diffDays = Math.floor(diffHrs / 24);
  return `${diffDays} dni temu`;
}

// Odczyt znacznika ostatniej synchronizacji z localStorage (null gdy brak).
export function getLastSyncTs() {
  const value = localStorage.getItem("vocabapp:lastSync");
  return value ? Number(value) : null;
}
