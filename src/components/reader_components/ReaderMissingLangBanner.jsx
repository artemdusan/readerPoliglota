export default function ReaderMissingLangBanner({
  langCode,
  languages,
  onGenerate,
  onDismiss,
}) {
  const lang = languages.find((item) => item.code === langCode);

  return (
    <div className="missing-lang-banner">
      <span>
        Brak tłumaczenia {lang?.flag} {lang?.label || langCode}
      </span>

      <div className="missing-lang-actions">
        <button
          className="btn-primary"
          style={{ fontSize: 11, padding: "7px 16px" }}
          onClick={onGenerate}
        >
          Wygeneruj
        </button>
        <button
          className="btn-ghost"
          style={{ fontSize: 11, padding: "7px 16px" }}
          onClick={onDismiss}
        >
          Oryginał
        </button>
      </div>
    </div>
  );
}
