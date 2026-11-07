-- A versioned graph owns orchestration; dispatch rows are durable input events.
-- Existing checkpoints and dispatch history remain readable, never resumed as v15.
ALTER TABLE ai_graph_inputs ADD COLUMN graph_version TEXT NOT NULL DEFAULT 'relay-2';
ALTER TABLE ai_graph_inputs ADD COLUMN kind TEXT NOT NULL DEFAULT 'chat';
ALTER TABLE ai_graph_inputs ADD COLUMN status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE ai_graph_inputs ADD COLUMN generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ai_graph_inputs ADD COLUMN run_id TEXT;
ALTER TABLE ai_graph_inputs ADD COLUMN lease_epoch INTEGER;
ALTER TABLE ai_graph_inputs ADD COLUMN error TEXT;
ALTER TABLE execution_help ADD COLUMN graph_id TEXT;
ALTER TABLE execution_help ADD COLUMN interrupt_id TEXT;
ALTER TABLE execution_help ADD COLUMN question_round INTEGER NOT NULL DEFAULT 0;

ALTER TABLE ai_dispatch RENAME TO ai_dispatch_v14;
CREATE TABLE ai_dispatch (
 id TEXT PRIMARY KEY, graph_id TEXT NOT NULL, thread_id TEXT NOT NULL,
 owner TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('chat','help','resume','refresh','legacy')),
 turn_id TEXT, run_id TEXT, help_id TEXT, message_id TEXT, interrupt_id TEXT,
 question_round INTEGER, state TEXT NOT NULL DEFAULT 'pending'
 CHECK(state IN ('pending','running','done','failed','retired')),
 lease_until TEXT, error TEXT, created_at TEXT NOT NULL
);
INSERT INTO ai_dispatch(id,graph_id,thread_id,owner,kind,turn_id,state,created_at)
 SELECT turn_id,turn_id,thread_id,owner,'legacy',turn_id,'retired',strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM ai_dispatch_v14;
DROP TABLE ai_dispatch_v14;
CREATE INDEX ai_dispatch_ready ON ai_dispatch(state,graph_id,created_at);
