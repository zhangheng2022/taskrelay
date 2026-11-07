-- 加密回复仍可供当前任务使用；撤回上下文是独立的持久授权状态。
ALTER TABLE ai_messages ADD COLUMN context_withdrawn INTEGER NOT NULL DEFAULT 0 CHECK(context_withdrawn IN (0,1));
ALTER TABLE tasks ADD COLUMN context_withdrawn INTEGER NOT NULL DEFAULT 0 CHECK(context_withdrawn IN (0,1));
ALTER TABLE runs ADD COLUMN context_withdrawn INTEGER NOT NULL DEFAULT 0 CHECK(context_withdrawn IN (0,1));
UPDATE ai_messages SET context_withdrawn=1
 WHERE private_content IS NOT NULL AND content='[用户已将这条内容设为仅本人可见]';
UPDATE ai_messages SET context_withdrawn=1 WHERE role='assistant' AND EXISTS(
 SELECT 1 FROM ai_messages original WHERE original.thread_id=ai_messages.thread_id
 AND original.context_withdrawn=1 AND original.role='user' AND original.seq<=ai_messages.seq);

-- 旧版本已撤回的聊天也可能仍有缓存原文的执行器；停止旧运行而不重放操作。
UPDATE runs SET context_withdrawn=1,
 cancel_requested=CASE WHEN status IN ('queued','running','waiting_user','verifying') THEN 1 ELSE cancel_requested END,
 status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END
 WHERE thread_id IN(SELECT thread_id FROM ai_messages WHERE context_withdrawn=1);
UPDATE tasks SET context_withdrawn=1,status='paused',next_run_at=NULL
 WHERE id IN(SELECT task_id FROM ai_threads WHERE id IN(SELECT thread_id FROM ai_messages WHERE context_withdrawn=1));

-- 旧撤回后仍可能产生含派生正文的新图；先关闭其写入代次，再清除恢复副本，
-- 防止部署后alarm从旧checkpoint继续，而绕过新的上下文过滤。
UPDATE ai_graph_inputs SET active=0,generation=generation+1,status='cancelled',error='CONTEXT_WITHDRAWN'
 WHERE parent_thread IN(SELECT thread_id FROM ai_messages WHERE context_withdrawn=1);
UPDATE ai_dispatch SET state='retired',message_id=NULL,lease_until=NULL,error='CONTEXT_WITHDRAWN'
 WHERE thread_id IN(SELECT thread_id FROM ai_messages WHERE context_withdrawn=1);
UPDATE ai_turns SET status=CASE WHEN status='running' THEN 'cancelled' ELSE status END,result=NULL,
 error=CASE WHEN status='running' THEN 'CONTEXT_WITHDRAWN' ELSE error END
 WHERE thread_id IN(SELECT thread_id FROM ai_messages WHERE context_withdrawn=1);
UPDATE ai_threads SET active_turn=NULL,draft=NULL,summary='',summary_seq=0,partial='{}',version=version+1
 WHERE id IN(SELECT thread_id FROM ai_messages WHERE context_withdrawn=1);
UPDATE conversation_inbox SET status='failed'
 WHERE status IN ('pending','processing') AND thread_id IN(SELECT thread_id FROM ai_messages WHERE context_withdrawn=1);
UPDATE execution_help SET response=NULL,awaiting_user=0,reply_message_id=NULL
 WHERE thread_id IN(SELECT thread_id FROM ai_messages WHERE context_withdrawn=1);
UPDATE ai_calls SET result=NULL
 WHERE graph_id IN(SELECT id FROM ai_graph_inputs WHERE parent_thread IN(SELECT thread_id FROM ai_messages WHERE context_withdrawn=1));
DELETE FROM ai_writes WHERE EXISTS(SELECT 1 FROM ai_graph_inputs g WHERE g.id=ai_writes.thread AND g.owner=ai_writes.owner
 AND g.parent_thread IN(SELECT thread_id FROM ai_messages WHERE context_withdrawn=1));
DELETE FROM ai_checkpoints WHERE EXISTS(SELECT 1 FROM ai_graph_inputs g WHERE g.id=ai_checkpoints.thread AND g.owner=ai_checkpoints.owner
 AND g.parent_thread IN(SELECT thread_id FROM ai_messages WHERE context_withdrawn=1));

-- 暂存截图的 alarm 按持久索引判断是否发布，避免扫描整个图片历史。
CREATE INDEX artifacts_object_key ON artifacts(object_key);
-- 孤儿对象的退休与图片索引发布在同一个D1中仲裁，阻止迟到请求挂上已回收对象。
CREATE TABLE evidence_retirements(object_key TEXT PRIMARY KEY,retired_at TEXT NOT NULL);
UPDATE conversation_commands SET run_task=NULL,state='done'
 WHERE state IN ('pending','committed')
 AND thread_id IN(SELECT thread_id FROM ai_messages WHERE context_withdrawn=1);
