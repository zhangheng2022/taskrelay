ALTER TABLE runs ADD COLUMN may_have_written INTEGER NOT NULL DEFAULT 0;
UPDATE runs SET may_have_written=1 WHERE write_pending=1 OR EXISTS(SELECT 1 FROM actions WHERE actions.run_id=runs.id AND effect='write');
ALTER TABLE actions ADD COLUMN fingerprint TEXT;
CREATE UNIQUE INDEX actions_write_fingerprint ON actions(run_id,fingerprint) WHERE effect='write' AND fingerprint IS NOT NULL;
