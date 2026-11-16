-- 会话后续使用的推理强度。空值沿用提供方默认值，任务与运行的强度随已有 JSON 快照保存。
ALTER TABLE ai_threads ADD COLUMN reasoning_effort TEXT
  CHECK(reasoning_effort IN ('none','minimal','low','medium','high','xhigh','max'));
