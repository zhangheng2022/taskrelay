-- 历史版本与用量保留原协议，所有退休判断均以固定版本为准。
CREATE VIEW retired_model_versions AS
SELECT id,version FROM model_profile_versions WHERE json_extract(config,'$.protocol') IS NOT 'responses';

CREATE VIEW retired_task_versions AS
SELECT t.task_id,t.version FROM task_versions t JOIN retired_model_versions m
ON m.id=t.model_id AND m.version=t.model_version;

UPDATE models SET enabled=0,management_version=management_version+1
WHERE enabled=1 AND (id,current_version) IN (SELECT id,version FROM retired_model_versions);

-- 发布排空执行中的作业；排队副本尚未触达浏览器，可以有明确的终态。
INSERT INTO run_results(run_id,result)
SELECT id,json_object('summary','模型协议已停用，请选择 Responses 模型重新交办。','outcome','unconfirmed','evidence',json('[]'),'errorCode','MODEL_PROTOCOL_RETIRED')
FROM runs WHERE status='queued' AND (task_id,task_version) IN (SELECT task_id,version FROM retired_task_versions);
UPDATE runs SET status='failed',cancel_requested=1,updated_at=unixepoch()*1000
WHERE status='queued' AND (task_id,task_version) IN (SELECT task_id,version FROM retired_task_versions);

UPDATE account_dispatch_members SET state='cancelled' WHERE state IN ('pending','enqueued') AND group_id IN
(SELECT id FROM account_dispatch_groups WHERE state IN ('active','paused') AND (task_id,task_version) IN (SELECT task_id,version FROM retired_task_versions));
UPDATE account_dispatch_groups SET state='cancelled',updated_at=unixepoch()*1000
WHERE state IN ('active','paused') AND (task_id,task_version) IN (SELECT task_id,version FROM retired_task_versions);
UPDATE conversation_commands SET state='done',run_task=NULL WHERE state IN ('pending','committed') AND
(json_extract(run_task,'$.modelId'),json_extract(run_task,'$.modelVersion')) IN (SELECT id,version FROM retired_model_versions);
UPDATE tasks SET status='paused',next_run_at=NULL WHERE deleted=0 AND (id,version) IN (SELECT task_id,version FROM retired_task_versions);
UPDATE task_schedules SET state='paused',ready=0,next_run_at=NULL,version=version+1
WHERE (state<>'paused' OR ready<>0 OR next_run_at IS NOT NULL) AND (task_id,task_version) IN (SELECT task_id,version FROM retired_task_versions);

-- 防止历史模型仍有启用的新版本时，旧任务通过重排或定时入口进入执行队列。
CREATE TRIGGER run_responses_only BEFORE INSERT ON runs
WHEN NOT EXISTS(SELECT 1 FROM runs WHERE idempotency_key=NEW.idempotency_key)
AND (NEW.task_id,NEW.task_version) IN (SELECT task_id,version FROM retired_task_versions)
BEGIN SELECT RAISE(ABORT,'MODEL_PROTOCOL_RETIRED'); END;
CREATE TRIGGER schedule_responses_only BEFORE UPDATE OF state ON task_schedules
WHEN NEW.state='enabled' AND (NEW.task_id,NEW.task_version) IN (SELECT task_id,version FROM retired_task_versions)
BEGIN SELECT RAISE(ABORT,'MODEL_PROTOCOL_RETIRED'); END;
