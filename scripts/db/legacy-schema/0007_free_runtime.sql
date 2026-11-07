CREATE TABLE ai_dispatch (
 turn_id TEXT PRIMARY KEY REFERENCES ai_turns(id) ON DELETE CASCADE,
 thread_id TEXT NOT NULL REFERENCES ai_threads(id) ON DELETE CASCADE,
 owner TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('chat','report')),
 started INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX ai_dispatch_pending ON ai_dispatch(started);
CREATE TABLE platform_budget(day TEXT NOT NULL,kind TEXT NOT NULL,n INTEGER NOT NULL,PRIMARY KEY(day,kind));
