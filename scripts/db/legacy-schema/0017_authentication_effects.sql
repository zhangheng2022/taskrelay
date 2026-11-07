-- Existing operations remain conservatively classified as business writes.
ALTER TABLE actions ADD COLUMN authentication INTEGER NOT NULL DEFAULT 0;
ALTER TABLE challenges ADD COLUMN authentication INTEGER NOT NULL DEFAULT 0;
