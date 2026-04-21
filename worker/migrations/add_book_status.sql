-- Run: wrangler d1 execute reader-db --file=worker/migrations/add_book_status.sql --remote
ALTER TABLE book_manifest ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
