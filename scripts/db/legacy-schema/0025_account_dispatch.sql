-- 固定本轮账号集合，一次只投递一个成员；执行结果与浏览器清理均确认后才推进。
CREATE TABLE account_dispatch_groups (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL, task_version INTEGER NOT NULL,
 thread_id TEXT NOT NULL, user_id TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','paused','completed','cancelled','retired')),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX account_dispatch_active ON account_dispatch_groups(state,created_at);
CREATE TABLE account_dispatch_members (
 group_id TEXT NOT NULL REFERENCES account_dispatch_groups(id) ON DELETE CASCADE,
 position INTEGER NOT NULL, account_id TEXT, run_id TEXT UNIQUE,
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','enqueued','done','cancelled')),
 PRIMARY KEY(group_id,position)
);
ALTER TABLE runs ADD COLUMN dispatch_group_id TEXT;
ALTER TABLE runs ADD COLUMN dispatch_index INTEGER;
CREATE UNIQUE INDEX run_dispatch_member ON runs(dispatch_group_id,dispatch_index) WHERE dispatch_group_id IS NOT NULL;
CREATE INDEX run_device_cleanup ON runs(device_id,cleanup_pending,status);
CREATE INDEX run_user_cleanup ON runs(user_id,cleanup_pending,status);

DROP TRIGGER claim_guard;
CREATE TRIGGER claim_guard BEFORE UPDATE OF status ON runs
WHEN OLD.status='queued' AND NEW.status='running'
BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM members WHERE id=NEW.user_id AND disabled=0) THEN RAISE(ABORT,'USER_DISABLED') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM runs WHERE id<>NEW.id AND (status IN ('running','waiting_user','verifying') OR cleanup_pending=1) AND (user_id=NEW.user_id OR device_id=NEW.device_id)) THEN RAISE(ABORT,'CLAIM_BUSY') END;
 SELECT CASE WHEN (SELECT COUNT(*) FROM runs WHERE user_id=NEW.user_id AND started_day=NEW.started_day) >= (SELECT daily_runs FROM members WHERE id=NEW.user_id)
   AND NOT EXISTS(SELECT 1 FROM members WHERE id=NEW.user_id AND (daily_quota_paused=1 OR daily_quota_paused_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))) THEN RAISE(ABORT,'RUN_QUOTA_EXCEEDED') END;
 SELECT CASE WHEN NEW.account_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM accounts WHERE id=NEW.account_id AND user_id=NEW.user_id) THEN RAISE(ABORT,'ACCOUNT_DEVICE_MISMATCH') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM devices WHERE id=NEW.device_id AND revoked=0 AND claim_ready=1) THEN RAISE(ABORT,'CLAIM_BUSY') END;
 SELECT CASE WHEN NEW.dispatch_group_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM account_dispatch_groups WHERE id=NEW.dispatch_group_id AND state='active') THEN RAISE(ABORT,'CLAIM_BUSY') END;
END;
DROP TRIGGER claim_record;
CREATE TRIGGER claim_record AFTER UPDATE OF status ON runs
WHEN OLD.status='queued' AND NEW.status='running'
BEGIN
 UPDATE members SET last_claim_at=NEW.updated_at WHERE id=NEW.user_id;
 UPDATE accounts SET assigned_device_id=NEW.device_id WHERE id=NEW.account_id AND user_id=NEW.user_id;
END;

-- 删除、撤回和停用在原事务中退休未开始成员，防止 alarm 把旧命令重新投入队列。
CREATE TRIGGER account_dispatch_thread_closed AFTER UPDATE OF closed ON ai_threads
WHEN NEW.closed=1
BEGIN
 UPDATE account_dispatch_groups SET state='retired' WHERE thread_id=NEW.id AND state IN ('active','paused');
 UPDATE account_dispatch_members SET state='cancelled' WHERE group_id IN(SELECT id FROM account_dispatch_groups WHERE thread_id=NEW.id) AND state='pending';
END;
CREATE TRIGGER account_dispatch_task_retired AFTER UPDATE OF context_withdrawn,deleted ON tasks
WHEN NEW.context_withdrawn=1 OR NEW.deleted=1
BEGIN
 UPDATE account_dispatch_groups SET state='retired' WHERE task_id=NEW.id AND state IN ('active','paused');
 UPDATE account_dispatch_members SET state='cancelled' WHERE group_id IN(SELECT id FROM account_dispatch_groups WHERE task_id=NEW.id) AND state='pending';
END;
CREATE TRIGGER account_dispatch_user_disabled AFTER UPDATE OF disabled ON members
WHEN NEW.disabled=1
BEGIN
 UPDATE account_dispatch_groups SET state='cancelled' WHERE user_id=NEW.id AND state IN ('active','paused');
 UPDATE account_dispatch_members SET state='cancelled' WHERE group_id IN(SELECT id FROM account_dispatch_groups WHERE user_id=NEW.id) AND state='pending';
END;
CREATE TRIGGER account_dispatch_task_revised AFTER UPDATE OF version ON tasks
WHEN NEW.version<>OLD.version
BEGIN
 UPDATE account_dispatch_groups SET state='retired' WHERE task_id=NEW.id AND task_version<>NEW.version AND state IN ('active','paused');
 UPDATE account_dispatch_members SET state='cancelled' WHERE group_id IN(SELECT id FROM account_dispatch_groups WHERE task_id=NEW.id AND state='retired') AND state='pending';
 UPDATE runs SET cancel_requested=1,status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END
  WHERE dispatch_group_id IN(SELECT id FROM account_dispatch_groups WHERE task_id=NEW.id AND state='retired') AND status IN ('queued','running','waiting_user','verifying');
END;
