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

export function formatPolishCount(count, forms) {
  const mod10 = count % 10;
  const mod100 = count % 100;

  if (count === 1) return `1 ${forms[0]}`;
  if (mod10 >= 2 && mod10 <= 4 && !(mod100 >= 12 && mod100 <= 14)) {
    return `${count} ${forms[1]}`;
  }
  return `${count} ${forms[2]}`;
}
