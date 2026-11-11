-- 发布排空后的最终检查与迁移同事务，阻止准备窗口中新入队的任务被遗留。
CREATE TABLE gateway_cutover_guard (
  -- 只允许空队列切换，失败由发布恢复入口处理。
  queued INTEGER NOT NULL CHECK(queued=0)
);
INSERT INTO gateway_cutover_guard SELECT count(*) FROM runs WHERE status='queued';
DROP TABLE gateway_cutover_guard;
-- 平台与个人连接共享存储，归属和上游目的地不可变。旧模型只作历史引用。
CREATE TABLE model_connections (
  -- 连接身份，由服务端生成。
  id TEXT PRIMARY KEY,
  -- 所属成员，空值表示平台。
  owner_user_id TEXT REFERENCES members(id),
  -- 连接显示名称。
  name TEXT NOT NULL,
  -- 网关调用方式。
  kind TEXT NOT NULL CHECK(kind IN ('provider','custom','workers-ai')),
  -- 专属端点供应商标识。
  provider TEXT NOT NULL,
  -- 自定义公网服务地址和路径前缀。
  upstream TEXT,
  -- 托管密钥别名。
  key_alias TEXT,
  -- 配置服务已核验该网关内的供应商、别名与目的地址。
  binding_verified INTEGER NOT NULL DEFAULT 0 CHECK(binding_verified IN (0,1)),
  -- 新模型版本默认请求发起区域。
  default_region TEXT NOT NULL CHECK(default_region IN ('auto','us','eu')),
  CHECK((kind='workers-ai')=(key_alias IS NULL)),
  CHECK((kind='custom')=(upstream IS NOT NULL))
);
-- 按所有者列出连接。
CREATE INDEX model_connections_owner ON model_connections(owner_user_id);
-- 同一供应商的密钥引用唯一。
CREATE UNIQUE INDEX model_connections_alias ON model_connections(provider,key_alias) WHERE key_alias IS NOT NULL;
-- 自定义路由仅绑定一个目的地址。
CREATE UNIQUE INDEX model_custom_routes ON model_connections(provider) WHERE kind='custom';
CREATE TRIGGER model_connection_identity BEFORE UPDATE OF id,owner_user_id,kind,provider,upstream,key_alias ON model_connections
BEGIN SELECT RAISE(ABORT,'MODEL_CONNECTION_IMMUTABLE'); END;
-- 所属成员，空值为平台模型。
ALTER TABLE models ADD COLUMN owner_user_id TEXT REFERENCES members(id);
-- 按成员列出可用模型。
CREATE INDEX models_owner ON models(owner_user_id);
CREATE TRIGGER model_owner_immutable BEFORE UPDATE OF owner_user_id ON models
BEGIN SELECT RAISE(ABORT,'MODEL_OWNER_IMMUTABLE'); END;
ALTER TABLE model_profile_versions DROP COLUMN secret;
-- 固定版本关联的网关连接。
ALTER TABLE model_profile_versions ADD COLUMN connection_id TEXT REFERENCES model_connections(id);
-- 发布时确定的请求发起区域。
ALTER TABLE model_profile_versions ADD COLUMN effective_region TEXT CHECK(effective_region IN ('auto','us','eu'));
UPDATE models SET enabled=0;
UPDATE tasks SET status='paused',next_run_at=NULL WHERE deleted=0 AND EXISTS(
 SELECT 1 FROM task_versions v WHERE v.task_id=tasks.id AND v.version=tasks.version AND v.model_id IS NOT NULL
);
UPDATE task_schedules SET state='paused', next_run_at=NULL, version=version+1 WHERE state='enabled';
CREATE TRIGGER model_version_connection BEFORE INSERT ON model_profile_versions
WHEN NEW.effective_region IS NULL OR NOT EXISTS(SELECT 1 FROM model_connections c WHERE c.id=NEW.connection_id
 AND c.owner_user_id IS (SELECT owner_user_id FROM models WHERE id=NEW.id))
BEGIN SELECT RAISE(ABORT,'MODEL_CONNECTION_NOT_FOUND'); END;
CREATE TRIGGER model_version_route_immutable BEFORE UPDATE OF connection_id,effective_region ON model_profile_versions
BEGIN SELECT RAISE(ABORT,'MODEL_CONNECTION_IMMUTABLE'); END;
CREATE TRIGGER model_task_owner BEFORE INSERT ON task_versions
WHEN EXISTS(SELECT 1 FROM models WHERE id=NEW.model_id AND owner_user_id IS NOT NULL AND owner_user_id<>NEW.user_id)
BEGIN SELECT RAISE(ABORT,'MODEL_NOT_FOUND'); END;
CREATE TRIGGER model_run_owner BEFORE INSERT ON runs
WHEN EXISTS(SELECT 1 FROM task_versions v JOIN models m ON m.id=v.model_id WHERE v.task_id=NEW.task_id
 AND v.version=NEW.task_version AND m.owner_user_id IS NOT NULL AND m.owner_user_id<>NEW.user_id)
BEGIN SELECT RAISE(ABORT,'MODEL_NOT_FOUND'); END;
