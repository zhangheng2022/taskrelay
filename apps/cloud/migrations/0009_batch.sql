-- Additive: retain existing task definitions and local client data.
CREATE TABLE batch_progress (
  run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  epoch INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  ciphertext TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
ALTER TABLE actions ADD COLUMN batch_item_id TEXT;
ALTER TABLE actions ADD COLUMN batch_terminal INTEGER NOT NULL DEFAULT 0;
