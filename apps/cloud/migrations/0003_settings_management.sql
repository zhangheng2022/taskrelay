-- 设置资源生命周期与偏好快照。停用事务同时结束旧任务，新交办由触发器兜底拦截。
-- 模型是否允许新交办使用，已有配置默认启用。
ALTER TABLE models ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1));
-- 本次管理操作标识，用于事务内关联停止范围。
ALTER TABLE models ADD COLUMN management_token TEXT;
-- 管理修订号，拒绝过期的状态和配置修改。
ALTER TABLE models ADD COLUMN management_version INTEGER NOT NULL DEFAULT 1;
-- 账号是否允许新交办使用，已有账号默认启用。
ALTER TABLE accounts ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1));
-- 本次管理操作标识，用于事务内关联停止范围。
ALTER TABLE accounts ADD COLUMN management_token TEXT;
-- 管理修订号，拒绝过期的状态和配置修改。
ALTER TABLE accounts ADD COLUMN management_version INTEGER NOT NULL DEFAULT 1;
-- 是否允许新交办使用，旧记忆默认停用。
ALTER TABLE ai_memories ADD COLUMN enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1));
-- 偏好修订号，用于编辑冲突检测。
ALTER TABLE ai_memories ADD COLUMN version INTEGER NOT NULL DEFAULT 1;

-- 每次交办独立的加密偏好快照，随所属聊天清理。
CREATE TABLE preference_snapshots (
  -- 交办或手动重跑的唯一快照标识。
  id TEXT PRIMARY KEY NOT NULL,
  -- 快照所属用户，解密前校验归属。
  owner TEXT NOT NULL REFERENCES members(id),
  -- 所属聊天，关闭后禁止读取。
  thread_id TEXT NOT NULL REFERENCES ai_threads(id),
  -- AES 密文；AAD preferences:<owner>:<id>，正文不进入任务定义。
  value TEXT NOT NULL,
  -- 首次固定快照的时间。
  created_at INTEGER NOT NULL
);
-- 按聊天定位并清理快照。
CREATE INDEX preference_snapshots_thread ON preference_snapshots(thread_id);
-- 偏好按创建时间和标识稳定分页。
CREATE INDEX memory_page ON ai_memories(owner,namespace,created_at DESC,key DESC);

CREATE TRIGGER new_command_resources BEFORE INSERT ON conversation_commands
WHEN NEW.run_task IS NOT NULL AND NOT EXISTS(SELECT 1 FROM conversation_commands WHERE id=NEW.id)
BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM models WHERE id=json_extract(NEW.run_task,'$.modelId') AND enabled=1)
    THEN RAISE(ABORT,'MODEL_DISABLED') END;
  SELECT CASE WHEN EXISTS(
    SELECT value FROM json_each(NEW.run_task,'$.accountIds') WHERE value IS NOT NULL AND NOT EXISTS(
      SELECT 1 FROM accounts a JOIN ai_threads t ON t.user_id=a.user_id WHERE a.id=value AND a.enabled=1 AND t.id=NEW.thread_id))
    OR (json_extract(NEW.run_task,'$.accountId') IS NOT NULL AND NOT EXISTS(
      SELECT 1 FROM accounts a JOIN ai_threads t ON t.user_id=a.user_id WHERE a.id=json_extract(NEW.run_task,'$.accountId') AND a.enabled=1 AND t.id=NEW.thread_id))
    THEN RAISE(ABORT,'ACCOUNT_DISABLED') END;
END;

CREATE TRIGGER new_direct_run_resources BEFORE INSERT ON runs
WHEN NEW.dispatch_group_id IS NULL AND NOT EXISTS(SELECT 1 FROM runs WHERE idempotency_key=NEW.idempotency_key)
BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM accounts WHERE id=NEW.account_id AND enabled=0)
    THEN RAISE(ABORT,'ACCOUNT_DISABLED') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM task_versions t JOIN models m ON m.id=t.model_id
    WHERE t.task_id=NEW.task_id AND t.version=NEW.task_version AND m.enabled=0)
    THEN RAISE(ABORT,'MODEL_DISABLED') END;
END;

-- 管理版本覆盖配置变更，防止旧列表的停用/删除覆盖刚保存的新配置。
CREATE TRIGGER model_management_revision AFTER UPDATE OF current_version ON models
WHEN NEW.current_version<>OLD.current_version
BEGIN UPDATE models SET management_version=management_version+1 WHERE id=NEW.id; END;
CREATE TRIGGER account_management_revision AFTER UPDATE OF name,credential_version ON accounts
WHEN NEW.name<>OLD.name OR NEW.credential_version<>OLD.credential_version
BEGIN UPDATE accounts SET management_version=management_version+1 WHERE id=NEW.id; END;

-- 列表已支持完整分页，不再以 100 条硬上限代替上下文预算。
DROP TRIGGER memory_limit;

-- JSON 内的引用也在提交事务内核对，删除先赢时不得创建悬空任务。
CREATE TRIGGER new_task_resources BEFORE INSERT ON task_versions
WHEN NOT EXISTS(SELECT 1 FROM task_versions WHERE task_id=NEW.task_id AND version=NEW.version)
BEGIN
  SELECT CASE WHEN NEW.model_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM models WHERE id=NEW.model_id AND enabled=1)
    THEN RAISE(ABORT,'MODEL_DISABLED') END;
  SELECT CASE WHEN EXISTS(
    SELECT value FROM json_each(NEW.definition,'$.accountIds') WHERE value IS NOT NULL AND NOT EXISTS(
      SELECT 1 FROM accounts WHERE id=value AND user_id=NEW.user_id AND enabled=1))
    OR (json_extract(NEW.definition,'$.accountId') IS NOT NULL AND NOT EXISTS(
      SELECT 1 FROM accounts WHERE id=json_extract(NEW.definition,'$.accountId') AND user_id=NEW.user_id AND enabled=1))
    THEN RAISE(ABORT,'ACCOUNT_DISABLED') END;
END;
