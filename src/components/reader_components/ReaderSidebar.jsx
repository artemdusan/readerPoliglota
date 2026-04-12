export default function ReaderSidebar({
  sidebarOpen,
  onClose,
  onBack,
  book,
  canTranslateBook,
  onOpenBatchModal,
  chapterCount,
  tocItems,
  hrefToIndex,
  chapterStatusMap,
  currentChapterHref,
  onGoToHref,
  languageMeta,
  languageOrder,
}) {
  return (
    <>
      <aside className={`sidebar ${sidebarOpen ? "open" : ""}`}>
        <div className="sb-top">
          <button className="btn-back" onClick={onBack}>
            ← Biblioteka
          </button>
          <div className="sb-cover">
            {book?.cover ? (
              <img src={book.cover} alt="okładka" />
            ) : (
              <span className="cover-ph">📖</span>
            )}
          </div>
          <div className="sb-title">{book?.title || "…"}</div>
          {book?.author && <div className="sb-author">{book.author}</div>}
          {canTranslateBook && (
            <button className="sb-translate-btn" onClick={onOpenBatchModal}>
              Tłumacz książkę
            </button>
          )}
          <div className="sb-stats">{chapterCount} rozdziałów</div>
        </div>

        <div className="toc-label">Spis treści</div>
        <div className="toc-scroll">
          <ul className="toc-list">
            {tocItems.map((item, index) => {
              const itemHref = (item.href || "").split("#")[0];
              const chapterIndex = hrefToIndex[itemHref] ?? -1;
              const status = chapterStatusMap[chapterIndex];
              const translationBadges = [...(status?.translationLangs || [])]
                .sort(
                  (a, b) =>
                    (languageOrder.get(a) ?? Number.MAX_SAFE_INTEGER) -
                    (languageOrder.get(b) ?? Number.MAX_SAFE_INTEGER),
                )
                .map(
                  (code) =>
                    languageMeta[code] || {
                      code,
                      flag: code.toUpperCase(),
                      name: code,
                    },
                );

              return (
                <li
                  key={itemHref || `${index}-${item.title || "toc"}`}
                  className="toc-item"
                >
                  <button
                    type="button"
                    className={`toc-entry toc-depth-${Math.min(item.depth ?? 0, 3)}${
                      currentChapterHref === itemHref ? " active" : ""
                    }`}
                    onClick={() => onGoToHref(itemHref)}
                  >
                    <span className="toc-entry-title">{item.title || "—"}</span>
                    {translationBadges.length > 0 && (
                      <span className="toc-badges">
                        {translationBadges.map((lang) => (
                          <span
                            key={`${itemHref}-${lang.code}`}
                            className="toc-bdg toc-bdg-tr"
                            title={`Tłumaczenie: ${lang.name}`}
                            aria-label={`Tłumaczenie: ${lang.name}`}
                          >
                            {lang.flag}
                          </span>
                        ))}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </aside>

      <div
        className={`sb-overlay ${sidebarOpen ? "open" : ""}`}
        onClick={onClose}
      />
    </>
  );
}
