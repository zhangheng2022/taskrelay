-- 清理 Chat 版本和接入网关前的直连配置。目标按版本选取，保留共用连接及独立 Responses 版本。
CREATE TABLE model_cleanup_targets (
  id TEXT NOT NULL, version INTEGER NOT NULL, keep_identity INTEGER NOT NULL,
  PRIMARY KEY(id,version)
);
INSERT INTO model_cleanup_targets
SELECT v.id,v.version,
  EXISTS(SELECT 1 FROM task_versions t WHERE (t.model_id,t.model_version)=(v.id,v.version))
  OR EXISTS(SELECT 1 FROM ai_threads h WHERE (h.model_id,h.model_version)=(v.id,v.version))
FROM model_profile_versions v WHERE v.connection_id IS NULL OR json_extract(v.config,'$.protocol') IS NOT 'responses';

-- 旧用量不依赖设置存活；在擦除配置前按原单价固化已记录的费用，未知值保持 NULL。
ALTER TABLE model_usage ADD COLUMN retired_cost REAL;
UPDATE model_usage AS u SET retired_cost=(
  SELECT (u.input_tokens*json_extract(v.config,'$.inputPrice')+u.output_tokens*json_extract(v.config,'$.outputPrice'))/1000000.0
  FROM model_profile_versions v WHERE (v.id,v.version)=(u.model_id,u.model_version)
) WHERE (model_id,model_version) IN (SELECT id,version FROM model_cleanup_targets);

-- 某个旧头还有其他存活版本时，保留无配置的头以满足双向外键，避免悄悄把旧任务改绑到其他版本。
UPDATE model_cleanup_targets AS x SET keep_identity=1
WHERE (x.id,x.version) IN (SELECT id,current_version FROM models) AND EXISTS(
  SELECT 1 FROM model_profile_versions v LEFT JOIN model_cleanup_targets y ON y.id=v.id AND y.version=v.version
  WHERE v.id=x.id AND v.version<>x.version AND (y.id IS NULL OR y.keep_identity=1)
);
UPDATE models SET enabled=0 WHERE (id,current_version) IN (SELECT id,version FROM model_cleanup_targets);
DELETE FROM models WHERE (id,current_version) IN (SELECT id,version FROM model_cleanup_targets WHERE keep_identity=0);
DELETE FROM model_profile_versions WHERE (id,version) IN (SELECT id,version FROM model_cleanup_targets WHERE keep_identity=0);

-- 仅迁移事务可以解除旧路由。有聊天或任务外键的版本只留下身份，无法读出、编辑或用于推理。
DROP TRIGGER model_version_route_immutable;
UPDATE model_profile_versions SET config='{}',capabilities='{}',connection_id=NULL,effective_region=NULL
WHERE (id,version) IN (SELECT id,version FROM model_cleanup_targets WHERE keep_identity=1);
CREATE TRIGGER model_version_route_immutable BEFORE UPDATE OF connection_id,effective_region ON model_profile_versions
BEGIN SELECT RAISE(ABORT,'MODEL_CONNECTION_IMMUTABLE'); END;
DROP TABLE model_cleanup_targets;
