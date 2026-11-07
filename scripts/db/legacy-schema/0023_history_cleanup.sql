-- 迁移前关闭领取/交办并等待活动请求结束；数据库也拒绝在活动窗口退休旧缓存。
CREATE TABLE history_cleanup_migration_guard(ok INTEGER NOT NULL CHECK(ok=1));
INSERT INTO history_cleanup_migration_guard SELECT CASE WHEN
 EXISTS(SELECT 1 FROM runs WHERE status IN ('queued','running','waiting_user','verifying')) OR
 EXISTS(SELECT 1 FROM ai_turns WHERE status='running') OR
 EXISTS(SELECT 1 FROM ai_calls WHERE status IN ('reserved','running')) THEN 0 ELSE 1 END;
DROP TABLE history_cleanup_migration_guard;
-- 关闭与清理分开：请求事务固定目标，Scheduler 分批回收正文，重试不扩大范围。
ALTER TABLE tasks ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0,1));
ALTER TABLE runs ADD COLUMN history_deleted INTEGER NOT NULL DEFAULT 0 CHECK(history_deleted IN (0,1));
CREATE TABLE history_cleanup_jobs (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL, request_id TEXT NOT NULL,
 scope TEXT NOT NULL, target_id TEXT, status TEXT NOT NULL DEFAULT 'capturing',
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, error TEXT,
 UNIQUE(user_id,request_id)
);
CREATE TABLE history_cleanup_targets (
 job_id TEXT NOT NULL REFERENCES history_cleanup_jobs(id), kind TEXT NOT NULL,
 resource_id TEXT NOT NULL, cutoff_version INTEGER, done INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(job_id,kind,resource_id)
);
CREATE INDEX history_cleanup_pending ON history_cleanup_jobs(status,updated_at);
CREATE INDEX history_cleanup_target_pending ON history_cleanup_targets(job_id,done);
CREATE INDEX history_cleanup_resource ON history_cleanup_targets(kind,resource_id);

-- 已在途的旧版本请求也不能重新发布已清理运行的业务正文。
CREATE TRIGGER cleanup_run_events_insert BEFORE INSERT ON run_events
 WHEN EXISTS(SELECT 1 FROM runs WHERE id=NEW.run_id AND history_deleted=1)
 BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER cleanup_run_events_update BEFORE UPDATE ON run_events
 WHEN EXISTS(SELECT 1 FROM runs WHERE id=NEW.run_id AND history_deleted=1)
 BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER cleanup_challenges_insert BEFORE INSERT ON challenges
 WHEN EXISTS(SELECT 1 FROM runs WHERE id=NEW.run_id AND history_deleted=1)
 BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER cleanup_challenges_update BEFORE UPDATE ON challenges
 WHEN EXISTS(SELECT 1 FROM runs WHERE id=NEW.run_id AND history_deleted=1)
 BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER cleanup_batch_progress_insert BEFORE INSERT ON batch_progress
 WHEN EXISTS(SELECT 1 FROM runs WHERE id=NEW.run_id AND history_deleted=1)
 BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER cleanup_batch_progress_update BEFORE UPDATE ON batch_progress
 WHEN EXISTS(SELECT 1 FROM runs WHERE id=NEW.run_id AND history_deleted=1)
 BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER cleanup_run_conditions_insert BEFORE INSERT ON run_conditions
 WHEN EXISTS(SELECT 1 FROM runs WHERE id=NEW.run_id AND history_deleted=1)
 BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER cleanup_run_conditions_update BEFORE UPDATE ON run_conditions
 WHEN EXISTS(SELECT 1 FROM runs WHERE id=NEW.run_id AND history_deleted=1)
 BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER cleanup_execution_help_insert BEFORE INSERT ON execution_help
 WHEN EXISTS(SELECT 1 FROM runs WHERE id=NEW.run_id AND history_deleted=1)
 BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER cleanup_execution_help_update BEFORE UPDATE ON execution_help
 WHEN EXISTS(SELECT 1 FROM runs WHERE id=NEW.run_id AND history_deleted=1)
 BEGIN SELECT RAISE(IGNORE); END;

-- 模型缓存必须可按运行回收；旧版没有记录归属的响应只保留防重摘要。
-- 生产迁移须在没有活动运行/推理的窗口执行，避免丢弃在途请求的可重用结果。
ALTER TABLE ai_calls ADD COLUMN run_id TEXT;
UPDATE ai_calls SET run_id=(SELECT r.id FROM runs r WHERE r.user_id=ai_calls.user_id
 AND (instr(ai_calls.id,'execute_'||r.id||'_')=1 OR instr(ai_calls.id,'stagehand_'||r.id||'_')=1) LIMIT 1)
 WHERE graph_id IS NULL;
UPDATE ai_calls SET run_id=(SELECT g.run_id FROM ai_graph_inputs g WHERE g.id=ai_calls.graph_id AND g.owner=ai_calls.user_id LIMIT 1)
 WHERE graph_id IS NOT NULL;
UPDATE ai_calls SET result=NULL,status='unknown',error='LEGACY_CACHE_RETIRED'
 WHERE graph_id IS NULL AND run_id IS NULL;
CREATE INDEX ai_calls_run ON ai_calls(run_id);
