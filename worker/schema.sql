-- Run once: wrangler d1 execute vocabapp-db --file=schema.sql --remote
-- Migration (run separately if DB already exists):
--   wrangler d1 execute vocabapp-db --command="ALTER TABLE book_manifest ADD COLUMN chapter_count INTEGER NOT NULL DEFAULT 0" --remote

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
  PRIMARY KEY (user_id, book_id)
);

CREATE TABLE IF NOT EXISTS reading_positions (
  user_id      INTEGER NOT NULL,
  book_id      TEXT    NOT NULL,
  chapter_idx  INTEGER NOT NULL DEFAULT 0,
  scroll_top   REAL    NOT NULL DEFAULT 0,
  poly_mode    INTEGER NOT NULL DEFAULT 0,  -- 0/1 boolean
  sentence_idx INTEGER NOT NULL DEFAULT -1,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (user_id, book_id)
);
