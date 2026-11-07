-- TaskRelay v2：全新数据库基线，仅支持结构版本 2。旧库通过离线转换器迁移。
-- 外键保护归属；正文清理与 unknown/幂等墓碑有不同生命周期。
PRAGMA foreign_keys=ON;

-- 不可变模型配置版本；密钥按模型 ID/版本加密，运行固定版本。能力探测可更新同版本的实际能力记录。 任务/聊天/运行仍引用时保留版本身份，不随当前头切换删除。
CREATE TABLE model_profile_versions (
  -- 稳定标识；保留存量身份
  id TEXT NOT NULL,
  -- 本实体内的递增版本
  version INTEGER NOT NULL,
  -- 模型配置 JSON，格式 1；modelInputSchema 校验，版本配置权威，不含明文 API Key
  config TEXT NOT NULL,
  -- 模型 API Key 密文；AAD 为 model:<id>:<version>，仅可信服务端配置/出站适配器读取，不向网页或设备返回密钥
  secret TEXT NOT NULL,
  -- 模型能力 JSON，格式 1；models 的能力探测/读取入口维护，实际探测结果权威，不暗换模型
  capabilities TEXT NOT NULL,
  -- 记录创建时点；UTC Unix 毫秒
  created_at INTEGER NOT NULL CHECK(created_at IS NULL OR typeof(created_at)='integer'),
  -- 关系/唯一约束在写事务内生效；删除规则显式声明。
  PRIMARY KEY(id,version),
  -- 引用父资源身份；默认拒绝删除被引用身份，正文另行清理。版本头与正文必须在同事务完成，提交时校验。
  FOREIGN KEY(id) REFERENCES models(id) DEFERRABLE INITIALLY DEFERRED
);

-- 用户站点账号及浏览器状态发布权；凭据正文只在版本表，主表不保存密码副本。 凭据版本或运行仍引用时拒绝物理删除；撤销浏览器状态先退休对象再清除引用。
CREATE TABLE accounts (
  -- 稳定标识；保留存量身份
  id TEXT PRIMARY KEY NOT NULL,
  -- 界面显示名称
  name TEXT NOT NULL,
  -- 凭据适用的公网站点 origin
  origin TEXT NOT NULL,
  -- 脱敏用户名展示提示
  username_hint TEXT NOT NULL,
  -- 记录创建时点；UTC Unix 毫秒
  created_at INTEGER NOT NULL CHECK(created_at IS NULL OR typeof(created_at)='integer'),
  -- 所属业务成员 ID；由服务端授权，不接受网页扩权
  user_id TEXT NOT NULL,
  -- 账号分配的执行设备 ID；NULL 表示尚未分配
  assigned_device_id TEXT REFERENCES devices(id),
  -- Main 管理的浏览器目录身份；不等于主机路径
  profile_id TEXT,
  -- 登录状态已失效标志；需要重新认证
  login_reset INTEGER NOT NULL DEFAULT 0,
  -- 账号业务域名 JSON 数组，格式 1；normalizeAccount 校验，账号匹配范围权威
  business_domains TEXT NOT NULL DEFAULT '[]',
  -- 固定凭据版本；修改不覆盖已领取运行
  credential_version INTEGER NOT NULL DEFAULT 1,
  -- 浏览器状态撤销代次
  state_epoch INTEGER NOT NULL DEFAULT 1,
  -- 凭据认证状态 unverified/valid/invalid
  credential_status TEXT NOT NULL DEFAULT 'unverified',
  -- 账号已发布浏览器状态递增修订号
  state_revision INTEGER NOT NULL DEFAULT 0,
  -- 当前已发布浏览器状态对象键
  state_object_key TEXT,
  -- 上一已发布浏览器状态对象键；NULL 表示无回退副本
  previous_state_object_key TEXT,
  -- 浏览器状态同步状态 none/pending/synced/failed
  sync_status TEXT NOT NULL DEFAULT 'none',
  -- 固定公开同步错误分类；不存上游正文
  sync_error TEXT,
  -- 最近发布账号浏览器状态的设备 ID；NULL 表示尚未发布
  last_device_id TEXT,
  -- 持有当前账号状态发布权的运行 ID；NULL 表示没有发布占用
  state_owner_run_id TEXT,
  -- 引用父资源身份；默认拒绝删除被引用身份，正文另行清理。版本头与正文必须在同事务完成，提交时校验。
  FOREIGN KEY(id,credential_version) REFERENCES account_credential_versions(account_id,version) DEFERRABLE INITIALLY DEFERRED,
  -- 联合唯一性：user_id,id 在本表不能重复，为归属关联或请求防重提供稳定身份。
  UNIQUE(user_id,id),
  -- 归属成员必须存在；成员仍被业务记录引用时拒绝直接删除，正文另行清理。
  FOREIGN KEY(user_id) REFERENCES members(id)
);

-- 用户任务当前版本及调度入口；定义仅在版本表。删除/撤回先停止调度并撤回后续写入授权。
CREATE TABLE tasks (
  -- 稳定标识；保留存量身份
  id TEXT PRIMARY KEY NOT NULL,
  -- 本实体内的递增版本
  version INTEGER NOT NULL,
  -- 任务状态：active 启用、paused 暂停、pending_validation 等待验证；删除另由 deleted 控制
  status TEXT NOT NULL CHECK(status IN ('pending_validation','active','paused')),
  -- 下一次已确认调度时点；NULL 表示不自动调度；UTC Unix 毫秒
  next_run_at INTEGER CHECK(next_run_at IS NULL OR typeof(next_run_at)='integer'),
  -- 记录创建时点；UTC Unix 毫秒
  created_at INTEGER NOT NULL CHECK(created_at IS NULL OR typeof(created_at)='integer'),
  -- 最近业务更新时点；UTC Unix 毫秒
  updated_at INTEGER NOT NULL CHECK(updated_at IS NULL OR typeof(updated_at)='integer'),
  -- 所属业务成员 ID；由服务端授权，不接受网页扩权
  user_id TEXT NOT NULL,
  -- 已确认条件的来源运行 ID；NULL 表示无已确认条件
  confirmed_condition TEXT,
  -- 上下文撤回标志；本人历史可读，后续 AI 不得使用原文
  context_withdrawn INTEGER NOT NULL DEFAULT 0 CHECK(context_withdrawn IN (0,1)),
  -- 用户界面删除标志；先关闭写入再回收正文
  deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0,1)),
  -- 任务展示标题；与当前版本同步维护
  title TEXT NOT NULL,
  -- 调度种类：manual 手动、once 单次或 cron 周期；不从大正文中筛选
  schedule_kind TEXT NOT NULL CHECK(schedule_kind IN ('manual','once','cron')),
  -- 联合唯一性：user_id,id 在本表不能重复，为归属关联或请求防重提供稳定身份。
  UNIQUE(user_id,id),
  -- 归属成员必须存在；成员仍被业务记录引用时拒绝直接删除，正文另行清理。
  FOREIGN KEY(user_id) REFERENCES members(id),
  -- 复合归属约束确保同一用户；默认拒绝删除被引用身份，正文另行清理。版本头与正文必须在同事务完成，提交时校验。
  FOREIGN KEY(user_id,id,version) REFERENCES task_versions(user_id,task_id,version) DEFERRABLE INITIALLY DEFERRED
);

-- 任务不可变定义版本；是业务定义唯一权威，运行引用固定版本。清理只回收目标截止版本。
CREATE TABLE task_versions (
  -- 所属任务 ID
  task_id TEXT NOT NULL,
  -- 本实体内的递增版本
  version INTEGER NOT NULL,
  -- TaskDefinition JSON，格式版本由 format_version 声明；版本定义权威，校验见 contracts
  definition TEXT NOT NULL,
  -- 所属业务成员 ID；由服务端授权，不接受网页扩权
  user_id TEXT NOT NULL,
  -- 固定模型配置 ID
  model_id TEXT,
  -- 固定模型配置版本
  model_version INTEGER,
  -- 本表 JSON/正文格式版本；当前仅支持 1
  format_version INTEGER NOT NULL DEFAULT 1 CHECK(format_version=1),
  -- 关系/唯一约束在写事务内生效；删除规则显式声明。
  PRIMARY KEY(task_id,version),
  -- 关系/唯一约束在写事务内生效；删除规则显式声明。
  CHECK((model_id IS NULL)=(model_version IS NULL)),
  -- 联合唯一性：user_id,task_id,version 在本表不能重复，为归属关联或请求防重提供稳定身份。
  UNIQUE(user_id,task_id,version),
  -- 复合归属约束确保同一用户；默认拒绝删除被引用身份，正文另行清理。版本头与正文必须在同事务完成，提交时校验。
  FOREIGN KEY(user_id,task_id) REFERENCES tasks(user_id,id) DEFERRABLE INITIALLY DEFERRED,
  -- 引用父资源身份；默认拒绝删除被引用身份，正文另行清理。
  FOREIGN KEY(model_id,model_version) REFERENCES model_profile_versions(id,version)
);

-- 管理员授权的执行设备；令牌只存哈希，可吊销。执行并发和浏览器资源归云端与 Main 管理。 吊销保留设备身份和领取回执，已被运行引用时拒绝物理删除。
CREATE TABLE devices (
  -- 稳定标识；保留存量身份
  id TEXT PRIMARY KEY NOT NULL,
  -- 界面显示名称
  name TEXT NOT NULL,
  -- 设备 bearer token 的摘要；不可逆，不存明文令牌
  token_hash TEXT NOT NULL UNIQUE,
  -- 最近设备认证心跳时点；NULL 表示从未在线；UTC Unix 毫秒
  last_seen INTEGER CHECK(last_seen IS NULL OR typeof(last_seen)='integer'),
  -- 设备令牌是否吊销：0/1
  revoked INTEGER NOT NULL DEFAULT 0,
  -- 设备已确认支持的执行协议版本；本版为 18，旧版须经维护窗口升级
  protocol_version INTEGER NOT NULL,
  -- 设备是否可领取：0/1
  claim_ready INTEGER NOT NULL DEFAULT 1
);

-- 短期设备配对流程；验证码及轮询摘要绑定设备，令牌密文仅配对交付，过期回收。
CREATE TABLE pairings (
  -- 稳定标识；保留存量身份
  id TEXT PRIMARY KEY NOT NULL,
  -- 短期配对码
  code TEXT NOT NULL UNIQUE,
  -- 设备配对轮询凭证摘要
  poll_hash TEXT NOT NULL,
  -- 设备令牌密文；AAD 为 pair:<id>，只向对应配对设备交付，过期删除
  token_secret TEXT NOT NULL,
  -- 所属执行设备 ID
  device_id TEXT NOT NULL,
  -- 界面显示名称
  name TEXT NOT NULL,
  -- 管理员是否已批准配对：0/1
  approved INTEGER NOT NULL DEFAULT 0,
  -- 记录或对象到期时点；UTC Unix 毫秒
  expires_at INTEGER NOT NULL CHECK(expires_at IS NULL OR typeof(expires_at)='integer'),
  -- 记录创建时点；UTC Unix 毫秒
  created_at INTEGER NOT NULL CHECK(created_at IS NULL OR typeof(created_at)='integer')
);

-- 执行状态与安全控制主表；属于任务及用户。快照和结果独立存储，终态与浏览器清理分别确认。 历史清理回收快照/结果，保留运行、租约和未知结果安全身份。
CREATE TABLE runs (
  -- 稳定标识；保留存量身份
  id TEXT PRIMARY KEY NOT NULL,
  -- 所属任务 ID
  task_id TEXT NOT NULL,
  -- 运行状态：queued 排队、running 执行、waiting_user 等待用户、verifying 收尾、succeeded 已回复、failed 失败、cancelled 取消、expired 过期、unknown 结果未知；浏览器清理由独立标志确认
  status TEXT NOT NULL CHECK(status IN ('queued','running','waiting_user','verifying','succeeded','failed','cancelled','expired','unknown')),
  -- 本次运行的计划时点；UTC Unix 毫秒
  scheduled_for INTEGER NOT NULL CHECK(scheduled_for IS NULL OR typeof(scheduled_for)='integer'),
  -- 排队领取窗口的截止时点；UTC Unix 毫秒
  deadline INTEGER NOT NULL CHECK(deadline IS NULL OR typeof(deadline)='integer'),
  -- 所属执行设备 ID；NULL 表示尚未领取
  device_id TEXT,
  -- 运行租约代次；旧代次消息必须拒绝
  lease_epoch INTEGER NOT NULL DEFAULT 0,
  -- 运行执行租约到期时点；NULL 表示未领取或已收尾；UTC Unix 毫秒
  lease_expires_at INTEGER CHECK(lease_expires_at IS NULL OR typeof(lease_expires_at)='integer'),
  -- 停止标志；每次工具及提交前重新检查
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  -- 操作已登记但未获得后续观察；不得自动重放
  write_pending INTEGER NOT NULL DEFAULT 0,
  -- 账号 ID 或 task:<任务ID> 的独占资源键
  account_key TEXT NOT NULL,
  -- 同用户任务提交的稳定防重键；重试不产生第二次运行
  idempotency_key TEXT NOT NULL UNIQUE,
  -- 记录创建时点；UTC Unix 毫秒
  created_at INTEGER NOT NULL CHECK(created_at IS NULL OR typeof(created_at)='integer'),
  -- 最近业务更新时点；UTC Unix 毫秒
  updated_at INTEGER NOT NULL CHECK(updated_at IS NULL OR typeof(updated_at)='integer'),
  -- 被核查的原 unknown 运行；NULL 为普通执行
  reconciliation_of TEXT,
  -- 可能发生写入且结果未确认；保留 unknown 防重
  may_have_written INTEGER NOT NULL DEFAULT 0,
  -- 所属业务成员 ID；由服务端授权，不接受网页扩权
  user_id TEXT NOT NULL,
  -- Main 管理的浏览器目录身份；不等于主机路径
  profile_id TEXT,
  -- 上海时区 YYYY-MM-DD；用于启动统计
  started_day TEXT,
  -- 本运行内用户指令递增版本；补充消息推进，拒绝旧指令结果
  instruction_version INTEGER NOT NULL DEFAULT 0,
  -- 领取要求的执行协议版本
  execution_protocol INTEGER NOT NULL DEFAULT 18,
  -- 原聊天 ID；关闭后不得改挂新聊天
  thread_id TEXT,
  -- 上下文撤回标志；本人历史可读，后续 AI 不得使用原文
  context_withdrawn INTEGER NOT NULL DEFAULT 0 CHECK(context_withdrawn IN (0,1)),
  -- 历史已删除标志；迟到终态仅可收尾，不能恢复正文
  history_deleted INTEGER NOT NULL DEFAULT 0 CHECK(history_deleted IN (0,1)),
  -- 所属站点账号 ID；NULL 表示临时环境或尚未选择账号
  account_id TEXT,
  -- 领取时固定的账号凭据版本；作用域为 account_id，不随账号后续修改变化
  account_credential_version INTEGER NOT NULL DEFAULT 1,
  -- 领取时固化的账号状态撤销代次；不得读取已撤销浏览器状态
  account_state_epoch INTEGER NOT NULL DEFAULT 1,
  -- 浏览器清理待确认标志；终态后仍占用设备
  cleanup_pending INTEGER NOT NULL DEFAULT 0,
  -- Main 已确认自有浏览器进程退出
  cleanup_confirmed INTEGER NOT NULL DEFAULT 0,
  -- 本运行提交的浏览器状态候选对象键
  state_candidate_key TEXT,
  -- 账号轮转执行组 ID；NULL 表示独立运行
  dispatch_group_id TEXT,
  -- 同一账号执行组内从零开始的成员位置
  dispatch_index INTEGER,
  -- 固定任务定义版本
  task_version INTEGER CHECK(task_version IS NOT NULL OR history_deleted=1),
  -- 联合唯一性：user_id,id 在本表不能重复，为归属关联或请求防重提供稳定身份。
  UNIQUE(user_id,id),
  -- 归属成员必须存在；成员仍被业务记录引用时拒绝直接删除，正文另行清理。
  FOREIGN KEY(user_id) REFERENCES members(id),
  -- 复合归属约束确保同一用户；默认拒绝删除被引用身份，正文另行清理。
  FOREIGN KEY(user_id,task_id,task_version) REFERENCES task_versions(user_id,task_id,version),
  -- 复合归属约束确保同一用户；默认拒绝删除被引用身份，正文另行清理。
  FOREIGN KEY(user_id,thread_id) REFERENCES ai_threads(user_id,id),
  -- 复合归属约束确保同一用户；默认拒绝删除被引用身份，正文另行清理。
  FOREIGN KEY(user_id,account_id) REFERENCES accounts(user_id,id),
  -- 引用父资源身份；默认拒绝删除被引用身份，正文另行清理。
  FOREIGN KEY(device_id) REFERENCES devices(id)
);

-- 设备领取请求的幂等回执；同设备 request_id 返回原运行，历史回执不触发重新执行。 不随运行正文删除回执，不提供自动重放或过期重建路径。
CREATE TABLE claims (
  -- 所属执行设备 ID
  device_id TEXT NOT NULL,
  -- 调用方生成的幂等请求 ID
  request_id TEXT NOT NULL,
  -- 所属原运行 ID；必须关联执行
  run_id TEXT NOT NULL,
  -- 关系/唯一约束在写事务内生效；删除规则显式声明。
  PRIMARY KEY(device_id,request_id)
);

-- 同一次浏览器调用的防重账本；按运行和动作编号去重，unknown 不自动重放，删除正文不删除调用身份。
CREATE TABLE actions (
  -- 所属原运行 ID；必须关联执行
  run_id TEXT NOT NULL,
  -- 本运行内稳定的工具调用 ID；同 ID 和摘要只能登记一次
  action_id TEXT NOT NULL,
  -- 输入摘要；同一调用身份不能接受不同输入
  digest TEXT NOT NULL,
  -- 操作影响 read/write，校验见动作工具入口
  effect TEXT NOT NULL,
  -- 动作登记状态：intended 已登记但观察未确认，observed 已收到后续观察；不代表业务成功，未确认不得重放
  status TEXT NOT NULL,
  -- 关系/唯一约束在写事务内生效；删除规则显式声明。
  PRIMARY KEY(run_id,action_id)
);

-- 聊天截图及临时视觉输入的私有对象索引；D1 为发布权威，DO 保存分块密文。关闭聊天后分批删除对象。
CREATE TABLE artifacts (
  -- 稳定标识；保留存量身份
  id TEXT PRIMARY KEY NOT NULL,
  -- 所属原运行 ID；必须关联执行
  run_id TEXT NOT NULL,
  -- 私有 DO 对象键；D1 引用为唯一发布事实
  object_key TEXT NOT NULL,
  -- 已验证的内容 MIME 类型
  content_type TEXT NOT NULL,
  -- 记录或对象到期时点；UTC Unix 毫秒
  expires_at INTEGER NOT NULL CHECK(expires_at IS NULL OR typeof(expires_at)='integer'),
  -- 原聊天 ID；关闭后不得改挂新聊天
  thread_id TEXT,
  -- 1 为聊天长期图片，0 为短期视觉输入
  persistent INTEGER NOT NULL DEFAULT 0,
  -- 对象用途 chat/vision；授权与保留期按用途校验
  purpose TEXT NOT NULL DEFAULT 'chat' CHECK(purpose IN ('chat','vision')),
  -- 运行租约代次；旧代次消息必须拒绝
  lease_epoch INTEGER,
  -- 输入摘要；同一调用身份不能接受不同输入
  digest TEXT
);

-- 模型响应的真实用量和阶段时点；属于用户及可选运行/调用，未知 token 保持 NULL。 保留实际用量明细；聊天正文清理不删除计费事实，不把未知用量补成零。
CREATE TABLE model_usage (
  -- 稳定标识；保留存量身份
  id TEXT PRIMARY KEY NOT NULL,
  -- 所属运行 ID；NULL 表示未关联执行
  run_id TEXT,
  -- 固定模型配置 ID
  model_id TEXT NOT NULL,
  -- 固定模型配置版本
  model_version INTEGER NOT NULL,
  -- 提供方实际输入 token 数，NULL 表示未知
  input_tokens INTEGER,
  -- 提供方实际输出 token 数，NULL 表示未知
  output_tokens INTEGER,
  -- 事实记录时点；UTC Unix 毫秒
  at INTEGER NOT NULL CHECK(at IS NULL OR typeof(at)='integer'),
  -- 所属业务成员 ID；由服务端授权，不接受网页扩权
  user_id TEXT NOT NULL,
  -- 原模型调用账本 ID；NULL 表示无可绑定的调用身份
  call_id TEXT,
  -- 执行器推理开始时点；NULL 表示未提供；UTC Unix 毫秒
  inference_started_at INTEGER CHECK(inference_started_at IS NULL OR typeof(inference_started_at)='integer'),
  -- 提供方调用开始时点；NULL 表示未记录；UTC Unix 毫秒
  provider_started_at INTEGER CHECK(provider_started_at IS NULL OR typeof(provider_started_at)='integer'),
  -- 归属成员必须存在；成员仍被业务记录引用时拒绝直接删除，正文另行清理。
  FOREIGN KEY(user_id) REFERENCES members(id)
);

-- 业务写入请求摘要与资源身份；正文删除后继续保留，冲突摘要不能复用请求。
CREATE TABLE idempotency (
  -- 当前命名空间内唯一键；语义见模块入口
  key TEXT PRIMARY KEY NOT NULL,
  -- 输入摘要；同一调用身份不能接受不同输入
  digest TEXT NOT NULL,
  -- 目标资源的稳定 ID；种类由原请求或清理目标 kind 确定
  resource_id TEXT NOT NULL
);

-- 云端管理员配置、发布屏障及更新目录；D1 为唯一权威，不保存模型明文密钥。 由管理员/发布入口按键更新，不随用户历史删除。
CREATE TABLE settings (
  -- 当前命名空间内唯一键；语义见模块入口
  key TEXT PRIMARY KEY NOT NULL,
  -- 配置或序列化内容；格式与加密约束见所属模块
  value TEXT NOT NULL
);

-- 应用成员及管理员授权；与 auth_user 显式唯一关联。业务 ID 不因认证绑定而改变。 已有业务引用时拒绝直接删除；禁用账号不改变业务资源归属。
CREATE TABLE members (
  -- 稳定标识；保留存量身份
  id TEXT PRIMARY KEY NOT NULL,
  -- 显式关联 Better Auth 用户；唯一，NULL 为尚未绑定成员
  auth_id TEXT UNIQUE,
  -- 邮箱地址；用于验证身份，不作为资源归属主键
  email TEXT NOT NULL DEFAULT '',
  -- 成员角色：user 普通用户，admin 管理员
  role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user','admin')),
  -- 成员是否停用：0/1
  disabled INTEGER NOT NULL DEFAULT 0,
  -- 成员最近成功领取时点；NULL 表示从未领取，公平调度优先考虑；UTC Unix 毫秒
  last_claim_at INTEGER CHECK(last_claim_at IS NULL OR typeof(last_claim_at)='integer'),
  -- 个人每日启动阈值；限制暂停时不拦截
  daily_runs INTEGER NOT NULL DEFAULT 5,
  -- 个人已启用定时任务阈值
  scheduled_tasks INTEGER NOT NULL DEFAULT 3,
  -- 个人排队任务阈值
  queued_runs INTEGER NOT NULL DEFAULT 5,
  -- 个人每日聊天阈值；限制暂停时不拦截
  daily_chat INTEGER NOT NULL DEFAULT 50,
  -- 个人每日模型阈值；限制暂停时不拦截
  daily_models INTEGER NOT NULL DEFAULT 200,
  -- 个人限制临时暂停的到期时点；NULL 表示未设置临时暂停；UTC Unix 毫秒
  daily_quota_paused_until INTEGER CHECK(daily_quota_paused_until IS NULL OR typeof(daily_quota_paused_until)='integer'),
  -- 个人额度限制是否暂停；默认 1
  daily_quota_paused INTEGER NOT NULL DEFAULT 1 CHECK(daily_quota_paused IN (0,1)),
  -- 引用父资源身份；默认拒绝删除被引用身份，正文另行清理。
  FOREIGN KEY(auth_id) REFERENCES auth_user(id)
);

-- 用户聊天/模型额度幂等预留；个人限制默认暂停，保留实际统计与重试防重。
CREATE TABLE quota_reservations (
  -- 稳定标识；保留存量身份
  id TEXT PRIMARY KEY NOT NULL,
  -- 所属业务成员 ID；由服务端授权，不接受网页扩权
  user_id TEXT NOT NULL REFERENCES members(id),
  -- 上海时区 YYYY-MM-DD；用于当日统计
  day TEXT NOT NULL,
  -- 预留种类：chat 聊天交办、model 模型请求；同请求身份防重
  kind TEXT NOT NULL CHECK(kind IN ('chat','model')),
  -- 记录创建时点；UTC Unix 毫秒
  created_at INTEGER NOT NULL CHECK(created_at IS NULL OR typeof(created_at)='integer')
);

-- Better Auth 认证身份；邮箱验证后显式关联业务成员，不自动认领旧用户数据。 已有成员关联时拒绝直接删除；允许删除的认证身份按子表规则清理。
CREATE TABLE auth_user (
  -- 稳定标识；保留存量身份
  id TEXT PRIMARY KEY NOT NULL,
  -- 界面显示名称
  name TEXT NOT NULL,
  -- 邮箱地址；用于验证身份，不作为资源归属主键
  email TEXT NOT NULL UNIQUE,
  -- Better Auth 邮箱是否已验证：0/1
  emailVerified INTEGER NOT NULL DEFAULT 0,
  -- 认证用户头像 URL；NULL 表示未设置
  image TEXT,
  -- Better Auth 使用的 UTC Unix 毫秒时点；单位遵循已安装框架接口
  createdAt INTEGER NOT NULL,
  -- Better Auth 使用的 UTC Unix 毫秒时点；单位遵循已安装框架接口
  updatedAt INTEGER NOT NULL
);

-- Better Auth 网站会话；仅服务端认证读取，过期或退出回收，用户删除时级联。
CREATE TABLE auth_session (
  -- 稳定标识；保留存量身份
  id TEXT PRIMARY KEY NOT NULL,
  -- Better Auth 使用的 UTC Unix 毫秒时点；单位遵循已安装框架接口
  expiresAt INTEGER NOT NULL,
  -- Better Auth 随机会话令牌；由框架直接存储、未额外加密，仅服务端认证读取
  token TEXT NOT NULL UNIQUE,
  -- Better Auth 使用的 UTC Unix 毫秒时点；单位遵循已安装框架接口
  createdAt INTEGER NOT NULL,
  -- Better Auth 使用的 UTC Unix 毫秒时点；单位遵循已安装框架接口
  updatedAt INTEGER NOT NULL,
  -- 会话来源 IP；仅认证用途
  ipAddress TEXT,
  -- 认证会话客户端描述
  userAgent TEXT,
  -- 所属 Better Auth 用户 ID
  userId TEXT NOT NULL REFERENCES auth_user(id) ON DELETE CASCADE
);

-- Better Auth 登录提供方账号；属于认证用户，密码为框架哈希。用户删除时级联，密码变更原子撤销会话。
CREATE TABLE auth_account (
  -- 稳定标识；保留存量身份
  id TEXT PRIMARY KEY NOT NULL,
  -- 提供方账号 ID
  accountId TEXT NOT NULL,
  -- Better Auth 登录提供方标识
  providerId TEXT NOT NULL,
  -- 所属 Better Auth 用户 ID
  userId TEXT NOT NULL REFERENCES auth_user(id) ON DELETE CASCADE,
  -- 提供方访问令牌；Better Auth 直接存储，未额外加密，仅服务端可读
  accessToken TEXT,
  -- 提供方刷新令牌；Better Auth 直接存储，未额外加密，仅服务端可读
  refreshToken TEXT,
  -- 提供方身份令牌；Better Auth 直接存储，未额外加密，仅服务端可读
  idToken TEXT,
  -- Better Auth 使用的 UTC Unix 毫秒时点；单位遵循已安装框架接口
  accessTokenExpiresAt INTEGER,
  -- Better Auth 使用的 UTC Unix 毫秒时点；单位遵循已安装框架接口
  refreshTokenExpiresAt INTEGER,
  -- 提供方 OAuth 授权范围字符串；NULL 表示未记录
  scope TEXT,
  -- Better Auth 密码哈希；不存明文密码
  password TEXT,
  -- Better Auth 使用的 UTC Unix 毫秒时点；单位遵循已安装框架接口
  createdAt INTEGER NOT NULL,
  -- Better Auth 使用的 UTC Unix 毫秒时点；单位遵循已安装框架接口
  updatedAt INTEGER NOT NULL
);

-- Better Auth 邮箱验证及密码重置证明；由框架校验与过期回收，值不得进入日志。
CREATE TABLE auth_verification (
  -- 稳定标识；保留存量身份
  id TEXT PRIMARY KEY NOT NULL,
  -- 验证证明的邮箱或框架标识
  identifier TEXT NOT NULL,
  -- Better Auth 验证证明；遵循框架存储格式、未额外加密，仅服务端校验读取
  value TEXT NOT NULL,
  -- Better Auth 使用的 UTC Unix 毫秒时点；单位遵循已安装框架接口
  expiresAt INTEGER NOT NULL,
  -- Better Auth 使用的 UTC Unix 毫秒时点；单位遵循已安装框架接口
  createdAt INTEGER NOT NULL,
  -- Better Auth 使用的 UTC Unix 毫秒时点；单位遵循已安装框架接口
  updatedAt INTEGER NOT NULL
);

-- Better Auth 认证入口限流窗口；由框架维护，不保存业务凭据。 窗口到期由框架续用或清理，不随聊天删除。
CREATE TABLE auth_rate_limit (
  -- 稳定标识；保留存量身份
  id TEXT PRIMARY KEY NOT NULL,
  -- 当前命名空间内唯一键；语义见模块入口
  key TEXT NOT NULL UNIQUE,
  -- 当前窗口计数
  count INTEGER NOT NULL,
  -- Better Auth 使用的 UTC Unix 毫秒时点；单位遵循已安装框架接口
  lastRequest INTEGER NOT NULL
);

-- 认证或请求入口的固定时间窗口限流；到期可重用窗口，不保存原始凭据。
CREATE TABLE request_limits (
  -- 当前命名空间内唯一键；语义见模块入口
  key TEXT PRIMARY KEY NOT NULL,
  -- 当前窗口计数
  count INTEGER NOT NULL,
  -- 记录或对象到期时点；UTC Unix 毫秒
  expires_at INTEGER NOT NULL CHECK(expires_at IS NULL OR typeof(expires_at)='integer')
);

-- 用户聊天入口与云端回合控制；关闭/删除先撤回写入授权，再由清理作业回收正文。
CREATE TABLE ai_threads (
  -- 稳定标识；保留存量身份
  id TEXT PRIMARY KEY NOT NULL,
  -- 所属业务成员 ID；由服务端授权，不接受网页扩权
  user_id TEXT NOT NULL REFERENCES members(id),
  -- 所属任务 ID
  task_id TEXT,
  -- 聊天用途：compose 新任务交办、chat 已有任务聊天
  kind TEXT NOT NULL CHECK(kind IN ('compose','chat')),
  -- 固定模型配置 ID
  model_id TEXT NOT NULL,
  -- 固定模型配置版本
  model_version INTEGER NOT NULL,
  -- 本实体内的递增版本
  version INTEGER NOT NULL DEFAULT 0,
  -- 当前运行中的云端回合 ID；NULL 表示可推进 inbox
  active_turn TEXT,
  -- TaskInput 草稿 JSON，格式 1；taskInputSchema 校验，NULL 表示尚无有效草稿，提交版本前非任务定义权威
  draft TEXT,
  -- 云端意图草稿 JSON，格式 1；planning-graph 校验，仅为规划暂态，非已提交任务定义
  partial TEXT NOT NULL DEFAULT '{}',
  -- 聊天压缩摘要；不能扩大用户授权
  summary TEXT NOT NULL DEFAULT '',
  -- 已纳入摘要的最大消息序号
  summary_seq INTEGER NOT NULL DEFAULT 0,
  -- 聊天写入关闭标志；1 时禁止新发布
  closed INTEGER NOT NULL DEFAULT 0,
  -- 用户界面删除标志；先关闭写入再回收正文
  deleted INTEGER NOT NULL DEFAULT 0,
  -- 记录创建时点；UTC Unix 毫秒
  created_at INTEGER NOT NULL CHECK(created_at IS NULL OR typeof(created_at)='integer'),
  -- 最近业务更新时点；UTC Unix 毫秒
  updated_at INTEGER NOT NULL CHECK(updated_at IS NULL OR typeof(updated_at)='integer'),
  -- 联合唯一性：user_id,id 在本表不能重复，为归属关联或请求防重提供稳定身份。
  UNIQUE(user_id,id),
  -- 复合归属约束确保同一用户；默认拒绝删除被引用身份，正文另行清理。
  FOREIGN KEY(user_id,task_id) REFERENCES tasks(user_id,id),
  -- 引用父资源身份；默认拒绝删除被引用身份，正文另行清理。
  FOREIGN KEY(model_id,model_version) REFERENCES model_profile_versions(id,version)
);

-- 聊天内幂等回合；request_id 和版本绑定原交办，终态后不重新执行未知请求。 聊天删除时清除结果并取消回合，保留请求去重身份。
CREATE TABLE ai_turns (
  -- 稳定标识；保留存量身份
  id TEXT PRIMARY KEY NOT NULL,
  -- 原聊天 ID；关闭后不得改挂新聊天
  thread_id TEXT NOT NULL REFERENCES ai_threads(id) ON DELETE CASCADE,
  -- 调用方生成的幂等请求 ID
  request_id TEXT NOT NULL,
  -- 输入摘要；同一调用身份不能接受不同输入
  digest TEXT NOT NULL,
  -- 本实体内的递增版本
  version INTEGER NOT NULL,
  -- 回合状态：running 处理中、done 完成、failed 失败、unknown 结果未知、cancelled 已取消；终态同请求不重做
  status TEXT NOT NULL CHECK(status IN ('running','done','failed','unknown','cancelled')),
  -- 本回合公开结果 JSON，格式 1；回合收尾/去重使用，清理时置空
  result TEXT,
  -- 固定公开错误分类；不含秘密或上游正文
  error TEXT,
  -- 记录创建时点；UTC Unix 毫秒
  created_at INTEGER NOT NULL CHECK(created_at IS NULL OR typeof(created_at)='integer'),
  -- 最近业务更新时点；UTC Unix 毫秒
  updated_at INTEGER NOT NULL CHECK(updated_at IS NULL OR typeof(updated_at)='integer'),
  -- 所属运行 ID；NULL 表示未关联执行
  run_id TEXT,
  -- 联合唯一性：thread_id,request_id 在本表不能重复，为归属关联或请求防重提供稳定身份。
  UNIQUE(thread_id,request_id)
);

-- 统一聊天消息元数据；属于原聊天，seq 为聊天内稳定序号。正文独立保存，关闭聊天禁止新消息。 历史清理删除元数据并级联正文，原聊天身份保持关闭。
CREATE TABLE ai_messages (
  -- 稳定标识；保留存量身份
  id TEXT PRIMARY KEY NOT NULL,
  -- 原聊天 ID；关闭后不得改挂新聊天
  thread_id TEXT NOT NULL REFERENCES ai_threads(id) ON DELETE CASCADE,
  -- 聊天内单调递增序号；与聊天 ID 联合唯一
  seq INTEGER NOT NULL,
  -- 消息角色：user 用户原文，assistant 助手回复
  role TEXT NOT NULL CHECK(role IN ('user','assistant')),
  -- 原云端回合或稳定执行消息来源标识
  turn_id TEXT NOT NULL,
  -- 事实记录时点；UTC Unix 毫秒
  at INTEGER NOT NULL CHECK(at IS NULL OR typeof(at)='integer'),
  -- 消息来源 user/cloud/executor
  source TEXT NOT NULL DEFAULT 'cloud',
  -- 所属运行 ID；NULL 表示未关联执行
  run_id TEXT,
  -- 回复关联标识；可能为协助或卡片，不强制消息外键
  reply_to TEXT,
  -- 上下文撤回标志；本人历史可读，后续 AI 不得使用原文
  context_withdrawn INTEGER NOT NULL DEFAULT 0 CHECK(context_withdrawn IN (0,1)),
  -- 联合唯一性：thread_id,seq 在本表不能重复，为归属关联或请求防重提供稳定身份。
  UNIQUE(thread_id,seq)
);

-- 用户/图/命名空间隔离的 LangGraph 检查点索引；正文加密，写入受 generation 和运行租约栅栏约束。 原图失去授权后回收父记录与分块，不跨退休图恢复。
CREATE TABLE ai_checkpoints (
  -- 所属业务成员 ID；与图及上下游记录一致
  owner TEXT NOT NULL,
  -- LangGraph 图线程 ID，非聊天 ID
  thread TEXT NOT NULL,
  -- LangGraph 检查点命名空间
  ns TEXT NOT NULL,
  -- 稳定标识；保留存量身份
  id TEXT NOT NULL,
  -- 父检查点 ID；NULL 为图入口
  parent TEXT,
  -- LangGraph type+Base64 bytes 的整体密文或 v=2 分块标识；AAD 为 ai-checkpoint:<owner>，校验见 checkpointer
  checkpoint TEXT NOT NULL,
  -- 同属 LangGraph 元数据密文或 v=2 分块标识；AAD 为 ai-checkpoint:<owner>
  metadata TEXT NOT NULL,
  -- 事实记录时点；UTC Unix 毫秒
  at INTEGER NOT NULL CHECK(at IS NULL OR typeof(at)='integer'),
  -- 关系/唯一约束在写事务内生效；删除规则显式声明。
  PRIMARY KEY(owner,thread,ns,id)
);

-- LangGraph 尚未合并的写入；按图/检查点/任务/序号防重，内容加密并受图写入栅栏约束。 原图失去授权后回收写入与分块，不能恢复未知副作用。
CREATE TABLE ai_writes (
  -- 所属业务成员 ID；与图及上下游记录一致
  owner TEXT NOT NULL,
  -- LangGraph 图线程 ID，非聊天 ID
  thread TEXT NOT NULL,
  -- LangGraph 检查点命名空间
  ns TEXT NOT NULL,
  -- 父检查点 ID；与 owner/thread/ns 共同定位原检查点
  checkpoint TEXT NOT NULL,
  -- LangGraph 写入任务 ID
  task TEXT NOT NULL,
  -- LangGraph 任务路径，用于稳定排序
  path TEXT NOT NULL,
  -- pending write 序号；负值为框架保留通道
  idx INTEGER NOT NULL,
  -- LangGraph 写入通道名称
  channel TEXT NOT NULL,
  -- LangGraph 序列化对象密文或 v=2 分块标识；AAD 为 ai-checkpoint:<owner>，只允许所属图解密
  value TEXT NOT NULL,
  -- 关系/唯一约束在写事务内生效；删除规则显式声明。
  PRIMARY KEY(owner,thread,ns,checkpoint,task,idx)
);

-- 用户确认的长期偏好；值加密，显式删除时回收，不能扩大任务授权。
CREATE TABLE ai_memories (
  -- 所属业务成员 ID；与图及上下游记录一致
  owner TEXT NOT NULL REFERENCES members(id),
  -- 偏好命名空间
  namespace TEXT NOT NULL,
  -- 当前命名空间内唯一键；语义见模块入口
  key TEXT NOT NULL,
  -- 偏好 JSON 密文，格式 1；AAD 为 memory:<owner>:<namespace>:<key>，仅本人记忆接口读取
  value TEXT NOT NULL,
  -- 记录创建时点；UTC Unix 毫秒
  created_at INTEGER NOT NULL CHECK(created_at IS NULL OR typeof(created_at)='integer'),
  -- 最近业务更新时点；UTC Unix 毫秒
  updated_at INTEGER NOT NULL CHECK(updated_at IS NULL OR typeof(updated_at)='integer'),
  -- 关系/唯一约束在写事务内生效；删除规则显式声明。
  PRIMARY KEY(owner,namespace,key)
);

-- 模型调用防重与状态；结果正文独立保存。删除或过期后保留摘要和调用身份以阻止重放。
CREATE TABLE ai_calls (
  -- 稳定标识；保留存量身份
  id TEXT PRIMARY KEY NOT NULL,
  -- 所属业务成员 ID；由服务端授权，不接受网页扩权
  user_id TEXT NOT NULL REFERENCES members(id),
  -- 所属云端图 ID
  graph_id TEXT,
  -- 输入摘要；同一调用身份不能接受不同输入
  digest TEXT NOT NULL,
  -- 模型防重状态 reserved 预留、running 已提交、done 已完成、failed 失败、unknown 结果未知；unknown 不重放
  status TEXT NOT NULL CHECK(status IN ('reserved','running','done','failed','unknown')),
  -- 固定公开错误分类；不含秘密或上游正文
  error TEXT,
  -- 记录创建时点；UTC Unix 毫秒
  created_at INTEGER NOT NULL CHECK(created_at IS NULL OR typeof(created_at)='integer'),
  -- 最近业务更新时点；UTC Unix 毫秒
  updated_at INTEGER NOT NULL CHECK(updated_at IS NULL OR typeof(updated_at)='integer'),
  -- 所属运行 ID；NULL 表示未关联执行
  run_id TEXT,
  -- 调用转交模型出站的时点；NULL 表示未记录；UTC Unix 毫秒
  egress_started_at INTEGER CHECK(egress_started_at IS NULL OR typeof(egress_started_at)='integer')
);

-- 历史清理后保留的用户当日启动统计；上海日期维度，不是新的平台预算。
CREATE TABLE quota_carry (
  -- 所属业务成员 ID；由服务端授权，不接受网页扩权
  user_id TEXT NOT NULL,
  -- 上海时区 YYYY-MM-DD；用于当日统计
  day TEXT NOT NULL,
  -- 该日已保留的启动次数
  runs INTEGER NOT NULL,
  -- 关系/唯一约束在写事务内生效；删除规则显式声明。
  PRIMARY KEY(user_id,day)
);

-- 图的归属、输入摘要、代次及租约绑定；聊天撤回或清理先关闭此写入授权。
CREATE TABLE ai_graph_inputs (
  -- 所属业务成员 ID；与图及上下游记录一致
  owner TEXT NOT NULL,
  -- 稳定标识；保留存量身份
  id TEXT NOT NULL,
  -- 输入摘要；同一调用身份不能接受不同输入
  digest TEXT NOT NULL,
  -- 图写入授权标志；清理前先置零
  active INTEGER NOT NULL DEFAULT 1,
  -- 原聊天 ID；用于撤回和保留期定位
  parent_thread TEXT,
  -- 原回合 ID；NULL 为无回合绑定图
  parent_turn TEXT,
  -- 记录创建时点；UTC Unix 毫秒
  created_at INTEGER NOT NULL CHECK(created_at IS NULL OR typeof(created_at)='integer'),
  -- 图协议版本；旧版本不恢复
  graph_version TEXT NOT NULL DEFAULT 'relay-graph-4',
  -- 图用途：chat 聊天规划、help 执行协助；由 graphRuntime 校验
  kind TEXT NOT NULL DEFAULT 'chat',
  -- 图状态：pending 待运行、running 运行中、waiting 等待中断回复、done 完成、failed 失败、unknown 未知、cancelled 取消；inactive 不允许恢复
  status TEXT NOT NULL DEFAULT 'pending',
  -- 图或子进程代次；用于拒绝旧请求
  generation INTEGER NOT NULL DEFAULT 0,
  -- 所属运行 ID；NULL 表示未关联执行
  run_id TEXT,
  -- 运行租约代次；旧代次消息必须拒绝
  lease_epoch INTEGER,
  -- 固定公开错误分类；不含秘密或上游正文
  error TEXT,
  -- 关系/唯一约束在写事务内生效；删除规则显式声明。
  PRIMARY KEY(owner,id)
);

-- 聊天请求的有序 inbox；请求身份保留，正文在删除/过期时清除，重复交办不改投为补充。
CREATE TABLE conversation_inbox (
  -- inbox 全局入队顺序；线程内按其串行处理
  ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
  -- 稳定标识；保留存量身份
  id TEXT NOT NULL UNIQUE,
  -- 原聊天 ID；关闭后不得改挂新聊天
  thread_id TEXT NOT NULL REFERENCES ai_threads(id),
  -- 调用方生成的幂等请求 ID
  request_id TEXT NOT NULL,
  -- 输入摘要；同一调用身份不能接受不同输入
  digest TEXT NOT NULL,
  -- 原交办字符串，明文输入；仅原聊天处理入口读取，清理时置空，执行中敏感补充写入 message_bodies
  content TEXT NOT NULL,
  -- 请求用途；当前新交办使用 chat
  mode TEXT NOT NULL DEFAULT 'chat',
  -- 所属运行 ID；NULL 表示未关联执行
  run_id TEXT,
  -- 入队状态：pending 待处理、processing 已绑定回合、done 已消费、failed 失败或授权已撤回
  status TEXT NOT NULL DEFAULT 'pending',
  -- 记录创建时点；UTC Unix 毫秒
  created_at INTEGER NOT NULL CHECK(created_at IS NULL OR typeof(created_at)='integer'),
  -- 联合唯一性：thread_id,request_id 在本表不能重复，为归属关联或请求防重提供稳定身份。
  UNIQUE(thread_id,request_id)
);

-- 交办提交至调度的持久 outbox；与任务版本原子提交，只能投递到原聊天。 投递或撤回后进入 done，清空快照而保留原命令身份。
CREATE TABLE conversation_commands (
  -- 稳定标识；保留存量身份
  id TEXT PRIMARY KEY NOT NULL,
  -- 原聊天 ID；关闭后不得改挂新聊天
  thread_id TEXT NOT NULL REFERENCES ai_threads(id),
  -- 所属任务 ID
  task_id TEXT,
  -- 固化交办的 TaskDefinition JSON，格式 1；由 drainCommands 校验和投递，非当前任务定义权威
  run_task TEXT,
  -- 交办命令状态：pending 事务内待提交、committed 已提交待投递、done 已投递或被撤回
  state TEXT NOT NULL DEFAULT 'pending',
  -- 记录创建时点；UTC Unix 毫秒
  created_at INTEGER NOT NULL CHECK(created_at IS NULL OR typeof(created_at)='integer')
);

-- 已确认的执行条件与任务版本；保留既有调度能力，不作为新交办的前置要求。 历史清理回收条件正文及原运行关联记录。
CREATE TABLE run_conditions (
  -- 所属原运行 ID；必须关联执行
  run_id TEXT PRIMARY KEY NOT NULL REFERENCES runs(id),
  -- 所属任务 ID
  task_id TEXT NOT NULL REFERENCES tasks(id),
  -- 固定任务定义版本
  task_version INTEGER NOT NULL,
  -- 本运行内用户指令递增版本；补充消息推进，拒绝旧指令结果
  instruction_version INTEGER NOT NULL,
  -- Conditions JSON，格式 1，校验见 conditionsSchema；旧已确认调度条件的来源，非私密回复字段
  content TEXT NOT NULL,
  -- 记录创建时点；UTC Unix 毫秒
  created_at INTEGER NOT NULL CHECK(created_at IS NULL OR typeof(created_at)='integer'),
  -- 本人确认条件的时点；NULL 表示未确认；UTC Unix 毫秒
  confirmed_at INTEGER CHECK(confirmed_at IS NULL OR typeof(confirmed_at)='integer'),
  -- 本人确认后批准的任务版本；作用域为 task_id，NULL 表示尚未批准
  approved_version INTEGER,
  -- 本人确认的 Conditions JSON，格式 1；conditionsSchema 校验，NULL 表示尚未确认
  confirmed_content TEXT
);

-- 运行中的云端协助与用户回复绑定；属于原聊天、图、轮次和租约，等待节点不先执行浏览器副作用。 聊天/运行清理时回收请求和回复，终态协助证据由 DO alarm 清理。
CREATE TABLE execution_help (
  -- 稳定标识；保留存量身份
  id TEXT PRIMARY KEY NOT NULL,
  -- 所属原运行 ID；必须关联执行
  run_id TEXT NOT NULL,
  -- 原聊天 ID；关闭后不得改挂新聊天
  thread_id TEXT NOT NULL,
  -- 绑定的运行租约代次
  epoch INTEGER NOT NULL,
  -- ExecutionHelpRequest JSON，格式 1；校验见 executionHelpRequestSchema，敏感问题原文在 encryptedMessage 内按 help-request:<run_id>:<id> 加密
  request TEXT NOT NULL,
  -- HelpResponse JSON 包装，格式 1；execution-help 校验，其中 encrypted 按 help:<run_id>:<id> 加密，NULL 表示尚未回答，仅原运行/本人聊天授权读取
  response TEXT,
  -- 是否正在等待用户回复：0/1
  awaiting_user INTEGER NOT NULL DEFAULT 0,
  -- 绑定本轮协助的用户消息 ID
  reply_message_id TEXT,
  -- 记录创建时点；UTC Unix 毫秒
  created_at INTEGER NOT NULL CHECK(created_at IS NULL OR typeof(created_at)='integer'),
  -- 所属云端图 ID
  graph_id TEXT,
  -- LangGraph 等待中断 ID
  interrupt_id TEXT,
  -- 协助图内的问题轮次
  question_round INTEGER NOT NULL DEFAULT 0
);

-- 账号或无账号任务的独占锁；unknown 结果保留锁，确认浏览器清理后才按结果释放。
CREATE TABLE account_locks (
  -- 账号 ID 或 task:<任务ID> 的独占资源键
  account_key TEXT PRIMARY KEY NOT NULL,
  -- 所属原运行 ID；必须关联执行
  run_id TEXT NOT NULL
);

-- 云端图持久投递事件；D1 拥有状态，DO alarm 消费。重试只推进可恢复状态，不重放未知副作用。 清理时退休事件并清除消息绑定，事件身份不改投新聊天。
CREATE TABLE ai_dispatch (
  -- 稳定标识；保留存量身份
  id TEXT PRIMARY KEY NOT NULL,
  -- 所属云端图 ID
  graph_id TEXT NOT NULL,
  -- 原聊天 ID；关闭后不得改挂新聊天
  thread_id TEXT NOT NULL,
  -- 所属业务成员 ID；与图及上下游记录一致
  owner TEXT NOT NULL,
  -- 图事件用途：chat 聊天回合、help 首次协助、resume 回复恢复、refresh 上下文刷新
  kind TEXT NOT NULL CHECK(kind IN ('chat','help','resume','refresh','chat')),
  -- 原云端回合或稳定执行消息来源标识
  turn_id TEXT,
  -- 所属运行 ID；NULL 表示未关联执行
  run_id TEXT,
  -- 原协助记录 ID；NULL 表示非协助事件
  help_id TEXT,
  -- 恢复中断所绑定的用户消息 ID；NULL 表示不消费用户回复
  message_id TEXT,
  -- LangGraph 等待中断 ID
  interrupt_id TEXT,
  -- 协助图内的问题轮次
  question_round INTEGER,
  -- 投递状态：pending 待领取、running 租约内处理、done 完成、failed 失败、retired 授权撤回不再消费
  state TEXT NOT NULL DEFAULT 'pending'
 CHECK(state IN ('pending','running','done','failed','retired')),
  -- 图事件投递租约到期时点；NULL 表示尚未领取或已结束；UTC Unix 毫秒
  lease_until INTEGER CHECK(lease_until IS NULL OR typeof(lease_until)='integer'),
  -- 固定公开错误分类；不含秘密或上游正文
  error TEXT,
  -- 记录创建时点；UTC Unix 毫秒
  created_at INTEGER NOT NULL CHECK(created_at IS NULL OR typeof(created_at)='integer')
);

-- 图片对象退休墓碑；先仲裁 D1 发布再删除 DO，阻止迟到上传复活已删图片。 正文回收后继续保留对象墓碑。
CREATE TABLE evidence_retirements (
  -- 私有 DO 对象键；D1 引用为唯一发布事实
  object_key TEXT PRIMARY KEY NOT NULL,
  -- 对象退休仲裁时点；墓碑不随正文回收；UTC Unix 毫秒
  retired_at INTEGER NOT NULL CHECK(retired_at IS NULL OR typeof(retired_at)='integer')
);

-- LangGraph 检查点密文分块；按父检查点和字段排序，父记录删除时级联回收。
CREATE TABLE ai_checkpoint_chunks (
  -- 所属业务成员 ID；与图及上下游记录一致
  owner TEXT NOT NULL,
  -- LangGraph 图线程 ID，非聊天 ID
  thread TEXT NOT NULL,
  -- LangGraph 检查点命名空间
  ns TEXT NOT NULL,
  -- 父检查点 ID；与 owner/thread/ns 共同定位，父删除时级联清理
  checkpoint TEXT NOT NULL,
  -- 检查点分块字段 checkpoint/metadata
  field TEXT NOT NULL CHECK(field IN ('checkpoint','metadata')),
  -- 父 v=2 marker 的不可变分块身份；避免并发替换混入旧分块
  token TEXT NOT NULL,
  -- 从零开始的分块序号；读取必须完整且连续
  part INTEGER NOT NULL CHECK(part>=0),
  -- 父字段整体密文的连续字符串片段；按 token/part 重组后以 ai-checkpoint:<owner> 解密
  value TEXT NOT NULL,
  -- 关系/唯一约束在写事务内生效；删除规则显式声明。
  PRIMARY KEY(owner,thread,ns,checkpoint,field,part),
  -- 引用父资源身份；父记录删除时级联回收。
  FOREIGN KEY(owner,thread,ns,checkpoint) REFERENCES ai_checkpoints(owner,thread,ns,id) ON DELETE CASCADE
);

-- LangGraph pending write 密文分块；依附写入身份，级联回收，重复写入不能覆盖旧分块。
CREATE TABLE ai_write_chunks (
  -- 所属业务成员 ID；与图及上下游记录一致
  owner TEXT NOT NULL,
  -- LangGraph 图线程 ID，非聊天 ID
  thread TEXT NOT NULL,
  -- LangGraph 检查点命名空间
  ns TEXT NOT NULL,
  -- 父检查点 ID；与 owner/thread/ns/task/idx 定位写入身份
  checkpoint TEXT NOT NULL,
  -- LangGraph 写入任务 ID
  task TEXT NOT NULL,
  -- pending write 序号；负值为框架保留通道
  idx INTEGER NOT NULL,
  -- 父写入 v=2 marker 的不可变分块身份
  token TEXT NOT NULL,
  -- 从零开始的分块序号；读取必须完整且连续
  part INTEGER NOT NULL CHECK(part>=0),
  -- 父写入整体密文的连续字符串片段；按 token/part 重组后以 ai-checkpoint:<owner> 解密
  value TEXT NOT NULL,
  -- 关系/唯一约束在写事务内生效；删除规则显式声明。
  PRIMARY KEY(owner,thread,ns,checkpoint,task,idx,part),
  -- 引用父资源身份；父记录删除时级联回收。
  FOREIGN KEY(owner,thread,ns,checkpoint,task,idx) REFERENCES ai_writes(owner,thread,ns,checkpoint,task,idx) ON DELETE CASCADE
);

-- 用户请求的持久清理作业；request_id 防重，捕获固定范围后分批清理，失败可续作。 作业完成保留请求身份与完成状态，不复用为新清理范围。
CREATE TABLE history_cleanup_jobs (
  -- 稳定标识；保留存量身份
  id TEXT PRIMARY KEY NOT NULL,
  -- 所属业务成员 ID；由服务端授权，不接受网页扩权
  user_id TEXT NOT NULL,
  -- 调用方生成的幂等请求 ID
  request_id TEXT NOT NULL,
  -- 清理范围 all/task/clear/thread
  scope TEXT NOT NULL,
  -- 原清理目标任务或聊天 ID；NULL 仅用于 all 全量范围
  target_id TEXT,
  -- 清理状态：capturing 事务内捕获目标、pending 分批清理中、done 已完成；错误保留并可续作
  status TEXT NOT NULL DEFAULT 'capturing',
  -- 记录创建时点；UTC Unix 毫秒
  created_at INTEGER NOT NULL CHECK(created_at IS NULL OR typeof(created_at)='integer'),
  -- 最近业务更新时点；UTC Unix 毫秒
  updated_at INTEGER NOT NULL CHECK(updated_at IS NULL OR typeof(updated_at)='integer'),
  -- 固定公开错误分类；不含秘密或上游正文
  error TEXT,
  -- 联合唯一性：user_id,request_id 在本表不能重复，为归属关联或请求防重提供稳定身份。
  UNIQUE(user_id,request_id)
);

-- 清理作业固定目标及版本截止；不能将清理期间新建的数据纳入旧请求。 随作业保留完成标记和版本截止，不自动纳入新资源。
CREATE TABLE history_cleanup_targets (
  -- 所属历史清理作业 ID；固定目标仅由该作业推进
  job_id TEXT NOT NULL REFERENCES history_cleanup_jobs(id),
  -- 目标种类：task 任务截止版本、thread 原聊天、run 原运行；固定捕获后不扩大范围
  kind TEXT NOT NULL,
  -- 目标资源的稳定 ID；种类由原请求或清理目标 kind 确定
  resource_id TEXT NOT NULL,
  -- 清理捕获的任务版本上限；NULL 为非任务目标，不能扩大到后续新版本
  cutoff_version INTEGER,
  -- 目标是否完成清理：0 待处理、1 已完成
  done INTEGER NOT NULL DEFAULT 0,
  -- 关系/唯一约束在写事务内生效；删除规则显式声明。
  PRIMARY KEY(job_id,kind,resource_id)
);

-- 运行上传的不可变浏览器状态候选；绑定用户、设备、租约及凭据版本，清理确认后才可发布。
CREATE TABLE browser_state_candidates (
  -- 私有 DO 对象键；D1 引用为唯一发布事实
  object_key TEXT PRIMARY KEY NOT NULL,
  -- 所属业务成员 ID；由服务端授权，不接受网页扩权
  user_id TEXT NOT NULL,
  -- 所属站点账号 ID；NULL 表示临时环境或尚未选择账号
  account_id TEXT,
  -- 所属原运行 ID；必须关联执行
  run_id TEXT NOT NULL,
  -- 所属执行设备 ID
  device_id TEXT NOT NULL,
  -- 运行租约代次；旧代次消息必须拒绝
  lease_epoch INTEGER NOT NULL,
  -- 固定凭据版本；修改不覆盖已领取运行
  credential_version INTEGER NOT NULL,
  -- 浏览器状态撤销代次
  state_epoch INTEGER NOT NULL,
  -- 上传时读取的账号状态修订号
  base_revision INTEGER NOT NULL,
  -- 浏览器状态来源 origin JSON 数组，格式 1；browser-state 校验，属于不可变发布候选
  origins TEXT NOT NULL,
  -- 记录创建时点；UTC Unix 毫秒
  created_at INTEGER NOT NULL CHECK(created_at IS NULL OR typeof(created_at)='integer'),
  -- 记录或对象到期时点；UTC Unix 毫秒
  expires_at INTEGER NOT NULL CHECK(expires_at IS NULL OR typeof(expires_at)='integer'),
  -- 对象候选已退休标志，1 时禁止发布
  retired INTEGER NOT NULL DEFAULT 0,
  -- 发布时是否撤销旧状态引用：0/1
  clear_previous INTEGER NOT NULL DEFAULT 0,
  -- 联合唯一性：user_id,object_key 在本表不能重复，为归属关联或请求防重提供稳定身份。
  UNIQUE(user_id,object_key),
  -- 归属成员必须存在；成员仍被业务记录引用时拒绝直接删除，正文另行清理。
  FOREIGN KEY(user_id) REFERENCES members(id)
);

-- 浏览器状态对象退休墓碑；仅保留对象身份阻止迟到发布，不随正文清理删除。
CREATE TABLE browser_state_retirements (
  -- 私有 DO 对象键；D1 引用为唯一发布事实
  object_key TEXT PRIMARY KEY NOT NULL,
  -- 对象退休仲裁时点；墓碑不随正文回收；UTC Unix 毫秒
  retired_at INTEGER NOT NULL CHECK(retired_at IS NULL OR typeof(retired_at)='integer')
);

-- 一次交办固化的账号执行组；属于原任务、版本、用户和聊天，关闭/撤回后退休。
CREATE TABLE account_dispatch_groups (
  -- 稳定标识；保留存量身份
  id TEXT PRIMARY KEY NOT NULL,
  -- 所属任务 ID
  task_id TEXT NOT NULL,
  -- 固定任务定义版本
  task_version INTEGER NOT NULL,
  -- 原聊天 ID；关闭后不得改挂新聊天
  thread_id TEXT NOT NULL,
  -- 所属业务成员 ID；由服务端授权，不接受网页扩权
  user_id TEXT NOT NULL,
  -- 执行组状态：active 可推进、paused 暂停、completed 全部结束、cancelled 已取消、retired 已撤回
  state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','paused','completed','cancelled','retired')),
  -- 记录创建时点；UTC Unix 毫秒
  created_at INTEGER NOT NULL CHECK(created_at IS NULL OR typeof(created_at)='integer'),
  -- 最近业务更新时点；UTC Unix 毫秒
  updated_at INTEGER NOT NULL CHECK(updated_at IS NULL OR typeof(updated_at)='integer'),
  -- 创建交办时固化的成员数；与成员 INSERT 同事务保存，列表不重复逐行计数
  member_count INTEGER NOT NULL DEFAULT 0 CHECK(member_count>=0),
  -- 联合唯一性：user_id,id 在本表不能重复，为归属关联或请求防重提供稳定身份。
  UNIQUE(user_id,id),
  -- 归属成员必须存在；成员仍被业务记录引用时拒绝直接删除，正文另行清理。
  FOREIGN KEY(user_id) REFERENCES members(id),
  -- 复合归属约束确保同一用户；默认拒绝删除被引用身份，正文另行清理。
  FOREIGN KEY(user_id,task_id,task_version) REFERENCES task_versions(user_id,task_id,version),
  -- 复合归属约束确保同一用户；默认拒绝删除被引用身份，正文另行清理。
  FOREIGN KEY(user_id,thread_id) REFERENCES ai_threads(user_id,id)
);

-- 执行组有序成员；同组顺序串行，运行结果和浏览器清理均确认后推进。 依附执行组，物理删除父组时级联回收；运行身份独立保留。
CREATE TABLE account_dispatch_members (
  -- 所属账号轮转执行组 ID；执行组删除时级联删除成员
  group_id TEXT NOT NULL REFERENCES account_dispatch_groups(id) ON DELETE CASCADE,
  -- 执行组内从零开始的成员顺序
  position INTEGER NOT NULL,
  -- 所属站点账号 ID；NULL 表示临时环境或尚未选择账号
  account_id TEXT,
  -- 所属运行 ID；NULL 表示未关联执行
  run_id TEXT UNIQUE,
  -- 组成员状态：pending 待排队、enqueued 已创建运行、done 运行及清理已确认、cancelled 已取消
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','enqueued','done','cancelled')),
  -- 关系/唯一约束在写事务内生效；删除规则显式声明。
  PRIMARY KEY(group_id,position),
  -- 引用父资源身份；默认拒绝删除被引用身份，正文另行清理。
  FOREIGN KEY(account_id) REFERENCES accounts(id),
  -- 引用父资源身份；默认拒绝删除被引用身份，正文另行清理。
  FOREIGN KEY(run_id) REFERENCES runs(id)
);

-- 账号不可变凭据版本；账号为归属权威，运行固定版本。旧执行释放后才可回收非当前版本。
CREATE TABLE account_credential_versions (
  -- 所属站点账号 ID；必须关联账号
  account_id TEXT NOT NULL REFERENCES accounts(id),
  -- 本实体内的递增版本
  version INTEGER NOT NULL,
  -- 凭据 JSON 密文；AAD 为 account:<account_id>，仅本人设置/当前授权执行读取
  secret TEXT NOT NULL,
  -- 该凭据版本允许的公网登录 origin JSON 数组，格式 1；normalizeAccount 校验，凭据访问范围权威
  login_origins TEXT NOT NULL,
  -- 记录创建时点；UTC Unix 毫秒
  created_at INTEGER NOT NULL CHECK(created_at IS NULL OR typeof(created_at)='integer'),
  -- 关系/唯一约束在写事务内生效；删除规则显式声明。
  PRIMARY KEY(account_id,version)
);

-- 聊天中的账号保存/修改确认卡；属于用户与原运行。关闭聊天即清除密文，确认结果保留供同请求防重。
CREATE TABLE account_cards (
  -- 稳定标识；保留存量身份
  id TEXT PRIMARY KEY NOT NULL,
  -- 所属业务成员 ID；由服务端授权，不接受网页扩权
  user_id TEXT NOT NULL,
  -- 原聊天 ID；关闭后不得改挂新聊天
  thread_id TEXT NOT NULL,
  -- 所属原运行 ID；必须关联执行
  run_id TEXT NOT NULL,
  -- 运行租约代次；旧代次消息必须拒绝
  lease_epoch INTEGER NOT NULL,
  -- 确认卡种类：save 保存新账号、update 更新已有账号
  kind TEXT NOT NULL CHECK(kind IN ('save','update')),
  -- 所属站点账号 ID；NULL 表示临时环境或尚未选择账号
  account_id TEXT,
  -- 固定凭据版本；修改不覆盖已领取运行
  credential_version INTEGER,
  -- 浏览器状态撤销代次
  state_epoch INTEGER,
  -- 待保存凭据 JSON 密文；AAD 为 account-card:<id>，仅本人确认及原运行读取，过期/关闭清空
  secret TEXT,
  -- 确认卡状态：pending 待本人确认、saved 已保存、dismissed 已拒绝、expired 已过期或失去授权
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','saved','dismissed','expired')),
  -- 卡片输入摘要，用于绑定确认
  input_digest TEXT NOT NULL,
  -- 用户确认摘要，防止相同卡片被不同输入复用
  confirm_digest TEXT,
  -- 保存成功产生或更新的账号 ID；NULL 表示尚未保存
  result_account_id TEXT,
  -- 等待是否已恢复
  resumed INTEGER NOT NULL DEFAULT 0,
  -- 记录创建时点；UTC Unix 毫秒
  created_at INTEGER NOT NULL CHECK(created_at IS NULL OR typeof(created_at)='integer'),
  -- 记录或对象到期时点；UTC Unix 毫秒
  expires_at INTEGER NOT NULL CHECK(expires_at IS NULL OR typeof(expires_at)='integer'),
  -- 卡片等待后续账号更新标志
  wait_for_update INTEGER NOT NULL DEFAULT 0,
  -- 产生卡片时读取的用户消息序号
  user_seq INTEGER NOT NULL DEFAULT 0,
  -- 卡片身份摘要，防止将不同账号输入混为同一次确认
  identity_digest TEXT,
  -- 关系/唯一约束在写事务内生效；删除规则显式声明。
  CHECK(status<>'pending' OR identity_digest IS NOT NULL),
  -- 联合唯一性：user_id,id 在本表不能重复，为归属关联或请求防重提供稳定身份。
  UNIQUE(user_id,id),
  -- 归属成员必须存在；成员仍被业务记录引用时拒绝直接删除，正文另行清理。
  FOREIGN KEY(user_id) REFERENCES members(id),
  -- 复合归属约束确保同一用户；默认拒绝删除被引用身份，正文另行清理。
  FOREIGN KEY(user_id,thread_id) REFERENCES ai_threads(user_id,id),
  -- 复合归属约束确保同一用户；默认拒绝删除被引用身份，正文另行清理。
  FOREIGN KEY(user_id,run_id) REFERENCES runs(user_id,id),
  -- 复合归属约束确保同一用户；默认拒绝删除被引用身份，正文另行清理。
  FOREIGN KEY(user_id,account_id) REFERENCES accounts(user_id,id)
);

-- 模型配置主表；保存当前版本指针，版本正文和密钥只在 model_profile_versions。 版本仍被任务/聊天引用时拒绝物理删除，当前版本头与正文在同一事务写入。
CREATE TABLE models (
  -- 稳定标识；保留存量身份
  id TEXT PRIMARY KEY NOT NULL,
  -- 当前版本指针；版本正文独立存储
  current_version INTEGER NOT NULL,
  -- 记录创建时点；UTC Unix 毫秒
  created_at INTEGER NOT NULL CHECK(created_at IS NULL OR typeof(created_at)='integer'),
  -- 引用父资源身份；默认拒绝删除被引用身份，正文另行清理。版本头与正文必须在同事务完成，提交时校验。
  FOREIGN KEY(id,current_version) REFERENCES model_profile_versions(id,version) DEFERRABLE INITIALLY DEFERRED
);

-- 运行固化的执行快照；按运行唯一，不随任务后续修改变化。正文清理不删除运行安全身份。
CREATE TABLE run_snapshots (
  -- 所属原运行 ID；必须关联执行
  run_id TEXT PRIMARY KEY NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  -- TaskDefinition JSON 执行快照，格式 1；校验见 contracts，版本固定，不是当前任务定义权威
  task_snapshot TEXT NOT NULL,
  -- 本表 JSON/正文格式版本；当前仅支持 1
  format_version INTEGER NOT NULL DEFAULT 1 CHECK(format_version=1)
);

-- 运行最终回复正文；按运行唯一，事务提交时绑定租约，迟到请求不能替换已提交结果。 历史删除时可独立回收正文，运行安全状态继续保留。
CREATE TABLE run_results (
  -- 所属原运行 ID；必须关联执行
  run_id TEXT PRIMARY KEY NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  -- RunResult JSON，格式 1；校验见 contracts 的 runResultSchema，终态回复正文，安全状态以 runs 为准
  result TEXT NOT NULL,
  -- 本表 JSON/正文格式版本；当前仅支持 1
  format_version INTEGER NOT NULL DEFAULT 1 CHECK(format_version=1)
);

-- 聊天正文、异构 parts 与可选私密密文；同消息唯一，删除元数据时级联清理。
CREATE TABLE message_bodies (
  -- 稳定标识；保留存量身份
  id TEXT PRIMARY KEY NOT NULL REFERENCES ai_messages(id) ON DELETE CASCADE,
  -- 正文或公开占位；敏感原文仅存 private_content
  content TEXT NOT NULL DEFAULT '',
  -- 本人可解密的敏感正文，AAD 为 message:<thread_id>:<id>
  private_content TEXT,
  -- ChatPart[] JSON，格式由 format_version 声明；contracts/execution 校验，消息正文权威，禁止秘密进入网页执行环境
  parts TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(parts)),
  -- 本表 JSON/正文格式版本；当前仅支持 1
  format_version INTEGER NOT NULL DEFAULT 1 CHECK(format_version=1)
);

-- 模型调用加密响应；绑定调用 ID，加密上下文 ai-call:<id>，正文可清除但调用账本保留。
CREATE TABLE call_results (
  -- 稳定标识；保留存量身份
  id TEXT PRIMARY KEY NOT NULL REFERENCES ai_calls(id) ON DELETE CASCADE,
  -- ModelResponse 整体密文或 v=2 分块 marker；校验见 call-cache，AAD 为 ai-call:<id>，仅原授权调用读取
  result TEXT NOT NULL,
  -- 本表 JSON/正文格式版本；当前仅支持 1
  format_version INTEGER NOT NULL DEFAULT 1 CHECK(format_version=1)
);

-- 模型响应整体密文分块；id 为父调用 ID，token 绑定父 marker，part 从零连续；父正文删除时级联清理，不删除调用账本。
CREATE TABLE call_result_chunks (
  -- 父模型调用 ID；与父 call_results.id 关联，清理父正文时级联清理
  id TEXT NOT NULL REFERENCES call_results(id) ON DELETE CASCADE,
  -- 会话令牌或分块身份；仅服务端使用，不得记录
  token TEXT NOT NULL,
  -- 从零开始的分块序号；读取必须完整且连续
  part INTEGER NOT NULL CHECK(part>=0),
  -- 父 ModelResponse 整体密文的连续字符串片段；仅由父 v=2 marker 的 token/part 完整组装后按 ai-call:<id> 解密
  value TEXT NOT NULL,
  -- 关系/唯一约束在写事务内生效；删除规则显式声明。
  PRIMARY KEY(id,part)
);

-- 数据库结构版本标记；正常服务只支持本基线，不在请求路径迁移旧结构。 随库生命周期保留，服务请求不自动升级、删除或重建它。
CREATE TABLE storage_meta (
  -- 本实体内的递增版本
  version INTEGER PRIMARY KEY CHECK(version=2),
  -- 转换源库 SHA-256；NULL 为全新安装，用于阻止错误源库覆盖或恢复中断的转换
  source_digest TEXT
);

-- 维护窗口中的私有对象核验记录；绑定不可变对象键，全部引用核验后才允许激活，正常业务不写入。 仅维护窗口写入，随目标库保留核验身份，不删除对应私有对象。
CREATE TABLE storage_object_checks (
  -- 核验对象种类：evidence 私有图片、browser-state 私有浏览器状态
  kind TEXT NOT NULL CHECK(kind IN ('evidence','browser-state')),
  -- 私有 DO 对象键；D1 引用为唯一发布事实
  object_key TEXT NOT NULL,
  -- 离线转换对象校验完成时点；UTC Unix 毫秒
  verified_at INTEGER NOT NULL CHECK(verified_at IS NULL OR typeof(verified_at)='integer'),
  -- 关系/唯一约束在写事务内生效；删除规则显式声明。
  PRIMARY KEY(kind,object_key)
);

-- 按任务状态及 next_run_at 升序查找到期调度任务。
CREATE INDEX task_due ON tasks(status,next_run_at);

-- 按 queued 状态和创建时间领取最早排队运行。
CREATE INDEX run_queue ON runs(status,created_at);

-- 按原运行及状态查找既有核对运行，避免重复创建。
CREATE INDEX run_reconciliation ON runs(reconciliation_of,status);

-- 按用户和任务状态筛选本人任务。
CREATE INDEX tasks_owner ON tasks(user_id,status);

-- 按用户和状态读取排队/活动运行，创建时间保持队列顺序。
CREATE INDEX runs_owner_queue ON runs(user_id,status,created_at);

-- 按用户和上海日期统计实际启动次数。
CREATE INDEX runs_start_day ON runs(user_id,started_day);

-- 按认证用户查找及撤销其全部网站会话。
CREATE INDEX auth_session_user ON auth_session(userId);

-- 按认证用户查找登录提供方账号及密码记录。
CREATE INDEX auth_account_user ON auth_account(userId);

-- 按邮箱或验证标识定位认证证明。
CREATE INDEX auth_verification_identifier ON auth_verification(identifier);

-- 同一用户和任务最多一个未关闭 chat；compose 或 closed=1 不参与唯一约束。
CREATE UNIQUE INDEX ai_task_chat ON ai_threads(user_id,task_id) WHERE kind='chat' AND closed=0;

-- 按原聊天及入队状态消费 inbox，ordinal 升序维持原文顺序。
CREATE INDEX conversation_pending ON conversation_inbox(thread_id,status,ordinal);

-- 按任务查找既有条件记录，创建时间支持历史定位。
CREATE INDEX conditions_task ON run_conditions(task_id,created_at);

-- 按运行及创建时间查找协助轮次。
CREATE INDEX execution_help_run ON execution_help(run_id,created_at);

-- 按私有对象键仲裁图片引用与退休清理。
CREATE INDEX artifacts_object_key ON artifacts(object_key);

-- 按状态及更新时间查找待继续的清理作业。
CREATE INDEX history_cleanup_pending ON history_cleanup_jobs(status,updated_at);

-- 按资源种类和 ID 判断是否已纳入固定清理目标。
CREATE INDEX history_cleanup_resource ON history_cleanup_targets(kind,resource_id);

-- 按运行定位模型调用账本，停止与历史清理无需全表扫描。
CREATE INDEX ai_calls_run ON ai_calls(run_id);

-- 按运行查找其账号占用与 unknown 锁；账号资源键仍由主键唯一约束。
CREATE INDEX account_locks_run ON account_locks(run_id);

-- 按运行和创建时间查找浏览器状态发布候选。
CREATE INDEX browser_state_run ON browser_state_candidates(run_id,created_at);

-- 按执行组状态及创建时间推进活动或暂停组。
CREATE INDEX account_dispatch_active ON account_dispatch_groups(state,created_at);

-- 非空执行组内每个成员序号最多创建一个运行；独立运行不参与。
CREATE UNIQUE INDEX run_dispatch_member ON runs(dispatch_group_id,dispatch_index) WHERE dispatch_group_id IS NOT NULL;

-- 按设备、清理标志及状态查找浏览器清理占用。
CREATE INDEX run_device_cleanup ON runs(device_id,cleanup_pending,status);

-- 按用户、清理标志及状态查找未完成资源回收。
CREATE INDEX run_user_cleanup ON runs(user_id,cleanup_pending,status);

-- 按原运行及卡片状态定位确认卡。
CREATE INDEX account_cards_run ON account_cards(run_id,status);

-- 按卡片状态和到期时间回收待确认密文。
CREATE INDEX account_cards_expiry ON account_cards(status,expires_at);

-- 同一运行、租约和身份摘要最多一张 pending/saved 卡；摘要非空且未退休时参与唯一约束。
CREATE UNIQUE INDEX account_card_identity ON account_cards(run_id,lease_epoch,identity_digest)
 WHERE identity_digest IS NOT NULL AND status IN ('pending','saved');

-- 按运行和非空调用 ID 关联真实用量与模型耗时；无调用绑定记录不入索引。
CREATE INDEX model_usage_call_timing ON model_usage(run_id, call_id) WHERE call_id IS NOT NULL;

-- 指定用户、模型及任务查找未关闭聊天，按更新时间和 ID 倒序；条件 closed=0。
CREATE INDEX threads_lookup ON ai_threads(user_id,model_id,task_id,updated_at DESC,id DESC) WHERE closed=0;

-- 用户未删除任务的 created_at、ID 倒序键集分页；条件 deleted=0。
CREATE INDEX tasks_visible ON tasks(user_id,created_at DESC,id DESC) WHERE deleted=0;

-- 用户未关闭聊天的 updated_at、ID 倒序键集分页；条件 closed=0。
CREATE INDEX threads_visible ON ai_threads(user_id,updated_at DESC,id DESC) WHERE closed=0;

-- 读取聊天最新回合，按聊天内 version 倒序。
CREATE INDEX turns_version ON ai_turns(thread_id,version DESC);

-- 按运行读取实际用量，at、ID 提供稳定顺序。
CREATE INDEX usage_run ON model_usage(run_id,at,id);

-- 用户时间范围用量查询，at、ID 提供稳定顺序。
CREATE INDEX usage_user ON model_usage(user_id,at,id);

-- 聊天附件分批读取/删除，ID 稳定定位。
CREATE INDEX artifacts_thread ON artifacts(thread_id,id);

-- 运行附件读取/删除，ID 稳定定位。
CREATE INDEX artifacts_run ON artifacts(run_id,id);

-- 按长期标志及到期时点查找待回收附件。
CREATE INDEX artifacts_expiry ON artifacts(persistent,expires_at,id);

-- 按原聊天找到所属图，撤回授权及分页删除图正文。
CREATE INDEX graphs_thread ON ai_graph_inputs(parent_thread,owner,id);

-- 按运行找到所属图，停止及清理时不扫描其他运行。
CREATE INDEX graphs_run ON ai_graph_inputs(run_id,owner,id);

-- 任务活动运行查询，先定位任务再过滤运行状态。
CREATE INDEX runs_task ON runs(task_id,status);

-- 用户未删除运行的 created_at、ID 倒序键集分页；条件 history_deleted=0。
CREATE INDEX runs_history ON runs(user_id,created_at DESC,id DESC) WHERE history_deleted=0;

-- 未回复协助的聊天内时间倒序查询；只包含 awaiting_user=1 且无回复绑定。
CREATE INDEX help_waiting ON execution_help(thread_id,created_at DESC,id DESC) WHERE awaiting_user=1 AND reply_message_id IS NULL;

-- 按图查找待投递/执行中的事件，created_at、ID 保持原顺序。
CREATE INDEX dispatch_graph ON ai_dispatch(graph_id,state,created_at,id);

-- 单用户执行/清理占用唯一性；终态但浏览器未关闭仍持有占用。
CREATE UNIQUE INDEX run_user_active ON runs(user_id) WHERE status IN ('running','waiting_user','verifying') OR cleanup_pending=1;

-- 单设备执行/清理占用唯一性；账号 unknown 锁另行保留。
CREATE UNIQUE INDEX run_device_active ON runs(device_id) WHERE device_id IS NOT NULL AND (status IN ('running','waiting_user','verifying') OR cleanup_pending=1);

-- 按到期时间回收 Better Auth 会话。
CREATE INDEX auth_expiry ON auth_session(expiresAt);

-- 按用户、上海日期及预留种类统计个人额度。
CREATE INDEX quota_owner ON quota_reservations(user_id,day,kind);

-- 按原聊天和状态查找账号卡片。
CREATE INDEX cards_thread ON account_cards(thread_id,status,id);

-- 图投递按状态及租约到期时点唤醒；graph_id 关联原图。
CREATE INDEX graph_pending ON ai_dispatch(state,lease_until,graph_id);

-- 按聊天分页清理协助，ID 为稳定游标。
CREATE INDEX help_thread ON execution_help(thread_id,id);

-- 按作业查找未完成固定目标，按种类及资源 ID 分批清理。
CREATE INDEX cleanup_targets ON history_cleanup_targets(job_id,done,kind,resource_id);

-- 事务内保护 run_queue_limit：保持停止、租约/归属、限流或删除撤回约束，不能改为先读后写。
CREATE TRIGGER run_queue_limit BEFORE INSERT ON runs
WHEN NEW.status='queued' AND NOT EXISTS(SELECT 1 FROM runs WHERE idempotency_key=NEW.idempotency_key)
BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM members WHERE id=NEW.user_id AND disabled=0) THEN RAISE(ABORT,'USER_DISABLED') END;
 SELECT CASE WHEN (SELECT COUNT(*) FROM runs WHERE user_id=NEW.user_id AND status='queued') >= (SELECT queued_runs FROM members WHERE id=NEW.user_id) THEN RAISE(ABORT,'QUEUE_LIMIT') END;
END;

-- 事务内保护 task_schedule_insert：保持停止、租约/归属、限流或删除撤回约束，不能改为先读后写。
CREATE TRIGGER task_schedule_insert BEFORE INSERT ON tasks
WHEN NEW.status IN ('active','pending_validation') AND NEW.schedule_kind='cron'
BEGIN
 SELECT CASE WHEN (SELECT COUNT(*) FROM tasks WHERE user_id=NEW.user_id AND status IN ('active','pending_validation') AND schedule_kind='cron') >= (SELECT scheduled_tasks FROM members WHERE id=NEW.user_id) THEN RAISE(ABORT,'SCHEDULE_QUOTA_EXCEEDED') END;
END;

-- 事务内保护 task_schedule_update：保持停止、租约/归属、限流或删除撤回约束，不能改为先读后写。
CREATE TRIGGER task_schedule_update BEFORE UPDATE ON tasks
WHEN NEW.status IN ('active','pending_validation') AND NEW.schedule_kind='cron'
 AND (OLD.status NOT IN ('active','pending_validation') OR OLD.schedule_kind<>'cron' OR OLD.user_id<>NEW.user_id)
BEGIN
 SELECT CASE WHEN (SELECT COUNT(*) FROM tasks WHERE id<>NEW.id AND user_id=NEW.user_id AND status IN ('active','pending_validation') AND schedule_kind='cron') >= (SELECT scheduled_tasks FROM members WHERE id=NEW.user_id) THEN RAISE(ABORT,'SCHEDULE_QUOTA_EXCEEDED') END;
END;

-- 事务内保护 password_revoke：保持停止、租约/归属、限流或删除撤回约束，不能改为先读后写。
CREATE TRIGGER password_revoke AFTER UPDATE OF password ON auth_account
WHEN NEW.password IS NOT OLD.password
BEGIN DELETE FROM auth_session WHERE userId=NEW.userId; END;

-- 事务内保护 memory_limit：保持停止、租约/归属、限流或删除撤回约束，不能改为先读后写。
CREATE TRIGGER memory_limit BEFORE INSERT ON ai_memories
WHEN NOT EXISTS(SELECT 1 FROM ai_memories WHERE owner=NEW.owner AND namespace=NEW.namespace AND key=NEW.key)
BEGIN
 SELECT CASE WHEN (SELECT COUNT(*) FROM ai_memories WHERE owner=NEW.owner)>=100 THEN RAISE(ABORT,'MEMORY_LIMIT') END;
END;

-- 事务内保护 claim_carry_guard：保持停止、租约/归属、限流或删除撤回约束，不能改为先读后写。
CREATE TRIGGER claim_carry_guard BEFORE UPDATE OF status ON runs
WHEN OLD.status='queued' AND NEW.status='running'
 AND NOT EXISTS(SELECT 1 FROM members WHERE id=NEW.user_id AND (daily_quota_paused=1 OR daily_quota_paused_until>CAST(unixepoch('subsec')*1000 AS INTEGER)))
BEGIN
 SELECT CASE WHEN (SELECT COUNT(*) FROM runs WHERE user_id=NEW.user_id AND started_day=NEW.started_day) + COALESCE((SELECT runs FROM quota_carry WHERE user_id=NEW.user_id AND day=NEW.started_day),0) >= (SELECT daily_runs FROM members WHERE id=NEW.user_id) THEN RAISE(ABORT,'RUN_QUOTA_EXCEEDED') END;
END;

-- 事务内保护 cleanup_run_conditions_insert：保持停止、租约/归属、限流或删除撤回约束，不能改为先读后写。
CREATE TRIGGER cleanup_run_conditions_insert BEFORE INSERT ON run_conditions
 WHEN EXISTS(SELECT 1 FROM runs WHERE id=NEW.run_id AND history_deleted=1)
 BEGIN SELECT RAISE(IGNORE); END;

-- 事务内保护 cleanup_run_conditions_update：保持停止、租约/归属、限流或删除撤回约束，不能改为先读后写。
CREATE TRIGGER cleanup_run_conditions_update BEFORE UPDATE ON run_conditions
 WHEN EXISTS(SELECT 1 FROM runs WHERE id=NEW.run_id AND history_deleted=1)
 BEGIN SELECT RAISE(IGNORE); END;

-- 事务内保护 cleanup_execution_help_insert：保持停止、租约/归属、限流或删除撤回约束，不能改为先读后写。
CREATE TRIGGER cleanup_execution_help_insert BEFORE INSERT ON execution_help
 WHEN EXISTS(SELECT 1 FROM runs WHERE id=NEW.run_id AND history_deleted=1)
 BEGIN SELECT RAISE(IGNORE); END;

-- 事务内保护 cleanup_execution_help_update：保持停止、租约/归属、限流或删除撤回约束，不能改为先读后写。
CREATE TRIGGER cleanup_execution_help_update BEFORE UPDATE ON execution_help
 WHEN EXISTS(SELECT 1 FROM runs WHERE id=NEW.run_id AND history_deleted=1)
 BEGIN SELECT RAISE(IGNORE); END;

-- 事务内保护 claim_guard：保持停止、租约/归属、限流或删除撤回约束，不能改为先读后写。
CREATE TRIGGER claim_guard BEFORE UPDATE OF status ON runs
WHEN OLD.status='queued' AND NEW.status='running'
BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM members WHERE id=NEW.user_id AND disabled=0) THEN RAISE(ABORT,'USER_DISABLED') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM runs WHERE id<>NEW.id AND (status IN ('running','waiting_user','verifying') OR cleanup_pending=1) AND (user_id=NEW.user_id OR device_id=NEW.device_id)) THEN RAISE(ABORT,'CLAIM_BUSY') END;
 SELECT CASE WHEN (SELECT COUNT(*) FROM runs WHERE user_id=NEW.user_id AND started_day=NEW.started_day) >= (SELECT daily_runs FROM members WHERE id=NEW.user_id)
   AND NOT EXISTS(SELECT 1 FROM members WHERE id=NEW.user_id AND (daily_quota_paused=1 OR daily_quota_paused_until>CAST(unixepoch('subsec')*1000 AS INTEGER))) THEN RAISE(ABORT,'RUN_QUOTA_EXCEEDED') END;
 SELECT CASE WHEN NEW.account_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM accounts WHERE id=NEW.account_id AND user_id=NEW.user_id) THEN RAISE(ABORT,'ACCOUNT_DEVICE_MISMATCH') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM devices WHERE id=NEW.device_id AND revoked=0 AND claim_ready=1) THEN RAISE(ABORT,'CLAIM_BUSY') END;
 SELECT CASE WHEN NEW.dispatch_group_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM account_dispatch_groups WHERE id=NEW.dispatch_group_id AND state='active') THEN RAISE(ABORT,'CLAIM_BUSY') END;
END;

-- 事务内保护 claim_record：保持停止、租约/归属、限流或删除撤回约束，不能改为先读后写。
CREATE TRIGGER claim_record AFTER UPDATE OF status ON runs
WHEN OLD.status='queued' AND NEW.status='running'
BEGIN
 UPDATE members SET last_claim_at=NEW.updated_at WHERE id=NEW.user_id;
 UPDATE accounts SET assigned_device_id=NEW.device_id WHERE id=NEW.account_id AND user_id=NEW.user_id;
END;

-- 事务内保护 account_dispatch_thread_closed：保持停止、租约/归属、限流或删除撤回约束，不能改为先读后写。
CREATE TRIGGER account_dispatch_thread_closed AFTER UPDATE OF closed ON ai_threads
WHEN NEW.closed=1
BEGIN
 UPDATE account_dispatch_groups SET state='retired' WHERE thread_id=NEW.id AND state IN ('active','paused');
 UPDATE account_dispatch_members SET state='cancelled' WHERE group_id IN(SELECT id FROM account_dispatch_groups WHERE thread_id=NEW.id) AND state='pending';
END;

-- 事务内保护 account_dispatch_task_retired：保持停止、租约/归属、限流或删除撤回约束，不能改为先读后写。
CREATE TRIGGER account_dispatch_task_retired AFTER UPDATE OF context_withdrawn,deleted ON tasks
WHEN NEW.context_withdrawn=1 OR NEW.deleted=1
BEGIN
 UPDATE account_dispatch_groups SET state='retired' WHERE task_id=NEW.id AND state IN ('active','paused');
 UPDATE account_dispatch_members SET state='cancelled' WHERE group_id IN(SELECT id FROM account_dispatch_groups WHERE task_id=NEW.id) AND state='pending';
END;

-- 事务内保护 account_dispatch_user_disabled：保持停止、租约/归属、限流或删除撤回约束，不能改为先读后写。
CREATE TRIGGER account_dispatch_user_disabled AFTER UPDATE OF disabled ON members
WHEN NEW.disabled=1
BEGIN
 UPDATE account_dispatch_groups SET state='cancelled' WHERE user_id=NEW.id AND state IN ('active','paused');
 UPDATE account_dispatch_members SET state='cancelled' WHERE group_id IN(SELECT id FROM account_dispatch_groups WHERE user_id=NEW.id) AND state='pending';
END;

-- 事务内保护 account_dispatch_task_revised：保持停止、租约/归属、限流或删除撤回约束，不能改为先读后写。
CREATE TRIGGER account_dispatch_task_revised AFTER UPDATE OF version ON tasks
WHEN NEW.version<>OLD.version
BEGIN
 UPDATE account_dispatch_groups SET state='retired' WHERE task_id=NEW.id AND task_version<>NEW.version AND state IN ('active','paused');
 UPDATE account_dispatch_members SET state='cancelled' WHERE group_id IN(SELECT id FROM account_dispatch_groups WHERE task_id=NEW.id AND state='retired') AND state='pending';
 UPDATE runs SET cancel_requested=1,status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END
  WHERE dispatch_group_id IN(SELECT id FROM account_dispatch_groups WHERE task_id=NEW.id AND state='retired') AND status IN ('queued','running','waiting_user','verifying');
END;

-- 事务内保护 account_cards_close：保持停止、租约/归属、限流或删除撤回约束，不能改为先读后写。
CREATE TRIGGER account_cards_close AFTER UPDATE OF closed ON ai_threads WHEN NEW.closed=1
 BEGIN UPDATE account_cards SET status=CASE WHEN status='pending' THEN 'expired' ELSE status END,secret=NULL WHERE thread_id=NEW.id; END;

-- 事务内保护 account_cards_withdraw：保持停止、租约/归属、限流或删除撤回约束，不能改为先读后写。
CREATE TRIGGER account_cards_withdraw AFTER UPDATE OF context_withdrawn,history_deleted ON runs
 WHEN NEW.context_withdrawn=1 OR NEW.history_deleted=1
 BEGIN UPDATE account_cards SET status=CASE WHEN status='pending' THEN 'expired' ELSE status END,secret=NULL WHERE run_id=NEW.id; END;

-- 事务内保护 release_claim_barrier：保持停止、租约/归属、限流或删除撤回约束，不能改为先读后写。
CREATE TRIGGER release_claim_barrier BEFORE UPDATE OF status ON runs
WHEN OLD.status='queued' AND NEW.status='running'
BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM settings WHERE (key='claimsEnabled' AND value='0') OR (key='maintenance' AND value='1')) THEN RAISE(ABORT,'CLAIM_BUSY') END;
END;

-- 新读模型只组合当前结构；不提供旧表同名兼容视图。
CREATE VIEW task_details AS SELECT t.*,v.definition FROM tasks t JOIN task_versions v ON v.task_id=t.id AND v.version=t.version;
CREATE VIEW run_details AS SELECT r.*,s.task_snapshot,x.result FROM runs r LEFT JOIN run_snapshots s ON s.run_id=r.id LEFT JOIN run_results x ON x.run_id=r.id;
CREATE VIEW message_details AS SELECT m.*,b.content,b.private_content,b.parts FROM ai_messages m JOIN message_bodies b ON b.id=m.id;
CREATE VIEW call_details AS SELECT c.*,r.result FROM ai_calls c LEFT JOIN call_results r ON r.id=c.id;
CREATE VIEW account_details AS SELECT a.*,v.secret,v.login_origins FROM accounts a JOIN account_credential_versions v ON v.account_id=a.id AND v.version=a.credential_version;

INSERT INTO storage_meta(version) VALUES(2);
INSERT INTO settings(key,value) VALUES('maintenance','0'),('claimsEnabled','1'),('retentionDays','30');

-- 新模型版本发布当前指针；同事务维护，迟到的低版本不得覆盖高版本。
CREATE TRIGGER model_version_current AFTER INSERT ON model_profile_versions BEGIN
INSERT INTO models(id,current_version,created_at) VALUES(NEW.id,NEW.version,NEW.created_at) ON CONFLICT(id) DO UPDATE SET current_version=MAX(models.current_version,excluded.current_version);
END;

-- 正文发布与删除标记在同一事务仲裁；删除后的迟到收尾仍可更新安全状态，禁止恢复正文。
CREATE TRIGGER run_snapshots_deleted_insert BEFORE INSERT ON run_snapshots
WHEN EXISTS(SELECT 1 FROM runs WHERE id=NEW.run_id AND history_deleted=1) BEGIN SELECT RAISE(ABORT,'RUN_HISTORY_DELETED'); END;

-- 正文发布与删除标记在同一事务仲裁；删除后的迟到收尾仍可更新安全状态，禁止恢复正文。
CREATE TRIGGER run_snapshots_deleted_update BEFORE UPDATE ON run_snapshots
WHEN EXISTS(SELECT 1 FROM runs WHERE id=NEW.run_id AND history_deleted=1) BEGIN SELECT RAISE(ABORT,'RUN_HISTORY_DELETED'); END;

-- 正文发布与删除标记在同一事务仲裁；删除后的迟到收尾仍可更新安全状态，禁止恢复正文。
CREATE TRIGGER run_results_deleted_insert BEFORE INSERT ON run_results
WHEN EXISTS(SELECT 1 FROM runs WHERE id=NEW.run_id AND history_deleted=1) BEGIN SELECT RAISE(ABORT,'RUN_HISTORY_DELETED'); END;

-- 正文发布与删除标记在同一事务仲裁；删除后的迟到收尾仍可更新安全状态，禁止恢复正文。
CREATE TRIGGER run_results_deleted_update BEFORE UPDATE ON run_results
WHEN EXISTS(SELECT 1 FROM runs WHERE id=NEW.run_id AND history_deleted=1) BEGIN SELECT RAISE(ABORT,'RUN_HISTORY_DELETED'); END;
