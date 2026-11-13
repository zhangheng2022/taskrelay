-- 清理接收事务会生成暂停的占位版本，沿用原任务的模型标识。只对该次捕获的版本允许沿用停用模型。
DROP TRIGGER new_task_resources;
CREATE TRIGGER new_task_resources BEFORE INSERT ON task_versions
WHEN NOT EXISTS(SELECT 1 FROM task_versions WHERE task_id=NEW.task_id AND version=NEW.version)
BEGIN
  SELECT CASE WHEN NEW.model_id IS NOT NULL
    AND NOT EXISTS(SELECT 1 FROM models WHERE id=NEW.model_id AND enabled=1)
    AND NOT EXISTS(
      SELECT 1 FROM history_cleanup_targets target
      JOIN history_cleanup_jobs job ON job.id=target.job_id
      JOIN tasks task ON task.id=target.resource_id AND task.user_id=job.user_id
      JOIN task_versions prior ON prior.task_id=task.id AND prior.version=task.version
      WHERE job.status='capturing' AND target.kind='task'
        AND task.id=NEW.task_id AND task.user_id=NEW.user_id
        AND target.cutoff_version=task.version AND NEW.version=task.version+1
        AND prior.model_id=NEW.model_id AND prior.model_version=NEW.model_version
    ) THEN RAISE(ABORT,'MODEL_DISABLED') END;
  SELECT CASE WHEN EXISTS(
    SELECT value FROM json_each(NEW.definition,'$.accountIds') WHERE value IS NOT NULL AND NOT EXISTS(
      SELECT 1 FROM accounts WHERE id=value AND user_id=NEW.user_id AND enabled=1))
    OR (json_extract(NEW.definition,'$.accountId') IS NOT NULL AND NOT EXISTS(
      SELECT 1 FROM accounts WHERE id=json_extract(NEW.definition,'$.accountId') AND user_id=NEW.user_id AND enabled=1))
    THEN RAISE(ABORT,'ACCOUNT_DISABLED') END;
END;
