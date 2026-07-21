import { UiIcon } from "./ReaderIcons";

/* Górne pływające sterowanie: tytuł rozdziału + wybór wersji językowej
   jako rząd chipów (Oryginał / języki / dodaj tłumaczenie). Bez paska z tłem. */
export default function ReaderTopbar({
  chapterLabel,
  activeLang,
  orderedCachedLangs,
  onSwitchLang,
  canAddTranslation,
  onAddTranslation,
}) {
  return (
    <div className="reader-top-chrome">
      <div className="rtc-chapter" title={chapterLabel}>
        {chapterLabel}
      </div>
      <div className="rtc-langs" aria-label="Wersja językowa">
        <button
          type="button"
          className={`rtc-chip${activeLang === null ? " is-active" : ""}`}
          onClick={() => onSwitchLang(null)}
        >
          Oryginał
        </button>
        {orderedCachedLangs.map((lang) => (
          <button
            key={lang.code}
            type="button"
            className={`rtc-chip${activeLang === lang.code ? " is-active" : ""}`}
            onClick={() => onSwitchLang(lang.code)}
          >
            {lang.name}
          </button>
        ))}
        {canAddTranslation && (
          <button
            type="button"
            className="rtc-chip rtc-chip-add"
            onClick={onAddTranslation}
            title="Dodaj tłumaczenie tego rozdziału"
          >
            <UiIcon name="sparkles" /> Tłumacz
          </button>
        )}
      </div>
    </div>
  );
}
