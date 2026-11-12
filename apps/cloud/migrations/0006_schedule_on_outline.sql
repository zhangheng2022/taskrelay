-- 仅认可原会话中已正式发布的云端交办。调度水位取本回合的用户原文，
-- 后到的补充仍需单独判断。手动重跑、执行器消息和普通咨询不产生拆解。
CREATE VIEW published_task_outlines AS
SELECT c.id AS turn_id, t.id AS task_id, h.id AS thread_id, t.version AS task_version,
       u.seq AS confirmed_seq
FROM conversation_commands c
JOIN ai_turns a ON a.id=c.id AND a.thread_id=c.thread_id AND a.status='done'
JOIN ai_threads h ON h.id=c.thread_id AND h.task_id=c.task_id AND h.closed=0 AND h.deleted=0
JOIN tasks t ON t.id=c.task_id AND t.user_id=h.user_id AND t.deleted=0 AND t.context_withdrawn=0
JOIN ai_messages u ON u.id=a.id||'_user' AND u.thread_id=h.id AND u.role='user' AND u.context_withdrawn=0
JOIN ai_messages m ON m.id=a.id||'_assistant' AND m.thread_id=h.id AND m.source='cloud' AND m.context_withdrawn=0
WHERE c.state IN ('committed','done') AND json_extract(c.run_task,'$.version')=t.version
  AND json_array_length(c.run_task,'$.executionOutline')>0;

-- 和正式回复同事务建卡。新任务默认关闭；新版本沿用既有暂停状态和频率。
-- 执行器若已确认同一版本，保留其加密摘要、消息水位和用户设置。
CREATE TRIGGER schedule_on_published_outline AFTER UPDATE OF status ON ai_turns
WHEN OLD.status='running' AND NEW.status='done'
BEGIN
  INSERT INTO task_schedules(task_id,thread_id,task_version,confirmed_seq,ready)
  SELECT task_id,thread_id,task_version,confirmed_seq,1 FROM published_task_outlines WHERE turn_id=NEW.id
  ON CONFLICT(task_id) DO UPDATE SET thread_id=excluded.thread_id,task_version=excluded.task_version,
    confirmed_seq=excluded.confirmed_seq,ready=1,summary=NULL,requirement_revision=0,version=version+1
  WHERE task_schedules.task_version<excluded.task_version;
END;

-- 仅补建仍可见、仍对应当前任务版本的历史拆解；不修改已有卡片。
INSERT INTO task_schedules(task_id,thread_id,task_version,confirmed_seq,ready)
SELECT task_id,thread_id,task_version,confirmed_seq,1 FROM published_task_outlines WHERE true
ON CONFLICT(task_id) DO NOTHING;
