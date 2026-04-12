export default function ReaderSearchPanel({
  inputRef,
  searchQuery,
  onSearchQueryChange,
  searchMatches,
  activeSearchIdx,
  onGoToSearchMatch,
  onClose,
}) {
  const hasQuery = Boolean(searchQuery.trim());

  return (
    <div className="reader-search-strip">
      <div className="reader-search-main">
        <input
          ref={inputRef}
          className="reader-search-input"
          type="search"
          value={searchQuery}
          onChange={(event) => onSearchQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            if (!searchMatches.length) return;
            onGoToSearchMatch(activeSearchIdx + (event.shiftKey ? -1 : 1));
          }}
          placeholder="Szukaj tekstu w tym rozdziale"
        />

        <div className="reader-search-meta">
          {hasQuery
            ? searchMatches.length
              ? `${activeSearchIdx + 1}/${searchMatches.length}`
              : "0 wyników"
            : "Wpisz frazę"}
        </div>

        <button
          className="ctl ctl-icon"
          onClick={() => onGoToSearchMatch(activeSearchIdx - 1)}
          disabled={!searchMatches.length}
          title="Poprzedni wynik"
        >
          {"<"}
        </button>
        <button
          className="ctl ctl-icon"
          onClick={() => onGoToSearchMatch(activeSearchIdx + 1)}
          disabled={!searchMatches.length}
          title="Następny wynik"
        >
          {">"}
        </button>
        <button className="ctl ctl-icon" onClick={onClose} title="Zamknij wyszukiwanie">
          x
        </button>
      </div>

      {hasQuery && (
        <div className="reader-search-results">
          {searchMatches.length ? (
            searchMatches.map((match, index) => (
              <button
                key={`${match.blockId}-${index}`}
                type="button"
                className={`reader-search-result${
                  index === activeSearchIdx ? " active" : ""
                }`}
                onClick={() => onGoToSearchMatch(index)}
              >
                <span className="reader-search-result-page">s. {match.page + 1}</span>
                <span className="reader-search-result-text">{match.preview}</span>
                {match.count > 1 && (
                  <span className="reader-search-result-count">x{match.count}</span>
                )}
              </button>
            ))
          ) : (
            <div className="reader-search-empty">Brak trafień w tym rozdziale.</div>
          )}
        </div>
      )}
    </div>
  );
}
