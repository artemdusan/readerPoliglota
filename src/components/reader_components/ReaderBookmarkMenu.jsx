export default function ReaderBookmarkMenu({
  menuRef,
  hasCurrentPageBookmark,
  currentPage,
  totalPages,
  bookmarkList,
  onAddBookmark,
  onJumpToBookmark,
  onRemoveBookmark,
  formatBookmarkProgress,
}) {
  const currentProgress =
    totalPages > 1
      ? Math.round(((currentPage / (totalPages - 1)) + Number.EPSILON) * 100)
      : 0;

  return (
    <div className="bookmark-menu" ref={menuRef}>
      <div className="bookmark-menu-head">
        <div>
          <div className="bookmark-menu-title">Zakładki</div>
          <div className="bookmark-menu-sub">
            Zapisz bieżący postęp i zsynchronizuj go z kontem.
          </div>
        </div>
      </div>

      <button
        type="button"
        className={`bookmark-save-btn${hasCurrentPageBookmark ? " active" : ""}`}
        onClick={onAddBookmark}
        title="Zapisz zakładkę"
      >
        <span className="bookmark-save-btn-label">
          {hasCurrentPageBookmark ? "Zapisano ten postęp" : "Zapisz zakładkę"}
        </span>
        <span className="bookmark-save-btn-meta">
          Postęp {currentProgress}%
        </span>
      </button>

      <div className="bookmark-menu-list">
        {bookmarkList.length ? (
          bookmarkList.map((bookmark) => (
            <div key={bookmark.id} className="bookmark-item">
              <button
                type="button"
                className="bookmark-item-main"
                onClick={() => onJumpToBookmark(bookmark)}
              >
                <span className="bookmark-item-copy">
                  <span className="bookmark-item-title">
                    {bookmark.chapterTitle || `Rozdział ${bookmark.chapterIndex + 1}`}
                  </span>
                  <span className="bookmark-item-meta">
                    Postęp {formatBookmarkProgress(bookmark)}
                  </span>
                  {bookmark.preview && (
                    <span className="bookmark-item-preview">{bookmark.preview}</span>
                  )}
                </span>
              </button>

              <button
                type="button"
                className="bookmark-item-remove"
                onClick={() => onRemoveBookmark(bookmark.id)}
                title="Usuń zakładkę"
                aria-label="Usuń zakładkę"
              >
                x
              </button>
            </div>
          ))
        ) : (
          <div className="bookmark-empty">Brak zapisanych zakładek.</div>
        )}
      </div>
    </div>
  );
}
