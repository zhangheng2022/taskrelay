-- 是否支持定时任务与执行总结扩展
ALTER TABLE devices ADD COLUMN schedule_capable INTEGER NOT NULL DEFAULT 0;
-- 新执行器已启用本次执行总结
ALTER TABLE runs ADD COLUMN learning_enabled INTEGER NOT NULL DEFAULT 0;
-- 领取要求执行器声明定时扩展能力
ALTER TABLE runs ADD COLUMN requires_scheduling INTEGER NOT NULL DEFAULT 0;
-- 需求变化代次，用于隔离旧执行经验
ALTER TABLE tasks ADD COLUMN requirement_revision INTEGER NOT NULL DEFAULT 0;
-- 独立调度版本不更改执行中的任务快照；确认正文和执行经验由应用加密。
CREATE TABLE task_schedules (
  -- 所属任务身份
  task_id TEXT PRIMARY KEY REFERENCES tasks(id),
  -- 固定原会话，禁止从其他会话借用确认水位
  thread_id TEXT REFERENCES ai_threads(id),
  -- 独立配置版本，用于并发校验
  version INTEGER NOT NULL DEFAULT 1,
  -- 确认时任务版本，重新交办后失效
  task_version INTEGER NOT NULL,
  -- 需求变化代次，用于隔离旧执行经验
  requirement_revision INTEGER NOT NULL DEFAULT 0,
  -- 已理解的用户消息水位
  confirmed_seq INTEGER NOT NULL DEFAULT 0,
  -- 加密需求或执行总结正文
  summary TEXT,
  -- 执行器已理解当前需求标志
  ready INTEGER NOT NULL DEFAULT 0,
  -- 调度或总结处理状态
  state TEXT NOT NULL DEFAULT 'off' CHECK(state IN ('off','enabled','paused')),
  -- 用户选择的常用频率 JSON
  frequency TEXT,
  -- 服务端生成或兼容的运行频率 JSON
  schedule TEXT,
  -- 下次触发时点，UTC 毫秒
  next_run_at INTEGER,
  -- 原有频率的兼容标志
  legacy INTEGER NOT NULL DEFAULT 0
);
-- 按到期状态或任务版本检索，避免扫描历史正文
CREATE INDEX task_schedules_due ON task_schedules(state,next_run_at);
-- 调度配置幂等写入身份
CREATE TABLE schedule_requests (
  -- 所属任务身份
  task_id TEXT NOT NULL REFERENCES tasks(id),
  -- 客户端写入请求身份
  request_id TEXT NOT NULL,
  -- 请求摘要，防止同身份不同输入
  digest TEXT NOT NULL,
  -- 独立配置版本，用于并发校验
  version INTEGER NOT NULL,
  PRIMARY KEY(task_id,request_id)
);
-- 后台总结及任务执行经验
CREATE TABLE execution_learning (
  -- 所属原运行身份
  run_id TEXT PRIMARY KEY REFERENCES runs(id),
  -- 所属任务身份
  task_id TEXT NOT NULL REFERENCES tasks(id),
  -- 确认时任务版本，重新交办后失效
  task_version INTEGER NOT NULL,
  -- 经验适用账号；空表示临时环境
  account_id TEXT,
  -- 需求变化代次，用于隔离旧执行经验
  requirement_revision INTEGER NOT NULL DEFAULT 0,
  -- 调度或总结处理状态
  state TEXT NOT NULL DEFAULT 'pending',
  -- 加密需求或执行总结正文
  summary TEXT,
  -- 加密操作改进建议
  improvements TEXT,
  -- 执行记录可能不完整标志
  incomplete INTEGER NOT NULL DEFAULT 1,
  -- 固定公开错误分类
  error TEXT,
  -- 记录创建时点，UTC 毫秒
  created_at INTEGER NOT NULL
);
-- 按到期状态或任务版本检索，避免扫描历史正文
CREATE INDEX execution_learning_task ON execution_learning(task_id,task_version,created_at);
-- 执行器实际操作与反馈的加密记录
CREATE TABLE execution_records (
  -- 所属原运行身份
  run_id TEXT NOT NULL REFERENCES runs(id),
  -- 执行器工具调用的稳定身份
  call_id TEXT NOT NULL,
  -- 加密操作及实际反馈记录
  content TEXT NOT NULL,
  -- 记录创建时点，UTC 毫秒
  created_at INTEGER NOT NULL,
  PRIMARY KEY(run_id,call_id)
);
-- 旧定时保留频率、状态及触发时间；新界面只读显示原始表达式。
INSERT INTO task_schedules(task_id,thread_id,task_version,ready,state,schedule,next_run_at,legacy)
 SELECT t.id,(SELECT id FROM ai_threads h WHERE h.task_id=t.id AND h.closed=0 ORDER BY h.created_at DESC LIMIT 1),t.version,1,CASE WHEN t.status='active' THEN 'enabled' ELSE 'paused' END,
 json_extract(v.definition,'$.schedule'),t.next_run_at,1
 FROM tasks t JOIN task_versions v ON v.task_id=t.id AND v.version=t.version
 WHERE t.confirmed_condition IS NOT NULL AND t.deleted=0 AND json_extract(v.definition,'$.schedule.kind') IN ('once','cron');
-- 沿用迁移前的已确认调度；升级后新增的任何用户消息仍需重新判断，不能用 legacy 绕过水位。
UPDATE task_schedules SET confirmed_seq=(SELECT COALESCE(MAX(seq),0) FROM ai_messages WHERE thread_id=task_schedules.thread_id AND role='user');
UPDATE tasks SET next_run_at=NULL WHERE id IN(SELECT task_id FROM task_schedules);
CREATE TRIGGER schedule_task_revision AFTER UPDATE OF version,context_withdrawn,deleted ON tasks
 WHEN NEW.version<>OLD.version OR NEW.context_withdrawn=1 OR NEW.deleted=1
 BEGIN
 UPDATE task_schedules SET ready=0,state='paused',next_run_at=NULL,version=version+1 WHERE task_id=NEW.id;
 -- 新任务快照从独立的需求代次开始，不能继承上一个任务版本的经验。
 UPDATE tasks SET requirement_revision=0 WHERE id=NEW.id AND NEW.version<>OLD.version;
 END;
CREATE TRIGGER learning_history_cleanup AFTER UPDATE OF history_deleted,context_withdrawn ON runs
 WHEN NEW.history_deleted=1 OR NEW.context_withdrawn=1
 BEGIN
 DELETE FROM execution_records WHERE run_id=NEW.id;
 DELETE FROM execution_learning WHERE run_id=NEW.id;
 END;
CREATE TRIGGER schedule_history_cleanup AFTER UPDATE OF context_withdrawn,deleted ON tasks
 WHEN NEW.context_withdrawn=1 OR NEW.deleted=1
 BEGIN
 DELETE FROM task_schedules WHERE task_id=NEW.id;
 DELETE FROM schedule_requests WHERE task_id=NEW.id;
 END;

CREATE TRIGGER schedule_requirement_revision AFTER UPDATE OF requirement_revision ON task_schedules
 BEGIN UPDATE tasks SET requirement_revision=NEW.requirement_revision WHERE id=NEW.task_id; END;

CREATE TRIGGER schedule_claim_capability BEFORE UPDATE OF status ON runs
 WHEN NEW.status='running' AND OLD.status='queued' AND NEW.requires_scheduling=1
 BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM devices WHERE id=NEW.device_id AND schedule_capable=1) THEN RAISE(ABORT,'CLAIM_BUSY') END;
 END;

CREATE TRIGGER schedule_task_paused AFTER UPDATE OF status ON tasks WHEN NEW.status='paused' AND OLD.status<>'paused'
 BEGIN UPDATE task_schedules SET state='paused',next_run_at=NULL,version=version+1 WHERE task_id=NEW.id; END;
UPDATE task_schedules SET frequency=json_object('kind','once','at',json_extract(schedule,'$.at'),'timezone','Asia/Shanghai'),legacy=0 WHERE json_extract(schedule,'$.kind')='once';

-- 只映射新表单能够无损表示的五字段表达式；其余旧 Cron 保留原样继续运行。
WITH RECURSIVE split(task_id,rest,position,token) AS (
 SELECT task_id,trim(json_extract(schedule,'$.expression'))||' ',0,'' FROM task_schedules WHERE legacy=1
 UNION ALL
 SELECT task_id,ltrim(substr(rest,instr(rest,' ')+1)),position+1,substr(rest,1,instr(rest,' ')-1) FROM split WHERE rest<>'' AND position<6
), fields AS (
 SELECT task_id,MAX(position) n,MAX(CASE WHEN position=1 THEN token END) minute,MAX(CASE WHEN position=2 THEN token END) hour,
 MAX(CASE WHEN position=3 THEN token END) monthday,MAX(CASE WHEN position=4 THEN token END) month,MAX(CASE WHEN position=5 THEN token END) weekday FROM split GROUP BY task_id
), mapped AS (
 SELECT task_id,CASE
 WHEN monthday='*' AND weekday='*' THEN json_object('kind','daily')
 WHEN weekday='*' AND monthday<>'' AND monthday NOT GLOB '*[^0-9]*' AND CAST(monthday AS INTEGER) BETWEEN 1 AND 31 THEN json_object('kind','monthly','day',CAST(monthday AS INTEGER))
 WHEN monthday='*' AND weekday<>'' AND weekday NOT GLOB '*[^0-6,]*' AND json_valid('['||weekday||']') THEN json_object('kind','weekly','days',json('['||weekday||']'))
 END config,printf('%02d:%02d',CAST(hour AS INTEGER),CAST(minute AS INTEGER)) time FROM fields
 WHERE n=5 AND month='*' AND minute<>'' AND hour<>'' AND minute NOT GLOB '*[^0-9]*' AND hour NOT GLOB '*[^0-9]*'
 AND CAST(minute AS INTEGER) BETWEEN 0 AND 59 AND CAST(hour AS INTEGER) BETWEEN 0 AND 23
)
UPDATE task_schedules SET frequency=json_patch((SELECT config FROM mapped WHERE task_id=task_schedules.task_id),json_object('time',(SELECT time FROM mapped WHERE task_id=task_schedules.task_id),'timezone',json_extract(schedule,'$.timezone'))),legacy=0
 WHERE task_id IN(SELECT task_id FROM mapped WHERE config IS NOT NULL);

-- 启用时原子验证固定任务资源，资源停用不能让 Scheduler 每分钟失败并阻挡其他任务。
CREATE TRIGGER schedule_resources BEFORE UPDATE OF state ON task_schedules WHEN NEW.state='enabled'
BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM task_versions v JOIN models m ON m.id=v.model_id WHERE v.task_id=NEW.task_id AND v.version=NEW.task_version AND m.enabled=0) THEN RAISE(ABORT,'MODEL_DISABLED') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM task_versions v, json_each(v.definition,'$.accountIds') j WHERE v.task_id=NEW.task_id AND v.version=NEW.task_version AND j.value IS NOT NULL AND NOT EXISTS(SELECT 1 FROM accounts a WHERE a.id=j.value AND a.user_id=v.user_id AND a.enabled=1))
 OR EXISTS(SELECT 1 FROM task_versions v JOIN accounts a ON a.id=json_extract(v.definition,'$.accountId') WHERE v.task_id=NEW.task_id AND v.version=NEW.task_version AND a.enabled=0) THEN RAISE(ABORT,'ACCOUNT_DISABLED') END;
END;
