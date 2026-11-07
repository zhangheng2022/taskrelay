-- Observed interface controls may be used again. Potential writes still acquire
-- write_pending atomically; committed business submissions retain a unique key.
DROP INDEX actions_write_fingerprint;
CREATE INDEX actions_fingerprint ON actions(run_id,fingerprint);
CREATE UNIQUE INDEX actions_submission_fingerprint ON actions(run_id,fingerprint)
  WHERE effect='write' AND batch_terminal=1 AND fingerprint IS NOT NULL;
