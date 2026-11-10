-- 正式消息关联模型调用；NULL 保持旧客户端写入兼容，不改写既有正文与身份。
ALTER TABLE ai_messages ADD COLUMN source_call_id TEXT;
-- 按调用定位正式消息，断线恢复无需遍历全部聊天正文。
CREATE INDEX ai_messages_source_call ON ai_messages(thread_id, source_call_id) WHERE source_call_id IS NOT NULL;
-- 本次调用实际选择的传输方式；旧调用为 NULL。
ALTER TABLE ai_calls ADD COLUMN stream_mode TEXT CHECK(stream_mode IN ('stream','buffered','fallback'));
-- 首个正文分片到达的 UTC 毫秒时点；不含正文或秘密。
ALTER TABLE ai_calls ADD COLUMN first_delta_at INTEGER;
INSERT OR IGNORE INTO settings(key,value) VALUES('modelStreamingEnabled','1'),('chatPreviewEnabled','1');
