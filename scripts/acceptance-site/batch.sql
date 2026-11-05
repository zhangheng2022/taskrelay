-- Isolated acceptance database only. Never reset an existing record or its counter.
CREATE TABLE IF NOT EXISTS batch_records(id TEXT PRIMARY KEY,label TEXT NOT NULL,status TEXT NOT NULL,submissions INTEGER NOT NULL DEFAULT 0);
INSERT OR IGNORE INTO batch_records(id,label,status) VALUES
('record-a','采购记录甲','待归档'),('record-b','采购记录乙','待归档'),('record-c','历史记录丙','已归档'),('record-d','暂未符合条件记录丁','不符合条件');

-- Independent follow-up fixture; previous records and counters remain untouched.
INSERT OR IGNORE INTO batch_records(id,label,status) VALUES
('recheck-a','复验记录甲','待归档'),('recheck-b','复验记录乙','待归档'),('recheck-c','复验历史记录丙','已归档'),('recheck-d','复验暂未符合条件记录丁','不符合条件');
