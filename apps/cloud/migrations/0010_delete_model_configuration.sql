-- 模型配置删除时点。已删除且有外键的版本仅保留身份，历史聊天、运行和用量继续归属于原用户。
ALTER TABLE models ADD COLUMN deleted_at INTEGER;

-- 活版本的路由不可变。仅当模型已删除时，允许把版本清空为无路由的历史标识。
DROP TRIGGER model_version_route_immutable;
CREATE TRIGGER model_version_route_immutable BEFORE UPDATE OF connection_id,effective_region ON model_profile_versions
WHEN NOT (NEW.connection_id IS NULL AND NEW.effective_region IS NULL AND NEW.config='{}' AND NEW.capabilities='{}'
  AND EXISTS(SELECT 1 FROM models WHERE id=OLD.id AND enabled=0 AND deleted_at IS NOT NULL))
BEGIN SELECT RAISE(ABORT,'MODEL_CONNECTION_IMMUTABLE'); END;

-- 删除在带管理版本的单条更新中提交。先固化费用，再释放配置；有历史的启用模型先经正常停用流程收尾。
CREATE TRIGGER delete_model_configuration AFTER UPDATE OF deleted_at ON models
WHEN OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL
BEGIN
  SELECT CASE WHEN OLD.enabled=1 AND (
    EXISTS(SELECT 1 FROM task_versions WHERE model_id=OLD.id)
    OR EXISTS(SELECT 1 FROM ai_threads WHERE model_id=OLD.id)
    OR EXISTS(SELECT 1 FROM model_usage WHERE model_id=OLD.id))
  THEN RAISE(ABORT,'MODEL_DISABLE_BEFORE_DELETE') END;

  UPDATE model_usage SET retired_cost=(
    SELECT (model_usage.input_tokens*json_extract(v.config,'$.inputPrice')+model_usage.output_tokens*json_extract(v.config,'$.outputPrice'))/1000000.0
    FROM model_profile_versions v WHERE v.id=OLD.id AND v.version=model_usage.model_version
  ) WHERE model_id=OLD.id AND model_version IN (SELECT version FROM model_profile_versions WHERE id=OLD.id AND connection_id IS NOT NULL);

  DELETE FROM models WHERE id=OLD.id
    AND NOT EXISTS(SELECT 1 FROM task_versions WHERE model_id=OLD.id)
    AND NOT EXISTS(SELECT 1 FROM ai_threads WHERE model_id=OLD.id);

  DELETE FROM model_profile_versions WHERE id=OLD.id
    AND NOT EXISTS(SELECT 1 FROM models m WHERE m.id=OLD.id AND m.current_version=model_profile_versions.version)
    AND NOT EXISTS(SELECT 1 FROM task_versions t WHERE t.model_id=OLD.id AND t.model_version=model_profile_versions.version)
    AND NOT EXISTS(SELECT 1 FROM ai_threads h WHERE h.model_id=OLD.id AND h.model_version=model_profile_versions.version);
  UPDATE model_profile_versions SET config='{}',capabilities='{}',connection_id=NULL,effective_region=NULL WHERE id=OLD.id;
END;
