-- Owner-visible assistance history is separate from all model conversation inputs.
CREATE TABLE assistance_replies (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 challenge_id TEXT NOT NULL UNIQUE REFERENCES challenges(id) ON DELETE CASCADE,
 run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
 thread_id TEXT REFERENCES ai_threads(id) ON DELETE CASCADE,
 content_secret TEXT NOT NULL,
 created_at TEXT NOT NULL
);
CREATE INDEX assistance_replies_thread ON assistance_replies(thread_id,id);
