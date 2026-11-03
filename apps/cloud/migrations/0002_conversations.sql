CREATE TABLE conversations (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, at TEXT NOT NULL);
CREATE INDEX conversation_task ON conversations(task_id,at);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO settings(key,value) VALUES('retentionDays','30');
