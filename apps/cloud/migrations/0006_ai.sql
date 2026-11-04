-- Schema only. Destructive cutover is an explicit, guarded operation.
CREATE TABLE ai_threads (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES members(id), task_id TEXT,
 kind TEXT NOT NULL CHECK(kind IN ('compose','chat')), model_id TEXT NOT NULL, model_version INTEGER NOT NULL,
 version INTEGER NOT NULL DEFAULT 0, active_turn TEXT, draft TEXT, partial TEXT NOT NULL DEFAULT '{}',
 summary TEXT NOT NULL DEFAULT '', summary_seq INTEGER NOT NULL DEFAULT 0,
 origins TEXT NOT NULL DEFAULT '[]', closed INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX ai_threads_owner ON ai_threads(user_id,kind,updated_at);
CREATE UNIQUE INDEX ai_task_chat ON ai_threads(user_id,task_id) WHERE kind='chat' AND closed=0;
CREATE TABLE ai_turns (
 id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES ai_threads(id) ON DELETE CASCADE,
 request_id TEXT NOT NULL, digest TEXT NOT NULL, version INTEGER NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('running','done','failed','unknown','cancelled')),
 result TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(thread_id,request_id)
);
CREATE TABLE ai_messages (
 id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES ai_threads(id) ON DELETE CASCADE,
 seq INTEGER NOT NULL, role TEXT NOT NULL CHECK(role IN ('user','assistant')), content TEXT NOT NULL,
 turn_id TEXT NOT NULL, at TEXT NOT NULL, UNIQUE(thread_id,seq)
);
CREATE TABLE ai_checkpoints (
 owner TEXT NOT NULL, thread TEXT NOT NULL, ns TEXT NOT NULL, id TEXT NOT NULL,
 parent TEXT, checkpoint TEXT NOT NULL, metadata TEXT NOT NULL, at TEXT NOT NULL,
 PRIMARY KEY(owner,thread,ns,id)
);
CREATE TABLE ai_writes (
 owner TEXT NOT NULL, thread TEXT NOT NULL, ns TEXT NOT NULL, checkpoint TEXT NOT NULL,
 task TEXT NOT NULL, path TEXT NOT NULL, idx INTEGER NOT NULL, channel TEXT NOT NULL, value TEXT NOT NULL,
 PRIMARY KEY(owner,thread,ns,checkpoint,task,idx)
);
CREATE TABLE ai_memories (
 owner TEXT NOT NULL REFERENCES members(id), namespace TEXT NOT NULL, key TEXT NOT NULL,
 value TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(owner,namespace,key)
);
CREATE TABLE ai_calls (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES members(id), graph_id TEXT, digest TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('reserved','running','done','failed','unknown')),
 result TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE quota_carry (user_id TEXT NOT NULL, day TEXT NOT NULL, runs INTEGER NOT NULL, PRIMARY KEY(user_id,day));
INSERT INTO settings(key,value) VALUES('maintenance','0');
CREATE TABLE ai_graph_inputs(owner TEXT NOT NULL,id TEXT NOT NULL,digest TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1,parent_thread TEXT,parent_turn TEXT,created_at TEXT NOT NULL,PRIMARY KEY(owner,id));
CREATE TABLE ai_plan_steps(run_id TEXT NOT NULL,epoch INTEGER NOT NULL,step_id TEXT NOT NULL,observation_id TEXT NOT NULL,PRIMARY KEY(run_id,epoch,step_id));

-- Retained usage survives the explicitly authorized history reset.
CREATE TRIGGER claim_carry_guard BEFORE UPDATE OF status ON runs
WHEN OLD.status='queued' AND NEW.status='running'
BEGIN
 SELECT CASE WHEN (SELECT COUNT(*) FROM runs WHERE user_id=NEW.user_id AND started_day=NEW.started_day) + COALESCE((SELECT runs FROM quota_carry WHERE user_id=NEW.user_id AND day=NEW.started_day),0) >= (SELECT daily_runs FROM members WHERE id=NEW.user_id) THEN RAISE(ABORT,'RUN_QUOTA_EXCEEDED') END;
END;
CREATE TRIGGER memory_limit BEFORE INSERT ON ai_memories
WHEN NOT EXISTS(SELECT 1 FROM ai_memories WHERE owner=NEW.owner AND namespace=NEW.namespace AND key=NEW.key)
BEGIN
 SELECT CASE WHEN (SELECT COUNT(*) FROM ai_memories WHERE owner=NEW.owner)>=100 THEN RAISE(ABORT,'MEMORY_LIMIT') END;
END;

ALTER TABLE devices ADD COLUMN cutover_ready_at TEXT;
CREATE TABLE ai_cutovers(id TEXT PRIMARY KEY,at TEXT NOT NULL,counts TEXT NOT NULL,guard INTEGER NOT NULL CHECK(guard=1));
