-- 复用调用状态与用量的现有写入；升级前的历史保留 NULL，统计时显式区分缺失样本。
ALTER TABLE ai_calls ADD COLUMN egress_started_at TEXT;
ALTER TABLE model_usage ADD COLUMN call_id TEXT;
ALTER TABLE model_usage ADD COLUMN inference_started_at TEXT;
ALTER TABLE model_usage ADD COLUMN provider_started_at TEXT;
CREATE INDEX model_usage_call_timing ON model_usage(run_id, call_id) WHERE call_id IS NOT NULL;
