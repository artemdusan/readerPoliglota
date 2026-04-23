-- Run once: wrangler d1 execute reader-db --file=schema.sql --remote
-- After adding new tables: wrangler d1 execute reader-db --command "ALTER TABLE book_manifest ADD COLUMN meta_json TEXT" --remote

CREATE TABLE IF NOT EXISTS users (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  email      TEXT    NOT NULL UNIQUE,
  hash       TEXT    NOT NULL,   -- "saltHex:iterations:derivedKeyHex" (PBKDF2-SHA256)
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS book_manifest (
  user_id    INTEGER NOT NULL,
  book_id    TEXT    NOT NULL,
  title      TEXT    NOT NULL,
  author     TEXT    NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  deleted_at    INTEGER,            -- NULL = active; ms timestamp = soft-deleted
  chapter_count INTEGER NOT NULL DEFAULT 0,
  status        TEXT    NOT NULL DEFAULT 'active',
  PRIMARY KEY (user_id, book_id)
);

CREATE TABLE IF NOT EXISTS reading_positions (
  user_id      INTEGER NOT NULL,
  book_id      TEXT    NOT NULL,
  chapter_idx  INTEGER NOT NULL DEFAULT 0,
  scroll_top   REAL    NOT NULL DEFAULT 0,
  active_lang  TEXT,
  bookmarks_json TEXT  NOT NULL DEFAULT '[]',
  poly_mode    INTEGER NOT NULL DEFAULT 0,  -- 0/1 boolean
  sentence_idx INTEGER NOT NULL DEFAULT -1,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (user_id, book_id)
);

CREATE TABLE IF NOT EXISTS book_chapters (
  user_id       INTEGER NOT NULL,
  book_id       TEXT    NOT NULL,
  chapter_id    TEXT    NOT NULL,
  chapter_index INTEGER NOT NULL DEFAULT 0,
  href          TEXT    NOT NULL DEFAULT '',
  title         TEXT    NOT NULL DEFAULT '',
  html          TEXT    NOT NULL DEFAULT '',
  text          TEXT    NOT NULL DEFAULT '',
  PRIMARY KEY (user_id, book_id, chapter_id)
);

CREATE TABLE IF NOT EXISTS book_translations (
  user_id    INTEGER NOT NULL,
  book_id    TEXT    NOT NULL,
  chapter_id TEXT    NOT NULL,
  lang       TEXT    NOT NULL,
  format     TEXT,
  raw_text   TEXT,
  payload    TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, book_id, chapter_id, lang)
);
