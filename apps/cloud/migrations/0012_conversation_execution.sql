-- Preserve existing tasks, identities, profiles and run history.
ALTER TABLE runs ADD COLUMN instruction_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ai_plan_steps ADD COLUMN instruction_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN confirmed_condition TEXT;
CREATE TABLE conversation_inbox (
 ordinal INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
 thread_id TEXT NOT NULL REFERENCES ai_threads(id), request_id TEXT NOT NULL,
 digest TEXT NOT NULL, content TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'chat',
 run_id TEXT, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL,
 UNIQUE(thread_id,request_id)
);
CREATE TABLE conversation_commands (
 id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES ai_threads(id),
 task_id TEXT, run_task TEXT, state TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL
);
CREATE TABLE run_conditions (
 run_id TEXT PRIMARY KEY REFERENCES runs(id), task_id TEXT NOT NULL REFERENCES tasks(id),
 task_version INTEGER NOT NULL, instruction_version INTEGER NOT NULL,
 content TEXT NOT NULL, created_at TEXT NOT NULL, confirmed_at TEXT, approved_version INTEGER, confirmed_content TEXT
);
CREATE INDEX conversation_pending ON conversation_inbox(thread_id,status,ordinal);
CREATE INDEX conditions_task ON run_conditions(task_id,created_at);

ALTER TABLE batch_progress ADD COLUMN instruction_version INTEGER NOT NULL DEFAULT 0;
