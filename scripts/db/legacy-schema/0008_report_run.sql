-- Bind each report to a particular run, including asynchronous execution/retries.
-- Nullable for existing chat turns; never infer a historical report's target at execution time.
ALTER TABLE ai_turns ADD COLUMN run_id TEXT;
