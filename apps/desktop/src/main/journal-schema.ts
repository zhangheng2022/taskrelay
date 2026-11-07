/** Main 本地 schema 4：SQL 是结构权威。配置内的设备令牌仍为 safeStorage 密文；
 * journal/outbox 保存既有执行事实，恢复不能把检查点当作浏览器操作重放脚本。 */
export const journalSchema = `
BEGIN IMMEDIATE;
-- 本机配置；由 Main 读写，设备令牌为 safeStorage 密文，不由 Renderer 读取。
CREATE TABLE config (
  -- 配置项稳定名称。
  key TEXT PRIMARY KEY NOT NULL,
  -- JSON 配置值；清理业务历史时保留。
  value TEXT NOT NULL CHECK(json_valid(value))
);
-- 可重建的本机缓存；不拥有调度权或租约，不迁移旧缓存。
CREATE TABLE cache (
  -- 缓存项名称。
  key TEXT PRIMARY KEY NOT NULL,
  -- JSON 缓存值，格式由对应 Main 入口校验。
  value TEXT NOT NULL CHECK(json_valid(value))
);
-- 执行检查点；归 Main 所有，保留 generation、epoch 和未知结果身份。
CREATE TABLE journal (
  -- 云端运行 ID；同运行仅保存最近一次检查点。
  run_id TEXT PRIMARY KEY NOT NULL,
  -- 本次 utilityProcess generation；旧代次消息必须拒绝。
  generation TEXT NOT NULL,
  -- 云端租约代次。
  epoch INTEGER NOT NULL CHECK(epoch>=0),
  -- 检查点状态；finished/abandoned 不参与未完成恢复查询。
  state TEXT NOT NULL,
  -- 执行事实 JSON；格式由 ExecutorHost 和执行器协议校验，不得加入平台密钥。
  payload TEXT NOT NULL CHECK(json_valid(payload)),
  -- 最近写入 UTC Unix 毫秒，诊断接口转换为 ISO 时间。
  updated_at INTEGER NOT NULL CHECK(typeof(updated_at)='integer')
);
-- 未确认的云端事实回执；网络失败继续使用原 ID，确认后才删除。
CREATE TABLE outbox (
  -- 同次提交的稳定幂等 ID。
  id TEXT PRIMARY KEY NOT NULL,
  -- 既有命名云端接口路径；不接受网页指定的任意主机地址。
  path TEXT NOT NULL,
  -- 事实回执 JSON，保留原租约 epoch 和请求身份。
  body TEXT NOT NULL CHECK(json_valid(body)),
  -- 入队 UTC Unix 毫秒；只用于事实时点，不作为发送顺序。
  created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer'),
  -- 本机 outbox 内的入队顺序；同毫秒或系统时钟回拨也必须先发送较早事实。
  ordinal INTEGER NOT NULL CHECK(ordinal>0)
);
-- 恢复仅扫描未完成检查点，终态历史增长不增加恢复扫描量。
CREATE INDEX journal_open ON journal(updated_at,run_id) WHERE state NOT IN ('finished','abandoned');
-- 有界诊断读取最新 30 条，避免扫描并排序全部历史。
CREATE INDEX journal_latest ON journal(updated_at DESC,run_id DESC);
-- FIFO 顺序唯一索引；结果必须先于随后入队的浏览器关闭确认，不依赖随机请求 ID。
CREATE UNIQUE INDEX outbox_order ON outbox(ordinal);
PRAGMA user_version=4;
COMMIT;
`;
