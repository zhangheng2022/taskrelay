-- 聊天与临时模型图片共用归属索引；旧聊天图片保留原生命周期。
ALTER TABLE artifacts ADD COLUMN purpose TEXT NOT NULL DEFAULT 'chat' CHECK(purpose IN ('chat','vision'));
ALTER TABLE artifacts ADD COLUMN lease_epoch INTEGER;
ALTER TABLE artifacts ADD COLUMN digest TEXT;
