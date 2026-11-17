-- 选出唯一成功的上传尝试。
ALTER TABLE conversation_inbox ADD COLUMN attachment_batch TEXT;
-- 消息排队期间加密原文，发布后仅保留正式消息。
ALTER TABLE conversation_inbox ADD COLUMN attachment_text TEXT;

-- 一次消息写入所关联的原件索引。对象在 Evidence 内分块加密。
CREATE TABLE chat_attachments (
  -- 带有消息请求身份的稳定附件标识。
  id TEXT PRIMARY KEY NOT NULL,
  -- 原聊天关闭后不得读取或改挂其他聊天。
  thread_id TEXT NOT NULL REFERENCES ai_threads(id),
  -- 接受消息时与 inbox 同一事务写入。
  inbox_id TEXT NOT NULL REFERENCES conversation_inbox(id),
  -- 文件在原消息中的顺序。
  position INTEGER NOT NULL,
  -- 文件名可能含私密信息，按附件身份加密。
  name_cipher TEXT NOT NULL,
  -- 验证过的媒体类型。
  mime TEXT NOT NULL,
  -- 原件字节数。
  size INTEGER NOT NULL,
  -- 上传尝试独占对象，由发布索引和 Evidence alarm 仲裁保留。
  object_key TEXT NOT NULL
);
-- 删除及保留期清理按聊天分批回收原件。
CREATE INDEX chat_attachments_thread ON chat_attachments(thread_id,id);
-- 同一 inbox 的顺序位置不可重复发布。
CREATE UNIQUE INDEX chat_attachments_position ON chat_attachments(inbox_id,position);
-- 暂存对象只由一个公开索引保留。
CREATE UNIQUE INDEX chat_attachments_object ON chat_attachments(object_key);
