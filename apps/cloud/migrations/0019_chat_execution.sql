ALTER TABLE ai_messages ADD COLUMN source TEXT NOT NULL DEFAULT 'cloud';
ALTER TABLE ai_messages ADD COLUMN parts TEXT NOT NULL DEFAULT '[]';
ALTER TABLE ai_messages ADD COLUMN run_id TEXT;
ALTER TABLE ai_messages ADD COLUMN reply_to TEXT;
ALTER TABLE runs ADD COLUMN execution_protocol INTEGER NOT NULL DEFAULT 11;
ALTER TABLE runs ADD COLUMN thread_id TEXT;
UPDATE runs SET thread_id=(SELECT id FROM ai_threads WHERE task_id=runs.task_id ORDER BY closed,created_at DESC LIMIT 1);
ALTER TABLE artifacts ADD COLUMN thread_id TEXT;
ALTER TABLE artifacts ADD COLUMN persistent INTEGER NOT NULL DEFAULT 0;
UPDATE artifacts SET thread_id=(SELECT thread_id FROM runs WHERE id=artifacts.run_id);
INSERT OR IGNORE INTO ai_messages(id,thread_id,seq,role,content,turn_id,at,source,parts,run_id)
 SELECT 'event_'||e.id,r.thread_id,
 (SELECT COALESCE(MAX(seq),0) FROM ai_messages WHERE thread_id=r.thread_id)+ROW_NUMBER() OVER(PARTITION BY r.thread_id ORDER BY e.at,e.sequence,e.id),
 'assistant',CASE WHEN e.kind='snapshot' THEN '页面截图' ELSE e.message END,'event_'||e.id,e.at,'executor',
 CASE WHEN e.kind='snapshot' AND json_valid(e.message) THEN json_array(json_object('type','image','artifactId',json_extract(e.message,'$.artifactId'),'alt','历史页面截图')) ELSE '[]' END,e.run_id
 FROM run_events e JOIN runs r ON r.id=e.run_id JOIN ai_threads t ON t.id=r.thread_id WHERE t.deleted=0;
CREATE TABLE execution_help (
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL, thread_id TEXT NOT NULL,
 epoch INTEGER NOT NULL, request TEXT NOT NULL, response TEXT,
 awaiting_user INTEGER NOT NULL DEFAULT 0, reply_message_id TEXT,
 created_at TEXT NOT NULL
);
CREATE INDEX execution_help_run ON execution_help(run_id,created_at);
CREATE TABLE account_locks_chat (account_key TEXT PRIMARY KEY, run_id TEXT NOT NULL);
INSERT INTO account_locks_chat SELECT account_key,run_id FROM account_locks;
DROP TABLE account_locks;
ALTER TABLE account_locks_chat RENAME TO account_locks;
CREATE INDEX account_locks_run ON account_locks(run_id);
DROP INDEX IF EXISTS actions_submission_fingerprint;
UPDATE conversation_inbox SET status='failed' WHERE mode='report' AND status IN ('pending','processing');
UPDATE ai_turns SET status='cancelled',error='REPORT_FLOW_RETIRED' WHERE id IN (SELECT turn_id FROM ai_dispatch WHERE mode='report') AND status='running';
UPDATE ai_threads SET active_turn=NULL WHERE active_turn IN (SELECT turn_id FROM ai_dispatch WHERE mode='report');
DELETE FROM ai_dispatch WHERE mode='report';
