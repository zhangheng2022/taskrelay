/** D1 新基线的 Drizzle 列/关系映射；SQL 迁移是结构与延迟外键的唯一权威。
 * 表与字段中文说明随 SQL 同步，结构测试核对列、主键、外键及索引，禁止从 ORM 自动覆盖生产结构。 */
import {
  sqliteTable,
  text,
  integer,
  primaryKey,
  index,
  uniqueIndex,
  foreignKey,
  check,
  type SQLiteTableExtraConfigValue,
} from "drizzle-orm/sqlite-core";
import { sql, desc } from "drizzle-orm";

/** 聊天中的账号保存/修改确认卡；属于用户与原运行。关闭聊天即清除密文，确认结果保留供同请求防重。 */
export const accountCards = sqliteTable(
  "account_cards",
  {
    /** 稳定标识；保留存量身份 */
    id: text("id").primaryKey(),
    /** 所属业务成员 ID；由服务端授权，不接受网页扩权 */
    userId: text("user_id").notNull(),
    /** 原聊天 ID；关闭后不得改挂新聊天 */
    threadId: text("thread_id").notNull(),
    /** 所属原运行 ID；必须关联执行 */
    runId: text("run_id").notNull(),
    /** 运行租约代次；旧代次消息必须拒绝 */
    leaseEpoch: integer("lease_epoch").notNull(),
    /** 确认卡种类：save 保存新账号、update 更新已有账号 */
    kind: text("kind").notNull(),
    /** 所属站点账号 ID；NULL 表示临时环境或尚未选择账号 */
    accountId: text("account_id"),
    /** 固定凭据版本；修改不覆盖已领取运行 */
    credentialVersion: integer("credential_version"),
    /** 浏览器状态撤销代次 */
    stateEpoch: integer("state_epoch"),
    /** 待保存凭据 JSON 密文；AAD 为 account-card:<id>，仅本人确认及原运行读取，过期/关闭清空 */
    secret: text("secret"),
    /** 确认卡状态：pending 待本人确认、saved 已保存、dismissed 已拒绝、expired 已过期或失去授权 */
    status: text("status").notNull().default("pending"),
    /** 卡片输入摘要，用于绑定确认 */
    inputDigest: text("input_digest").notNull(),
    /** 用户确认摘要，防止相同卡片被不同输入复用 */
    confirmDigest: text("confirm_digest"),
    /** 保存成功产生或更新的账号 ID；NULL 表示尚未保存 */
    resultAccountId: text("result_account_id"),
    /** 等待是否已恢复 */
    resumed: integer("resumed").notNull().default(0),
    /** 记录创建时点；UTC Unix 毫秒 */
    createdAt: integer("created_at").notNull(),
    /** 记录或对象到期时点；UTC Unix 毫秒 */
    expiresAt: integer("expires_at").notNull(),
    /** 卡片等待后续账号更新标志 */
    waitForUpdate: integer("wait_for_update").notNull().default(0),
    /** 产生卡片时读取的用户消息序号 */
    userSeq: integer("user_seq").notNull().default(0),
    /** 卡片身份摘要，防止将不同账号输入混为同一次确认 */
    identityDigest: text("identity_digest"),
  },
  (t): SQLiteTableExtraConfigValue[] => [
    /** 与 SQL 基线同源的校验约束；不得在 ORM 迁移中放宽。 */
    check("account_cards_check_0", sql.raw("kind IN ('save','update')")),
    /** 与 SQL 基线同源的校验约束；不得在 ORM 迁移中放宽。 */
    check("account_cards_check_1", sql.raw("status IN ('pending','saved','dismissed','expired')")),
    /** 与 SQL 基线同源的校验约束；不得在 ORM 迁移中放宽。 */
    check("account_cards_check_2", sql.raw("created_at IS NULL OR typeof(created_at)='integer'")),
    /** 与 SQL 基线同源的校验约束；不得在 ORM 迁移中放宽。 */
    check("account_cards_check_3", sql.raw("expires_at IS NULL OR typeof(expires_at)='integer'")),
    /** 与 SQL 基线同源的校验约束；不得在 ORM 迁移中放宽。 */
    check("account_cards_check_4", sql.raw("status<>'pending' OR identity_digest IS NOT NULL")),

    /** 按原聊天和状态查找账号卡片。 */
    index("cards_thread").on(t.threadId, t.status, t.id),
    /** 同一运行、租约和身份摘要最多一张 pending/saved 卡；摘要非空且未退休时参与唯一约束。 */
    uniqueIndex("account_card_identity")
      .on(t.runId, t.leaseEpoch, t.identityDigest)
      .where(sql.raw("identity_digest IS NOT NULL AND status IN ('pending','saved')")),
    /** 按卡片状态和到期时间回收待确认密文。 */
    index("account_cards_expiry").on(t.status, t.expiresAt),
    /** 按原运行及卡片状态定位确认卡。 */
    index("account_cards_run").on(t.runId, t.status),
    uniqueIndex("account_cards_unique_4").on(t.userId, t.id),
    foreignKey({
      columns: [t.userId, t.accountId],
      foreignColumns: [accounts.userId, accounts.id],
    }),
    foreignKey({ columns: [t.userId, t.runId], foreignColumns: [runs.userId, runs.id] }),
    foreignKey({
      columns: [t.userId, t.threadId],
      foreignColumns: [aiThreads.userId, aiThreads.id],
    }),
    foreignKey({ columns: [t.userId], foreignColumns: [members.id] }),
  ],
);

/** 账号不可变凭据版本；账号为归属权威，运行固定版本。旧执行释放后才可回收非当前版本。 */
export const accountCredentialVersions = sqliteTable(
  "account_credential_versions",
  {
    /** 所属站点账号 ID；必须关联账号 */
    accountId: text("account_id").notNull(),
    /** 本实体内的递增版本 */
    version: integer("version").notNull(),
    /** 凭据 JSON 密文；AAD 为 account:<account_id>，仅本人设置/当前授权执行读取 */
    secret: text("secret").notNull(),
    /** 该凭据版本允许的公网登录 origin JSON 数组，格式 1；normalizeAccount 校验，凭据访问范围权威 */
    loginOrigins: text("login_origins").notNull(),
    /** 记录创建时点；UTC Unix 毫秒 */
    createdAt: integer("created_at").notNull(),
  },
  (t): SQLiteTableExtraConfigValue[] => [
    /** 与 SQL 基线同源的校验约束；不得在 ORM 迁移中放宽。 */
    check(
      "account_credential_versions_check_0",
      sql.raw("created_at IS NULL OR typeof(created_at)='integer'"),
    ),

    primaryKey({ columns: [t.accountId, t.version] }),
    foreignKey({ columns: [t.accountId], foreignColumns: [accounts.id] }),
  ],
);

/** 一次交办固化的账号执行组；属于原任务、版本、用户和聊天，关闭/撤回后退休。 */
export const accountDispatchGroups = sqliteTable(
  "account_dispatch_groups",
  {
    /** 稳定标识；保留存量身份 */
    id: text("id").primaryKey(),
    /** 所属任务 ID */
    taskId: text("task_id").notNull(),
    /** 固定任务定义版本 */
    taskVersion: integer("task_version").notNull(),
    /** 原聊天 ID；关闭后不得改挂新聊天 */
    threadId: text("thread_id").notNull(),
    /** 所属业务成员 ID；由服务端授权，不接受网页扩权 */
    userId: text("user_id").notNull(),
    /** 执行组状态：active 可推进、paused 暂停、completed 全部结束、cancelled 已取消、retired 已撤回 */
    state: text("state").notNull().default("active"),
    /** 记录创建时点；UTC Unix 毫秒 */
    createdAt: integer("created_at").notNull(),
    /** 最近业务更新时点；UTC Unix 毫秒 */
    updatedAt: integer("updated_at").notNull(),
    /** 创建交办时固化的成员数；与成员 INSERT 同事务保存，列表不重复逐行计数 */
    memberCount: integer("member_count").notNull().default(0),
  },
  (t): SQLiteTableExtraConfigValue[] => [
    /** 与 SQL 基线同源的校验约束；不得在 ORM 迁移中放宽。 */
    check(
      "account_dispatch_groups_check_0",
      sql.raw("state IN ('active','paused','completed','cancelled','retired')"),
    ),
    /** 与 SQL 基线同源的校验约束；不得在 ORM 迁移中放宽。 */
    check(
      "account_dispatch_groups_check_1",
      sql.raw("created_at IS NULL OR typeof(created_at)='integer'"),
    ),
    /** 与 SQL 基线同源的校验约束；不得在 ORM 迁移中放宽。 */
    check(
      "account_dispatch_groups_check_2",
      sql.raw("updated_at IS NULL OR typeof(updated_at)='integer'"),
    ),
    /** 与 SQL 基线同源的校验约束；不得在 ORM 迁移中放宽。 */
    check("account_dispatch_groups_check_3", sql.raw("member_count>=0")),

    /** 按执行组状态及创建时间推进活动或暂停组。 */
    index("account_dispatch_active").on(t.state, t.createdAt),
    uniqueIndex("account_dispatch_groups_unique_1").on(t.userId, t.id),
    foreignKey({
      columns: [t.userId, t.threadId],
      foreignColumns: [aiThreads.userId, aiThreads.id],
    }),
    foreignKey({
      columns: [t.userId, t.taskId, t.taskVersion],
      foreignColumns: [taskVersions.userId, taskVersions.taskId, taskVersions.version],
    }),
    foreignKey({ columns: [t.userId], foreignColumns: [members.id] }),
  ],
);

/** 执行组有序成员；同组顺序串行，运行结果和浏览器清理均确认后推进。 依附执行组，物理删除父组时级联回收；运行身份独立保留。 */
export const accountDispatchMembers = sqliteTable(
  "account_dispatch_members",
  {
    /** 所属账号轮转执行组 ID；执行组删除时级联删除成员 */
    groupId: text("group_id").notNull(),
    /** 执行组内从零开始的成员顺序 */
    position: integer("position").notNull(),
    /** 所属站点账号 ID；NULL 表示临时环境或尚未选择账号 */
    accountId: text("account_id"),
    /** 所属运行 ID；NULL 表示未关联执行 */
    runId: text("run_id"),
    /** 组成员状态：pending 待排队、enqueued 已创建运行、done 运行及清理已确认、cancelled 已取消 */
    state: text("state").notNull().default("pending"),
  },
  (t): SQLiteTableExtraConfigValue[] => [
    /** 与 SQL 基线同源的校验约束；不得在 ORM 迁移中放宽。 */
    check(
      "account_dispatch_members_check_0",
      sql.raw("state IN ('pending','enqueued','done','cancelled')"),
    ),

    primaryKey({ columns: [t.groupId, t.position] }),
    uniqueIndex("account_dispatch_members_unique_1").on(t.runId),
    foreignKey({ columns: [t.runId], foreignColumns: [runs.id] }),
    foreignKey({ columns: [t.accountId], foreignColumns: [accounts.id] }),
    foreignKey({ columns: [t.groupId], foreignColumns: [accountDispatchGroups.id] }).onDelete(
      "cascade",
    ),
  ],
);

/** 账号或无账号任务的独占锁；unknown 结果保留锁，确认浏览器清理后才按结果释放。 */
export const accountLocks = sqliteTable(
  "account_locks",
  {
    /** 账号 ID 或 task:<任务ID> 的独占资源键 */
    accountKey: text("account_key").primaryKey(),
    /** 所属原运行 ID；必须关联执行 */
    runId: text("run_id").notNull(),
  },
  (t): SQLiteTableExtraConfigValue[] => [
    /** 按运行查找其账号占用与 unknown 锁；账号资源键仍由主键唯一约束。 */
    index("account_locks_run").on(t.runId),
  ],
);

/** 用户站点账号及浏览器状态发布权；凭据正文只在版本表，主表不保存密码副本。 凭据版本或运行仍引用时拒绝物理删除；撤销浏览器状态先退休对象再清除引用。 */
export const accounts = sqliteTable(
  "accounts",
  {
    /** 是否启用；停用会失败关联排队与执行任务 */
    enabled: integer("enabled").notNull().default(1),
    /** 管理操作代次 */
    managementVersion: integer("management_version").notNull().default(1),
    /** 本次状态修改的事务身份 */
    managementToken: text("management_token"),
    /** 稳定标识；保留存量身份 */
    id: text("id").primaryKey(),
    /** 界面显示名称 */
    name: text("name").notNull(),
    /** 凭据适用的公网站点 origin */
    origin: text("origin").notNull(),
    /** 脱敏用户名展示提示 */
    usernameHint: text("username_hint").notNull(),
    /** 记录创建时点；UTC Unix 毫秒 */
    createdAt: integer("created_at").notNull(),
    /** 所属业务成员 ID；由服务端授权，不接受网页扩权 */
    userId: text("user_id").notNull(),
    /** 账号分配的执行设备 ID；NULL 表示尚未分配 */
    assignedDeviceId: text("assigned_device_id"),
    /** Main 管理的浏览器目录身份；不等于主机路径 */
    profileId: text("profile_id"),
    /** 登录状态已失效标志；需要重新认证 */
    loginReset: integer("login_reset").notNull().default(0),
    /** 账号业务域名 JSON 数组，格式 1；normalizeAccount 校验，账号匹配范围权威 */
    businessDomains: text("business_domains").notNull().default("[]"),
    /** 已确认登录落点的精确 origin JSON 数组，仅用于状态同步，不授权密码投递或任务账号匹配 */
    stateOrigins: text("state_origins").notNull().default("[]"),
    /** 固定凭据版本；修改不覆盖已领取运行 */
    credentialVersion: integer("credential_version").notNull().default(1),
    /** 浏览器状态撤销代次 */
    stateEpoch: integer("state_epoch").notNull().default(1),
    /** 凭据认证状态 unverified/valid/invalid */
    credentialStatus: text("credential_status").notNull().default("unverified"),
    /** 账号已发布浏览器状态递增修订号 */
    stateRevision: integer("state_revision").notNull().default(0),
    /** 当前已发布浏览器状态对象键 */
    stateObjectKey: text("state_object_key"),
    /** 上一已发布浏览器状态对象键；NULL 表示无回退副本 */
    previousStateObjectKey: text("previous_state_object_key"),
    /** 浏览器状态同步状态 none/pending/synced/failed */
    syncStatus: text("sync_status").notNull().default("none"),
    /** 固定公开同步错误分类；不存上游正文 */
    syncError: text("sync_error"),
    /** 最近发布账号浏览器状态的设备 ID；NULL 表示尚未发布 */
    lastDeviceId: text("last_device_id"),
    /** 持有当前账号状态发布权的运行 ID；NULL 表示没有发布占用 */
    stateOwnerRunId: text("state_owner_run_id"),
  },
  (t): SQLiteTableExtraConfigValue[] => [
    check("accounts_enabled_check", sql.raw("enabled IN (0,1)")),

    /** 与 SQL 基线同源的校验约束；不得在 ORM 迁移中放宽。 */
    check("accounts_check_0", sql.raw("created_at IS NULL OR typeof(created_at)='integer'")),

    uniqueIndex("accounts_unique_1").on(t.userId, t.id),
    foreignKey({ columns: [t.userId], foreignColumns: [members.id] }),
    foreignKey({
      columns: [t.id, t.credentialVersion],
      foreignColumns: [accountCredentialVersions.accountId, accountCredentialVersions.version],
    }),
    foreignKey({ columns: [t.assignedDeviceId], foreignColumns: [devices.id] }),
  ],
);

/** 同一次浏览器调用的防重账本；按运行和动作编号去重，unknown 不自动重放，删除正文不删除调用身份。 */
export const actions = sqliteTable(
  "actions",
  {
    /** 所属原运行 ID；必须关联执行 */
    runId: text("run_id").notNull(),
    /** 本运行内稳定的工具调用 ID；同 ID 和摘要只能登记一次 */
    actionId: text("action_id").notNull(),
    /** 输入摘要；同一调用身份不能接受不同输入 */
    digest: text("digest").notNull(),
    /** 操作影响 read/write，校验见动作工具入口 */
    effect: text("effect").notNull(),
    /** 动作登记状态：intended 已登记但观察未确认，observed 已收到后续观察；不代表业务成功，未确认不得重放 */
    status: text("status").notNull(),
  },
  (t): SQLiteTableExtraConfigValue[] => [primaryKey({ columns: [t.runId, t.actionId] })],
);

/** 模型调用防重与状态；结果正文独立保存。删除或过期后保留摘要和调用身份以阻止重放。 */
export const aiCalls = sqliteTable(
  "ai_calls",
  {
    /** 稳定标识；保留存量身份 */
    id: text("id").primaryKey(),
    /** 所属业务成员 ID；由服务端授权，不接受网页扩权 */
    userId: text("user_id").notNull(),
    /** 所属云端图 ID */
    graphId: text("graph_id"),
    /** 输入摘要；同一调用身份不能接受不同输入 */
    digest: text("digest").notNull(),
    /** 模型防重状态 reserved 预留、running 已提交、done 已完成、failed 失败、unknown 结果未知；unknown 不重放 */
    status: text("status").notNull(),
    /** 固定公开错误分类；不含秘密或上游正文 */
    error: text("error"),
    /** 记录创建时点；UTC Unix 毫秒 */
    createdAt: integer("created_at").notNull(),
    /** 最近业务更新时点；UTC Unix 毫秒 */
    updatedAt: integer("updated_at").notNull(),
    /** 所属运行 ID；NULL 表示未关联执行 */
    runId: text("run_id"),
    /** 调用转交模型出站的时点；NULL 表示未记录；UTC Unix 毫秒 */
    egressStartedAt: integer("egress_started_at"),
    /** 实际选择的模型传输方式；旧调用为 NULL。 */
    streamMode: text("stream_mode"),
    /** 首个正文分片到达时点；不保存分片内容。 */
    firstDeltaAt: integer("first_delta_at"),
  },
  (t): SQLiteTableExtraConfigValue[] => [
    /** 与 SQL 基线同源的校验约束；不得在 ORM 迁移中放宽。 */
    check(
      "ai_calls_check_0",
      sql.raw("status IN ('reserved','running','done','failed','unknown')"),
    ),
    /** 与 SQL 基线同源的校验约束；不得在 ORM 迁移中放宽。 */
    check("ai_calls_check_1", sql.raw("created_at IS NULL OR typeof(created_at)='integer'")),
    /** 与 SQL 基线同源的校验约束；不得在 ORM 迁移中放宽。 */
    check("ai_calls_check_2", sql.raw("updated_at IS NULL OR typeof(updated_at)='integer'")),
    /** 与 SQL 基线同源的校验约束；不得在 ORM 迁移中放宽。 */
    check(
      "ai_calls_check_3",
      sql.raw("egress_started_at IS NULL OR typeof(egress_started_at)='integer'"),
    ),

    /** 按运行定位模型调用账本，停止与历史清理无需全表扫描。 */
    index("ai_calls_run").on(t.runId),
    /** 实际传输方式仅允许流式或完整响应；旧调用可为空。 */
    check("ai_calls_stream_mode", sql.raw("stream_mode IN ('stream','buffered','fallback')")),
    foreignKey({ columns: [t.userId], foreignColumns: [members.id] }),
  ],
);

/** LangGraph 检查点密文分块；按父检查点和字段排序，父记录删除时级联回收。 */
export const aiCheckpointChunks = sqliteTable(
  "ai_checkpoint_chunks",
  {
    /** 所属业务成员 ID；与图及上下游记录一致 */
    owner: text("owner").notNull(),
    /** LangGraph 图线程 ID，非聊天 ID */
    thread: text("thread").notNull(),
    /** LangGraph 检查点命名空间 */
    ns: text("ns").notNull(),
    /** 父检查点 ID；与 owner/thread/ns 共同定位，父删除时级联清理 */
    checkpoint: text("checkpoint").notNull(),
    /** 检查点分块字段 checkpoint/metadata */
    field: text("field").notNull(),
    /** 父 v=2 marker 的不可变分块身份；避免并发替换混入旧分块 */
    token: text("token").notNull(),
    /** 从零开始的分块序号；读取必须完整且连续 */
    part: integer("part").notNull(),
    /** 父字段整体密文的连续字符串片段；按 token/part 重组后以 ai-checkpoint:<owner> 解密 */
    value: text("value").notNull(),
  },
  (t): SQLiteTableExtraConfigValue[] => [
    /** 与 SQL 基线同源的校验约束；不得在 ORM 迁移中放宽。 */
    check("ai_checkpoint_chunks_check_0", sql.raw("field IN ('checkpoint','metadata')")),
    /** 与 SQL 基线同源的校验约束；不得在 ORM 迁移中放宽。 */
    check("ai_checkpoint_chunks_check_1", sql.raw("part>=0")),

    primaryKey({ columns: [t.owner, t.thread, t.ns, t.checkpoint, t.field, t.part] }),
    foreignKey({
      columns: [t.owner, t.thread, t.ns, t.checkpoint],
      foreignColumns: [
        aiCheckpoints.owner,
        aiCheckpoints.thread,
        aiCheckpoints.ns,
        aiCheckpoints.id,
      ],
    }).onDelete("cascade"),
  ],
);

/** 用户/图/命名空间隔离的 LangGraph 检查点索引；正文加密，写入受 generation 和运行租约栅栏约束。 原图失去授权后回收父记录与分块，不跨退休图恢复。 */
export const aiCheckpoints = sqliteTable(
  "ai_checkpoints",
  {
    /** 所属业务成员 ID；与图及上下游记录一致 */
    owner: text("owner").notNull(),
    /** LangGraph 图线程 ID，非聊天 ID */
    thread: text("thread").notNull(),
    /** LangGraph 检查点命名空间 */
    ns: text("ns").notNull(),
    /** 稳定标识；保留存量身份 */
    id: text("id").notNull(),
    /** 父检查点 ID；NULL 为图入口 */
    parent: text("parent"),
    /** LangGraph type+Base64 bytes 的整体密文或 v=2 分块标识；AAD 为 ai-checkpoint:<owner>，校验见 checkpointer */
    checkpoint: text("checkpoint").notNull(),
    /** 同属 LangGraph 元数据密文或 v=2 分块标识；AAD 为 ai-checkpoint:<owner> */
    metadata: text("metadata").notNull(),
    /** 事实记录时点；UTC Unix 毫秒 */
    at: integer("at").notNull(),
  },
  (t): SQLiteTableExtraConfigValue[] => [
    /** 与 SQL 基线同源的校验约束；不得在 ORM 迁移中放宽。 */
    check("ai_checkpoints_check_0", sql.raw("at IS NULL OR typeof(at)='integer'")),
    primaryKey({ columns: [t.owner, t.thread, t.ns, t.id] }),
  ],
);

/** 云端图持久投递事件；D1 拥有状态，DO alarm 消费。重试只推进可恢复状态，不重放未知副作用。 清理时退休事件并清除消息绑定，事件身份不改投新聊天。 */
export const aiDispatch = sqliteTable(
  "ai_dispatch",
  {
    /** 稳定标识；保留存量身份 */
    id: text("id").primaryKey(),
    /** 所属云端图 ID */
    graphId: text("graph_id").notNull(),
    /** 原聊天 ID；关闭后不得改挂新聊天 */
    threadId: text("thread_id").notNull(),
    /** 所属业务成员 ID；与图及上下游记录一致 */
    owner: text("owner").notNull(),
    /** 图事件用途：chat 聊天回合、help 首次协助、resume 回复恢复、refresh 上下文刷新 */
    kind: text("kind").notNull(),
    /** 原云端回合或稳定执行消息来源标识 */
    turnId: text("turn_id"),
    /** 所属运行 ID；NULL 表示未关联执行 */
    runId: text("run_id"),
    /** 原协助记录 ID；NULL 表示非协助事件 */
    helpId: text("help_id"),
    /** 恢复中断所绑定的用户消息 ID；NULL 表示不消费用户回复 */
    messageId: text("message_id"),
    /** LangGraph 等待中断 ID */
    interruptId: text("interrupt_id"),
    /** 协助图内的问题轮次 */
    questionRound: integer("question_round"),
    /** 投递状态：pending 待领取、running 租约内处理、done 完成、failed 失败、retired 授权撤回不再消费 */
    state: text("state").notNull().default("pending"),
    /** 图事件投递租约到期时点；NULL 表示尚未领取或已结束；UTC Unix 毫秒 */
    leaseUntil: integer("lease_until"),
    /** 固定公开错误分类；不含秘密或上游正文 */
    error: text("error"),
    /** 记录创建时点；UTC Unix 毫秒 */
    createdAt: integer("created_at").notNull(),
  },
  (t): SQLiteTableExtraConfigValue[] => [
    /** 与 SQL 基线同源的校验约束；不得在 ORM 迁移中放宽。 */
    check("ai_dispatch_check_0", sql.raw("kind IN ('chat','help','resume','refresh','chat')")),
    /** 与 SQL 基线同源的校验约束；不得在 ORM 迁移中放宽。 */
    check(
      "ai_dispatch_check_1",
      sql.raw("state IN ('pending','running','done','failed','retired')"),
    ),
    /** 与 SQL 基线同源的校验约束；不得在 ORM 迁移中放宽。 */
    check("ai_dispatch_check_2", sql.raw("lease_until IS NULL OR typeof(lease_until)='integer'")),
    /** 与 SQL 基线同源的校验约束；不得在 ORM 迁移中放宽。 */
    check("ai_dispatch_check_3", sql.raw("created_at IS NULL OR typeof(created_at)='integer'")),

    /** 图投递按状态及租约到期时点唤醒；graph_id 关联原图。 */
    index("graph_pending").on(t.state, t.leaseUntil, t.graphId),
    /** 按图查找待投递/执行中的事件，created_at、ID 保持原顺序。 */
    index("dispatch_graph").on(t.graphId, t.state, t.createdAt, t.id),
  ],
);

/** 图的归属、输入摘要、代次及租约绑定；聊天撤回或清理先关闭此写入授权。 */
export const aiGraphInputs = sqliteTable(
  "ai_graph_inputs",
  {
    /** 所属业务成员 ID；与图及上下游记录一致 */
    owner: text("owner").notNull(),
    /** 稳定标识；保留存量身份 */
    id: text("id").notNull(),
    /** 输入摘要；同一调用身份不能接受不同输入 */
    digest: text("digest").notNull(),
    /** 图写入授权标志；清理前先置零 */
    active: integer("active").notNull().default(1),
    /** 原聊天 ID；用于撤回和保留期定位 */
    parentThread: text("parent_thread"),
    /** 原回合 ID；NULL 为无回合绑定图 */
    parentTurn: text("parent_turn"),
    /** 记录创建时点；UTC Unix 毫秒 */
    createdAt: integer("created_at").notNull(),
    /** 图协议版本；旧版本不恢复 */
    graphVersion: text("graph_version").notNull().default("relay-graph-4"),
    /** 图用途：chat 聊天规划、help 执行协助；由 graphRuntime 校验 */
    kind: text("kind").notNull().default("chat"),
    /** 图状态：pending 待运行、running 运行中、waiting 等待中断回复、done 完成、failed 失败、unknown 未知、cancelled 取消；inactive 不允许恢复 */
    status: text("status").notNull().default("pending"),
    /** 图或子进程代次；用于拒绝旧请求 */
    generation: integer("generation").notNull().default(0),
    /** 所属运行 ID；NULL 表示未关联执行 */
    runId: text("run_id"),
    /** 运行租约代次；旧代次消息必须拒绝 */
    leaseEpoch: integer("lease_epoch"),
    /** 固定公开错误分类；不含秘密或上游正文 */
    error: text("error"),
  },
  (t): SQLiteTableExtraConfigValue[] => [
    /** 与 SQL 基线同源的校验约束；不得在 ORM 迁移中放宽。 */
    check("ai_graph_inputs_check_0", sql.raw("created_at IS NULL OR typeof(created_at)='integer'")),

    primaryKey({ columns: [t.owner, t.id] }),
    /** 按运行找到所属图，停止及清理时不扫描其他运行。 */
    index("graphs_run").on(t.runId, t.owner, t.id),
    /** 按原聊天找到所属图，撤回授权及分页删除图正文。 */
    index("graphs_thread").on(t.parentThread, t.owner, t.id),
  ],
);

/** 用户确认的长期偏好；值加密，显式删除时回收，不能扩大任务授权。 */
export const aiMemories = sqliteTable(
  "ai_memories",
  {
    /** 是否启用；旧记忆默认停用 */
    enabled: integer("enabled").notNull().default(0),
    /** 编辑冲突版本 */
    version: integer("version").notNull().default(1),
    /** 所属业务成员 ID；与图及上下游记录一致 */
    owner: text("owner").notNull(),
    /** 偏好命名空间 */
    namespace: text("namespace").notNull(),
    /** 当前命名空间内唯一键；语义见模块入口 */
    key: text("key").notNull(),
    /** 偏好 JSON 密文，格式 1；AAD 为 memory:<owner>:<namespace>:<key>，仅本人记忆接口读取 */
    value: text("value").notNull(),
    /** 记录创建时点；UTC Unix 毫秒 */
    createdAt: integer("created_at").notNull(),
    /** 最近业务更新时点；UTC Unix 毫秒 */
    updatedAt: integer("updated_at").notNull(),
  },
  (t): SQLiteTableExtraConfigValue[] => [
    // 按创建时点稳定翻页。
    index("memory_page").on(t.owner, t.namespace, desc(t.createdAt), desc(t.key)),

    check("ai_memories_enabled_check", sql.raw("enabled IN (0,1)")),

    /** 与 SQL 基线同源的校验约束；不得在 ORM 迁移中放宽。 */
    check("ai_memories_check_0", sql.raw("created_at IS NULL OR typeof(created_at)='integer'")),
    /** 与 SQL 基线同源的校验约束；不得在 ORM 迁移中放宽。 */
    check("ai_memories_check_1", sql.raw("updated_at IS NULL OR typeof(updated_at)='integer'")),

    primaryKey({ columns: [t.owner, t.namespace, t.key] }),
    foreignKey({ columns: [t.owner], foreignColumns: [members.id] }),
  ],
);

/** 统一聊天消息元数据；属于原聊天，seq 为聊天内稳定序号。正文独立保存，关闭聊天禁止新消息。 历史清理删除元数据并级联正文，原聊天身份保持关闭。 */
export const aiMessages = sqliteTable(
  "ai_messages",
  {
    /** 稳定标识；保留存量身份 */
    id: text("id").primaryKey(),
    /** 原聊天 ID；关闭后不得改挂新聊天 */
    threadId: text("thread_id").notNull(),
    /** 聊天内单调递增序号；与聊天 ID 联合唯一 */
    seq: integer("seq").notNull(),
    /** 消息角色：user 用户原文，assistant 助手回复 */
    role: text("role").notNull(),
    /** 原云端回合或稳定执行消息来源标识 */
    turnId: text("turn_id").notNull(),
    /** 事实记录时点；UTC Unix 毫秒 */
    at: integer("at").notNull(),
    /** 消息来源 user/cloud/executor */
    source: text("source").notNull().default("cloud"),
    /** 所属运行 ID；NULL 表示未关联执行 */
    runId: text("run_id"),
    /** 回复关联标识；可能为协助或卡片，不强制消息外键 */
    replyTo: text("reply_to"),
    /** 生成正式正文的模型调用；用于接替临时预览，旧消息为 NULL。 */
    sourceCallId: text("source_call_id"),
    /** 上下文撤回标志；本人历史可读，后续 AI 不得使用原文 */
    contextWithdrawn: integer("context_withdrawn").notNull().default(0),
  },
  (t): SQLiteTableExtraConfigValue[] => [
    /** 与 SQL 基线同源的校验约束；不得在 ORM 迁移中放宽。 */
    check("ai_messages_check_0", sql.raw("role IN ('user','assistant')")),
    /** 与 SQL 基线同源的校验约束；不得在 ORM 迁移中放宽。 */
    check("ai_messages_check_1", sql.raw("at IS NULL OR typeof(at)='integer'")),
    /** 与 SQL 基线同源的校验约束；不得在 ORM 迁移中放宽。 */
    check("ai_messages_check_2", sql.raw("context_withdrawn IN (0,1)")),

    uniqueIndex("ai_messages_unique_0").on(t.threadId, t.seq),
    /** 按调用关联正式消息与临时草稿。 */
    index("ai_messages_source_call")
      .on(t.threadId, t.sourceCallId)
      .where(sql.raw("source_call_id IS NOT NULL")),
    foreignKey({ columns: [t.threadId], foreignColumns: [aiThreads.id] }).onDelete("cascade"),
  ],
);

/** 用户聊天入口与云端回合控制；关闭/删除先撤回写入授权，再由清理作业回收正文。 */
export const aiThreads = sqliteTable(
  "ai_threads",
  {
    /** 稳定标识；保留存量身份 */
    id: text("id").primaryKey(),
    /** 所属业务成员 ID；由服务端授权，不接受网页扩权 */
    userId: text("user_id").notNull(),
    /** 所属任务 ID */
    taskId: text("task_id"),
    /** 聊天用途：compose 新任务交办、chat 已有任务聊天 */
    kind: text("kind").notNull(),
    /** 固定模型配置 ID */
    modelId: text("model_id").notNull(),
    /** 固定模型配置版本 */
    modelVersion: integer("model_version").notNull(),
    /** 本实体内的递增版本 */
    version: integer("version").notNull().default(0),
    /** 当前运行中的云端回合 ID；NULL 表示可推进 inbox */
    activeTurn: text("active_turn"),
    /** TaskInput 草稿 JSON，格式 1；taskInputSchema 校验，NULL 表示尚无有效草稿，提交版本前非任务定义权威 */
    draft: text("draft"),
    /** 云端意图草稿 JSON，格式 1；planning-graph 校验，仅为规划暂态，非已提交任务定义 */
    partial: text("partial").notNull().default("{}"),
    /** 聊天压缩摘要；不能扩大用户授权 */
    summary: text("summary").notNull().default(""),
    /** 已纳入摘要的最大消息序号 */
    summarySeq: integer("summary_seq").notNull().default(0),
    /** 聊天写入关闭标志；1 时禁止新发布 */
    closed: integer("closed").notNull().default(0),
    /** 用户界面删除标志；先关闭写入再回收正文 */
    deleted: integer("deleted").notNull().default(0),
    /** 记录创建时点；UTC Unix 毫秒 */
    createdAt: integer("created_at").notNull(),
    /** 最近业务更新时点；UTC Unix 毫秒 */
    updatedAt: integer("updated_at").notNull(),
  },
  (t): SQLiteTableExtraConfigValue[] => [
    /** 与 SQL 基线同源的校验约束；不得在 ORM 迁移中放宽。 */
    check("ai_threads_check_0", sql.raw("kind IN ('compose','chat')")),
    /** 与 SQL 基线同源的校验约束；不得在 ORM 迁移中放宽。 */
    check("ai_threads_check_1", sql.raw("created_at IS NULL OR typeof(created_at)='integer'")),
    /** 与 SQL 基线同源的校验约束；不得在 ORM 迁移中放宽。 */
    check("ai_threads_check_2", sql.raw("updated_at IS NULL OR typeof(updated_at)='integer'")),

    /** 用户未关闭聊天的 updated_at、ID 倒序键集分页；条件 closed=0。 */
    index("threads_visible").on(t.userId, desc(t.updatedAt), desc(t.id)).where(sql.raw("closed=0")),
    /** 指定用户、模型及任务查找未关闭聊天，按更新时间和 ID 倒序；条件 closed=0。 */
    index("threads_lookup")
      .on(t.userId, t.modelId, t.taskId, desc(t.updatedAt), desc(t.id))
      .where(sql.raw("closed=0")),
    /** 同一用户和任务最多一个未关闭 chat；compose 或 closed=1 不参与唯一约束。 */
    uniqueIndex("ai_task_chat").on(t.userId, t.taskId).where(sql.raw("kind='chat' AND closed=0")),
    uniqueIndex("ai_threads_unique_4").on(t.userId, t.id),
    foreignKey({
      columns: [t.modelId, t.modelVersion],
      foreignColumns: [modelProfileVersions.id, modelProfileVersions.version],
    }),
    foreignKey({ columns: [t.userId, t.taskId], foreignColumns: [tasks.userId, tasks.id] }),
    foreignKey({ columns: [t.userId], foreignColumns: [members.id] }),
  ],
);

/** 聊天内幂等回合；request_id 和版本绑定原交办，终态后不重新执行未知请求。 聊天删除时清除结果并取消回合，保留请求去重身份。 */
export const aiTurns = sqliteTable(
  "ai_turns",
  {
    /** 稳定标识；保留存量身份 */
    id: text("id").primaryKey(),
    /** 原聊天 ID；关闭后不得改挂新聊天 */
    threadId: text("thread_id").notNull(),
    /** 调用方生成的幂等请求 ID */
    requestId: text("request_id").notNull(),
    /** 输入摘要；同一调用身份不能接受不同输入 */
    digest: text("digest").notNull(),
    /** 本实体内的递增版本 */
    version: integer("version").notNull(),
    /** 回合状态：running 处理中、done 完成、failed 失败、unknown 结果未知、cancelled 已取消；终态同请求不重做 */
    status: text("status").notNull(),
    /** 本回合公开结果 JSON，格式 1；回合收尾/去重使用，清理时置空 */
    result: text("result"),
    /** 固定公开错误分类；不含秘密或上游正文 */
    error: text("error"),
    /** 记录创建时点；UTC Unix 毫秒 */
    createdAt: integer("created_at").notNull(),
    /** 最近业务更新时点；UTC Unix 毫秒 */
    updatedAt: integer("updated_at").notNull(),
    /** 所属运行 ID；NULL 表示未关联执行 */
    runId: text("run_id"),
  },
  (t): SQLiteTableExtraConfigValue[] => [
    /** 与 SQL 基线同源的校验约束；不得在 ORM 迁移中放宽。 */
    check(
      "ai_turns_check_0",
      sql.raw("status IN ('running','done','failed','unknown','cancelled')"),
    ),
    /** 与 SQL 基线同源的校验约束；不得在 ORM 迁移中放宽。 */
    check("ai_turns_check_1", sql.raw("created_at IS NULL OR typeof(created_at)='integer'")),
    /** 与 SQL 基线同源的校验约束；不得在 ORM 迁移中放宽。 */
    check("ai_turns_check_2", sql.raw("updated_at IS NULL OR typeof(updated_at)='integer'")),

    /** 读取聊天最新回合，按聊天内 version 倒序。 */
    index("turns_version").on(t.threadId, desc(t.version)),
    uniqueIndex("ai_turns_unique_1").on(t.threadId, t.requestId),
    foreignKey({ columns: [t.threadId], foreignColumns: [aiThreads.id] }).onDelete("cascade"),
  ],
);

/** LangGraph pending write 密文分块；依附写入身份，级联回收，重复写入不能覆盖旧分块。 */
export const aiWriteChunks = sqliteTable(
  "ai_write_chunks",
  {
    /** 所属业务成员 ID；与图及上下游记录一致 */
    owner: text("owner").notNull(),
    /** LangGraph 图线程 ID，非聊天 ID */
    thread: text("thread").notNull(),
    /** LangGraph 检查点命名空间 */
    ns: text("ns").notNull(),
    /** 父检查点 ID；与 owner/thread/ns/task/idx 定位写入身份 */
    checkpoint: text("checkpoint").notNull(),
    /** LangGraph 写入任务 ID */
    task: text("task").notNull(),
    /** pending write 序号；负值为框架保留通道 */
    idx: integer("idx").notNull(),
    /** 父写入 v=2 marker 的不可变分块身份 */
    token: text("token").notNull(),
    /** 从零开始的分块序号；读取必须完整且连续 */
    part: integer("part").notNull(),
    /** 父写入整体密文的连续字符串片段；按 token/part 重组后以 ai-checkpoint:<owner> 解密 */
    value: text("value").notNull(),
  },
  (t): SQLiteTableExtraConfigValue[] => [
    /** 与 SQL 基线同源的校验约束；不得在 ORM 迁移中放宽。 */
    check("ai_write_chunks_check_0", sql.raw("part>=0")),

    primaryKey({ columns: [t.owner, t.thread, t.ns, t.checkpoint, t.task, t.idx, t.part] }),
    foreignKey({
      columns: [t.owner, t.thread, t.ns, t.checkpoint, t.task, t.idx],
      foreignColumns: [
        aiWrites.owner,
        aiWrites.thread,
        aiWrites.ns,
        aiWrites.checkpoint,
        aiWrites.task,
        aiWrites.idx,
      ],
    }).onDelete("cascade"),
  ],
);

/** LangGraph 尚未合并的写入；按图/检查点/任务/序号防重，内容加密并受图写入栅栏约束。 原图失去授权后回收写入与分块，不能恢复未知副作用。 */
export const aiWrites = sqliteTable(
  "ai_writes",
  {
    /** 所属业务成员 ID；与图及上下游记录一致 */
    owner: text("owner").notNull(),
    /** LangGraph 图线程 ID，非聊天 ID */
    thread: text("thread").notNull(),
    /** LangGraph 检查点命名空间 */
    ns: text("ns").notNull(),
    /** 父检查点 ID；与 owner/thread/ns 共同定位原检查点 */
    checkpoint: text("checkpoint").notNull(),
    /** LangGraph 写入任务 ID */
    task: text("task").notNull(),
    /** LangGraph 任务路径，用于稳定排序 */
    path: text("path").notNull(),
    /** pending write 序号；负值为框架保留通道 */
    idx: integer("idx").notNull(),
    /** LangGraph 写入通道名称 */
    channel: text("channel").notNull(),
    /** LangGraph 序列化对象密文或 v=2 分块标识；AAD 为 ai-checkpoint:<owner>，只允许所属图解密 */
    value: text("value").notNull(),
  },
  (t): SQLiteTableExtraConfigValue[] => [
    primaryKey({ columns: [t.owner, t.thread, t.ns, t.checkpoint, t.task, t.idx] }),
  ],
);

/** 聊天截图及临时视觉输入的私有对象索引；D1 为发布权威，DO 保存分块密文。关闭聊天后分批删除对象。 */
export const artifacts = sqliteTable(
  "artifacts",
  {
    /** 稳定标识；保留存量身份 */
    id: text("id").primaryKey(),
    /** 所属原运行 ID；必须关联执行 */
    runId: text("run_id").notNull(),
    /** 私有 DO 对象键；D1 引用为唯一发布事实 */
    objectKey: text("object_key").notNull(),
    /** 已验证的内容 MIME 类型 */
    contentType: text("content_type").notNull(),
    /** 记录或对象到期时点；UTC Unix 毫秒 */
    expiresAt: integer("expires_at").notNull(),
    /** 原聊天 ID；关闭后不得改挂新聊天 */
    threadId: text("thread_id"),
    /** 1 为聊天长期图片，0 为短期视觉输入 */
    persistent: integer("persistent").notNull().default(0),
    /** 对象用途 chat/vision；授权与保留期按用途校验 */
    purpose: text("purpose").notNull().default("chat"),
    /** 运行租约代次；旧代次消息必须拒绝 */
    leaseEpoch: integer("lease_epoch"),
    /** 输入摘要；同一调用身份不能接受不同输入 */
    digest: text("digest"),
  },
  (t): SQLiteTableExtraConfigValue[] => [
    /** 与 SQL 基线同源的校验约束；不得在 ORM 迁移中放宽。 */
    check("artifacts_check_0", sql.raw("expires_at IS NULL OR typeof(expires_at)='integer'")),
    /** 与 SQL 基线同源的校验约束；不得在 ORM 迁移中放宽。 */
    check("artifacts_check_1", sql.raw("purpose IN ('chat','vision')")),

    /** 按长期标志及到期时点查找待回收附件。 */
    index("artifacts_expiry").on(t.persistent, t.expiresAt, t.id),
    /** 运行附件读取/删除，ID 稳定定位。 */
    index("artifacts_run").on(t.runId, t.id),
    /** 聊天附件分批读取/删除，ID 稳定定位。 */
    index("artifacts_thread").on(t.threadId, t.id),
    /** 按私有对象键仲裁图片引用与退休清理。 */
    index("artifacts_object_key").on(t.objectKey),
  ],
);

/** Better Auth 登录提供方账号；属于认证用户，密码为框架哈希。用户删除时级联，密码变更原子撤销会话。 */
export const authAccount = sqliteTable(
  "auth_account",
  {
    /** 稳定标识；保留存量身份 */
    id: text("id").primaryKey(),
    /** 提供方账号 ID */
    accountId: text("accountId").notNull(),
    /** Better Auth 登录提供方标识 */
    providerId: text("providerId").notNull(),
    /** 所属 Better Auth 用户 ID */
    userId: text("userId").notNull(),
    /** 提供方访问令牌；Better Auth 直接存储，未额外加密，仅服务端可读 */
    accessToken: text("accessToken"),
    /** 提供方刷新令牌；Better Auth 直接存储，未额外加密，仅服务端可读 */
    refreshToken: text("refreshToken"),
    /** 提供方身份令牌；Better Auth 直接存储，未额外加密，仅服务端可读 */
    idToken: text("idToken"),
    /** Better Auth 使用的 UTC Unix 毫秒时点；单位遵循已安装框架接口 */
    accessTokenExpiresAt: integer("accessTokenExpiresAt", { mode: "timestamp_ms" }),
    /** Better Auth 使用的 UTC Unix 毫秒时点；单位遵循已安装框架接口 */
    refreshTokenExpiresAt: integer("refreshTokenExpiresAt", { mode: "timestamp_ms" }),
    /** 提供方 OAuth 授权范围字符串；NULL 表示未记录 */
    scope: text("scope"),
    /** Better Auth 密码哈希；不存明文密码 */
    password: text("password"),
    /** Better Auth 使用的 UTC Unix 毫秒时点；单位遵循已安装框架接口 */
    createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull(),
    /** Better Auth 使用的 UTC Unix 毫秒时点；单位遵循已安装框架接口 */
    updatedAt: integer("updatedAt", { mode: "timestamp_ms" }).notNull(),
  },
  (t): SQLiteTableExtraConfigValue[] => [
    /** 按认证用户查找登录提供方账号及密码记录。 */
    index("auth_account_user").on(t.userId),
    foreignKey({ columns: [t.userId], foreignColumns: [authUser.id] }).onDelete("cascade"),
  ],
);

/** Better Auth 认证入口限流窗口；由框架维护，不保存业务凭据。 窗口到期由框架续用或清理，不随聊天删除。 */
export const authRateLimit = sqliteTable(
  "auth_rate_limit",
  {
    /** 稳定标识；保留存量身份 */
    id: text("id").primaryKey(),
    /** 当前命名空间内唯一键；语义见模块入口 */
    key: text("key").notNull(),
    /** 当前窗口计数 */
    count: integer("count").notNull(),
    /** Better Auth 使用的 UTC Unix 毫秒时点；单位遵循已安装框架接口 */
    lastRequest: integer("lastRequest").notNull(),
  },
  (t): SQLiteTableExtraConfigValue[] => [uniqueIndex("auth_rate_limit_unique_0").on(t.key)],
);

/** Better Auth 网站会话；仅服务端认证读取，过期或退出回收，用户删除时级联。 */
export const authSession = sqliteTable(
  "auth_session",
  {
    /** 稳定标识；保留存量身份 */
    id: text("id").primaryKey(),
    /** Better Auth 使用的 UTC Unix 毫秒时点；单位遵循已安装框架接口 */
    expiresAt: integer("expiresAt", { mode: "timestamp_ms" }).notNull(),
    /** Better Auth 随机会话令牌；由框架直接存储、未额外加密，仅服务端认证读取 */
    token: text("token").notNull(),
    /** Better Auth 使用的 UTC Unix 毫秒时点；单位遵循已安装框架接口 */
    createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull(),
    /** Better Auth 使用的 UTC Unix 毫秒时点；单位遵循已安装框架接口 */
    updatedAt: integer("updatedAt", { mode: "timestamp_ms" }).notNull(),
    /** 会话来源 IP；仅认证用途 */
    ipAddress: text("ipAddress"),
    /** 认证会话客户端描述 */
    userAgent: text("userAgent"),
    /** 所属 Better Auth 用户 ID */
    userId: text("userId").notNull(),
  },
  (t): SQLiteTableExtraConfigValue[] => [
    /** 按到期时间回收 Better Auth 会话。 */
    index("auth_expiry").on(t.expiresAt),
    /** 按认证用户查找及撤销其全部网站会话。 */
    index("auth_session_user").on(t.userId),
    uniqueIndex("auth_session_unique_2").on(t.token),
    foreignKey({ columns: [t.userId], foreignColumns: [authUser.id] }).onDelete("cascade"),
  ],
);

/** Better Auth 认证身份；邮箱验证后显式关联业务成员，不自动认领旧用户数据。 已有成员关联时拒绝直接删除；允许删除的认证身份按子表规则清理。 */
export const authUser = sqliteTable(
  "auth_user",
  {
    /** 稳定标识；保留存量身份 */
    id: text("id").primaryKey(),
    /** 界面显示名称 */
    name: text("name").notNull(),
    /** 邮箱地址；用于验证身份，不作为资源归属主键 */
    email: text("email").notNull(),
    /** Better Auth 邮箱是否已验证：0/1 */
    emailVerified: integer("emailVerified", { mode: "boolean" }).notNull().default(false),
    /** 认证用户头像 URL；NULL 表示未设置 */
    image: text("image"),
    /** Better Auth 使用的 UTC Unix 毫秒时点；单位遵循已安装框架接口 */
    createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull(),
    /** Better Auth 使用的 UTC Unix 毫秒时点；单位遵循已安装框架接口 */
    updatedAt: integer("updatedAt", { mode: "timestamp_ms" }).notNull(),
  },
  (t): SQLiteTableExtraConfigValue[] => [uniqueIndex("auth_user_unique_0").on(t.email)],
);

/** Better Auth 邮箱验证及密码重置证明；由框架校验与过期回收，值不得进入日志。 */
export const authVerification = sqliteTable(
  "auth_verification",
  {
    /** 稳定标识；保留存量身份 */
    id: text("id").primaryKey(),
    /** 验证证明的邮箱或框架标识 */
    identifier: text("identifier").notNull(),
    /** Better Auth 验证证明；遵循框架存储格式、未额外加密，仅服务端校验读取 */
    value: text("value").notNull(),
    /** Better Auth 使用的 UTC Unix 毫秒时点；单位遵循已安装框架接口 */
    expiresAt: integer("expiresAt", { mode: "timestamp_ms" }).notNull(),
    /** Better Auth 使用的 UTC Unix 毫秒时点；单位遵循已安装框架接口 */
    createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull(),
    /** Better Auth 使用的 UTC Unix 毫秒时点；单位遵循已安装框架接口 */
    updatedAt: integer("updatedAt", { mode: "timestamp_ms" }).notNull(),
  },
  (t): SQLiteTableExtraConfigValue[] => [
    /** 按邮箱或验证标识定位认证证明。 */ index("auth_verification_identifier").on(t.identifier),
  ],
);

/** 运行上传的不可变浏览器状态候选；绑定用户、设备、租约及凭据版本，清理确认后才可发布。 */
export const browserStateCandidates = sqliteTable(
  "browser_state_candidates",
  {
    /** 私有 DO 对象键；D1 引用为唯一发布事实 */
    objectKey: text("object_key").primaryKey(),
    /** 所属业务成员 ID；由服务端授权，不接受网页扩权 */
    userId: text("user_id").notNull(),
    /** 所属站点账号 ID；NULL 表示临时环境或尚未选择账号 */
    accountId: text("account_id"),
    /** 所属原运行 ID；必须关联执行 */
    runId: text("run_id").notNull(),
    /** 所属执行设备 ID */
    deviceId: text("device_id").notNull(),
    /** 运行租约代次；旧代次消息必须拒绝 */
    leaseEpoch: integer("lease_epoch").notNull(),
    /** 固定凭据版本；修改不覆盖已领取运行 */
    credentialVersion: integer("credential_version").notNull(),
    /** 浏览器状态撤销代次 */
    stateEpoch: integer("state_epoch").notNull(),
    /** 上传时读取的账号状态修订号 */
    baseRevision: integer("base_revision").notNull(),
    /** 浏览器状态来源 origin JSON 数组，格式 1；browser-state 校验，属于不可变发布候选 */
    origins: text("origins").notNull(),
    /** 记录创建时点；UTC Unix 毫秒 */
    createdAt: integer("created_at").notNull(),
    /** 记录或对象到期时点；UTC Unix 毫秒 */
    expiresAt: integer("expires_at").notNull(),
    /** 对象候选已退休标志，1 时禁止发布 */
    retired: integer("retired").notNull().default(0),
    /** 发布时是否撤销旧状态引用：0/1 */
    clearPrevious: integer("clear_previous").notNull().default(0),
  },
  (t): SQLiteTableExtraConfigValue[] => [
    /** 与 SQL 基线同源的校验约束；不得在 ORM 迁移中放宽。 */
    check(
      "browser_state_candidates_check_0",
      sql.raw("created_at IS NULL OR typeof(created_at)='integer'"),
    ),
    /** 与 SQL 基线同源的校验约束；不得在 ORM 迁移中放宽。 */
    check(
      "browser_state_candidates_check_1",
      sql.raw("expires_at IS NULL OR typeof(expires_at)='integer'"),
    ),

    /** 按运行和创建时间查找浏览器状态发布候选。 */
    index("browser_state_run").on(t.runId, t.createdAt),
    uniqueIndex("browser_state_candidates_unique_1").on(t.userId, t.objectKey),
    foreignKey({ columns: [t.userId], foreignColumns: [members.id] }),
  ],
);

/** 浏览器状态对象退休墓碑；仅保留对象身份阻止迟到发布，不随正文清理删除。 */
export const browserStateRetirements = sqliteTable(
  "browser_state_retirements",
  {
    /** 私有 DO 对象键；D1 引用为唯一发布事实 */
    objectKey: text("object_key").primaryKey(),
    /** 对象退休仲裁时点；墓碑不随正文回收；UTC Unix 毫秒 */
    retiredAt: integer("retired_at").notNull(),
  },
  (_t): SQLiteTableExtraConfigValue[] => [
    /** 与 SQL 基线同源的校验约束；不得在 ORM 迁移中放宽。 */
    check(
      "browser_state_retirements_check_0",
      sql.raw("retired_at IS NULL OR typeof(retired_at)='integer'"),
    ),
  ],
);

/** 模型响应整体密文分块；id 为父调用 ID，token 绑定父 marker，part 从零连续；父正文删除时级联清理，不删除调用账本。 */
export const callResultChunks = sqliteTable(
  "call_result_chunks",
  {
    /** 父模型调用 ID；与父 call_results.id 关联，清理父正文时级联清理 */
    id: text("id").notNull(),
    /** 会话令牌或分块身份；仅服务端使用，不得记录 */
    token: text("token").notNull(),
    /** 从零开始的分块序号；读取必须完整且连续 */
    part: integer("part").notNull(),
    /** 父 ModelResponse 整体密文的连续字符串片段；仅由父 v=2 marker 的 token/part 完整组装后按 ai-call:<id> 解密 */
    value: text("value").notNull(),
  },
  (t): SQLiteTableExtraConfigValue[] => [
    /** 与 SQL 基线同源的校验约束；不得在 ORM 迁移中放宽。 */
    check("call_result_chunks_check_0", sql.raw("part>=0")),

    primaryKey({ columns: [t.id, t.part] }),
    foreignKey({ columns: [t.id], foreignColumns: [callResults.id] }).onDelete("cascade"),
  ],
);

/** 模型调用加密响应；绑定调用 ID，加密上下文 ai-call:<id>，正文可清除但调用账本保留。 */
export const callResults = sqliteTable(
  "call_results",
  {
    /** 稳定标识；保留存量身份 */
    id: text("id").primaryKey(),
    /** ModelResponse 整体密文或 v=2 分块 marker；校验见 call-cache，AAD 为 ai-call:<id>，仅原授权调用读取 */
    result: text("result").notNull(),
    /** 本表 JSON/正文格式版本；当前仅支持 1 */
    formatVersion: integer("format_version").notNull().default(1),
  },
  (t): SQLiteTableExtraConfigValue[] => [
    /** 与 SQL 基线同源的校验约束；不得在 ORM 迁移中放宽。 */
    check("call_results_check_0", sql.raw("format_version=1")),

    foreignKey({ columns: [t.id], foreignColumns: [aiCalls.id] }).onDelete("cascade"),
  ],
);

/** 设备领取请求的幂等回执；同设备 request_id 返回原运行，历史回执不触发重新执行。 不随运行正文删除回执，不提供自动重放或过期重建路径。 */
export const claims = sqliteTable(
  "claims",
  {
    /** 所属执行设备 ID */
    deviceId: text("device_id").notNull(),
    /** 调用方生成的幂等请求 ID */
    requestId: text("request_id").notNull(),
    /** 所属原运行 ID；必须关联执行 */
    runId: text("run_id").notNull(),
  },
  (t): SQLiteTableExtraConfigValue[] => [primaryKey({ columns: [t.deviceId, t.requestId] })],
);

/** 交办提交至调度的持久 outbox；与任务版本原子提交，只能投递到原聊天。 投递或撤回后进入 done，清空快照而保留原命令身份。 */
export const conversationCommands = sqliteTable(
  "conversation_commands",
  {
    /** 稳定标识；保留存量身份 */
    id: text("id").primaryKey(),
    /** 原聊天 ID；关闭后不得改挂新聊天 */
    threadId: text("thread_id").notNull(),
    /** 所属任务 ID */
    taskId: text("task_id"),
    /** 固化交办的 TaskDefinition JSON，格式 1；由 drainCommands 校验和投递，非当前任务定义权威 */
    runTask: text("run_task"),
    /** 交办命令状态：pending 事务内待提交、committed 已提交待投递、done 已投递或被撤回 */
    state: text("state").notNull().default("pending"),
    /** 记录创建时点；UTC Unix 毫秒 */
    createdAt: integer("created_at").notNull(),
  },
  (t): SQLiteTableExtraConfigValue[] => [
    /** 与 SQL 基线同源的校验约束；不得在 ORM 迁移中放宽。 */
    check(
      "conversation_commands_check_0",
      sql.raw("created_at IS NULL OR typeof(created_at)='integer'"),
    ),

    foreignKey({ columns: [t.threadId], foreignColumns: [aiThreads.id] }),
  ],
);

/** 聊天请求的有序 inbox；请求身份保留，正文在删除/过期时清除，重复交办不改投为补充。 */
export const conversationInbox = sqliteTable(
  "conversation_inbox",
  {
    /** inbox 全局入队顺序；线程内按其串行处理 */
    ordinal: integer("ordinal").primaryKey({ autoIncrement: true }),
    /** 稳定标识；保留存量身份 */
    id: text("id").notNull(),
    /** 原聊天 ID；关闭后不得改挂新聊天 */
    threadId: text("thread_id").notNull(),
    /** 调用方生成的幂等请求 ID */
    requestId: text("request_id").notNull(),
    /** 输入摘要；同一调用身份不能接受不同输入 */
    digest: text("digest").notNull(),
    /** 原交办字符串，明文输入；仅原聊天处理入口读取，清理时置空，执行中敏感补充写入 message_bodies */
    content: text("content").notNull(),
    /** 请求用途；当前新交办使用 chat */
    mode: text("mode").notNull().default("chat"),
    /** 所属运行 ID；NULL 表示未关联执行 */
    runId: text("run_id"),
    /** 入队状态：pending 待处理、processing 已绑定回合、done 已消费、failed 失败或授权已撤回 */
    status: text("status").notNull().default("pending"),
    /** 记录创建时点；UTC Unix 毫秒 */
    createdAt: integer("created_at").notNull(),
  },
  (t): SQLiteTableExtraConfigValue[] => [
    /** 与 SQL 基线同源的校验约束；不得在 ORM 迁移中放宽。 */
    check(
      "conversation_inbox_check_0",
      sql.raw("created_at IS NULL OR typeof(created_at)='integer'"),
    ),

    /** 按原聊天及入队状态消费 inbox，ordinal 升序维持原文顺序。 */
    index("conversation_pending").on(t.threadId, t.status, t.ordinal),
    uniqueIndex("conversation_inbox_unique_1").on(t.threadId, t.requestId),
    uniqueIndex("conversation_inbox_unique_2").on(t.id),
    foreignKey({ columns: [t.threadId], foreignColumns: [aiThreads.id] }),
  ],
);

/** 管理员授权的执行设备；令牌只存哈希，可吊销。执行并发和浏览器资源归云端与 Main 管理。 吊销保留设备身份和领取回执，已被运行引用时拒绝物理删除。 */
export const devices = sqliteTable(
  "devices",
  {
    /** 是否支持定时任务与执行总结扩展 */
    scheduleCapable: integer("schedule_capable").notNull().default(0),
    /** 稳定标识；保留存量身份 */
    id: text("id").primaryKey(),
    /** 界面显示名称 */
    name: text("name").notNull(),
    /** 设备 bearer token 的摘要；不可逆，不存明文令牌 */
    tokenHash: text("token_hash").notNull(),
    /** 最近设备认证心跳时点；NULL 表示从未在线；UTC Unix 毫秒 */
    lastSeen: integer("last_seen"),
    /** 设备令牌是否吊销：0/1 */
    revoked: integer("revoked").notNull().default(0),
    /** 设备已确认支持的执行协议版本；本版为 19，旧版须经维护窗口升级 */
    protocolVersion: integer("protocol_version").notNull(),
    /** 设备是否可领取：0/1 */
    claimReady: integer("claim_ready").notNull().default(1),
  },
  (t): SQLiteTableExtraConfigValue[] => [
    /** 与 SQL 基线同源的校验约束；不得在 ORM 迁移中放宽。 */
    check("devices_check_0", sql.raw("last_seen IS NULL OR typeof(last_seen)='integer'")),
    uniqueIndex("devices_unique_0").on(t.tokenHash),
  ],
);

/** 图片对象退休墓碑；先仲裁 D1 发布再删除 DO，阻止迟到上传复活已删图片。 正文回收后继续保留对象墓碑。 */
export const evidenceRetirements = sqliteTable(
  "evidence_retirements",
  {
    /** 私有 DO 对象键；D1 引用为唯一发布事实 */
    objectKey: text("object_key").primaryKey(),
    /** 对象退休仲裁时点；墓碑不随正文回收；UTC Unix 毫秒 */
    retiredAt: integer("retired_at").notNull(),
  },
  (_t): SQLiteTableExtraConfigValue[] => [
    /** 与 SQL 基线同源的校验约束；不得在 ORM 迁移中放宽。 */
    check(
      "evidence_retirements_check_0",
      sql.raw("retired_at IS NULL OR typeof(retired_at)='integer'"),
    ),
  ],
);

/** 运行中的云端协助与用户回复绑定；属于原聊天、图、轮次和租约，等待节点不先执行浏览器副作用。 聊天/运行清理时回收请求和回复，终态协助证据由 DO alarm 清理。 */
export const executionHelp = sqliteTable(
  "execution_help",
  {
    /** 稳定标识；保留存量身份 */
    id: text("id").primaryKey(),
    /** 所属原运行 ID；必须关联执行 */
    runId: text("run_id").notNull(),
    /** 原聊天 ID；关闭后不得改挂新聊天 */
    threadId: text("thread_id").notNull(),
    /** 绑定的运行租约代次 */
    epoch: integer("epoch").notNull(),
    /** ExecutionHelpRequest JSON，格式 1；校验见 executionHelpRequestSchema，敏感问题原文在 encryptedMessage 内按 help-request:<run_id>:<id> 加密 */
    request: text("request").notNull(),
    /** HelpResponse JSON 包装，格式 1；execution-help 校验，其中 encrypted 按 help:<run_id>:<id> 加密，NULL 表示尚未回答，仅原运行/本人聊天授权读取 */
    response: text("response"),
    /** 是否正在等待用户回复：0/1 */
    awaitingUser: integer("awaiting_user").notNull().default(0),
    /** 绑定本轮协助的用户消息 ID */
    replyMessageId: text("reply_message_id"),
    /** 记录创建时点；UTC Unix 毫秒 */
    createdAt: integer("created_at").notNull(),
    /** 所属云端图 ID */
    graphId: text("graph_id"),
    /** LangGraph 等待中断 ID */
    interruptId: text("interrupt_id"),
    /** 协助图内的问题轮次 */
    questionRound: integer("question_round").notNull().default(0),
  },
  (t): SQLiteTableExtraConfigValue[] => [
    /** 与 SQL 基线同源的校验约束；不得在 ORM 迁移中放宽。 */
    check("execution_help_check_0", sql.raw("created_at IS NULL OR typeof(created_at)='integer'")),

    /** 按聊天分页清理协助，ID 为稳定游标。 */
    index("help_thread").on(t.threadId, t.id),
    /** 未回复协助的聊天内时间倒序查询；只包含 awaiting_user=1 且无回复绑定。 */
    index("help_waiting")
      .on(t.threadId, desc(t.createdAt), desc(t.id))
      .where(sql.raw("awaiting_user=1 AND reply_message_id IS NULL")),
    /** 按运行及创建时间查找协助轮次。 */
    index("execution_help_run").on(t.runId, t.createdAt),
  ],
);

/** 用户请求的持久清理作业；request_id 防重，捕获固定范围后分批清理，失败可续作。 作业完成保留请求身份与完成状态，不复用为新清理范围。 */
export const historyCleanupJobs = sqliteTable(
  "history_cleanup_jobs",
  {
    /** 稳定标识；保留存量身份 */
    id: text("id").primaryKey(),
    /** 所属业务成员 ID；由服务端授权，不接受网页扩权 */
    userId: text("user_id").notNull(),
    /** 调用方生成的幂等请求 ID */
    requestId: text("request_id").notNull(),
    /** 清理范围 all/task/clear/thread */
    scope: text("scope").notNull(),
    /** 原清理目标任务或聊天 ID；NULL 仅用于 all 全量范围 */
    targetId: text("target_id"),
    /** 清理状态：capturing 事务内捕获目标、pending 分批清理中、done 已完成；错误保留并可续作 */
    status: text("status").notNull().default("capturing"),
    /** 记录创建时点；UTC Unix 毫秒 */
    createdAt: integer("created_at").notNull(),
    /** 最近业务更新时点；UTC Unix 毫秒 */
    updatedAt: integer("updated_at").notNull(),
    /** 固定公开错误分类；不含秘密或上游正文 */
    error: text("error"),
  },
  (t): SQLiteTableExtraConfigValue[] => [
    /** 与 SQL 基线同源的校验约束；不得在 ORM 迁移中放宽。 */
    check(
      "history_cleanup_jobs_check_0",
      sql.raw("created_at IS NULL OR typeof(created_at)='integer'"),
    ),
    /** 与 SQL 基线同源的校验约束；不得在 ORM 迁移中放宽。 */
    check(
      "history_cleanup_jobs_check_1",
      sql.raw("updated_at IS NULL OR typeof(updated_at)='integer'"),
    ),

    /** 按状态及更新时间查找待继续的清理作业。 */
    index("history_cleanup_pending").on(t.status, t.updatedAt),
    uniqueIndex("history_cleanup_jobs_unique_1").on(t.userId, t.requestId),
  ],
);

/** 清理作业固定目标及版本截止；不能将清理期间新建的数据纳入旧请求。 随作业保留完成标记和版本截止，不自动纳入新资源。 */
export const historyCleanupTargets = sqliteTable(
  "history_cleanup_targets",
  {
    /** 所属历史清理作业 ID；固定目标仅由该作业推进 */
    jobId: text("job_id").notNull(),
    /** 目标种类：task 任务截止版本、thread 原聊天、run 原运行；固定捕获后不扩大范围 */
    kind: text("kind").notNull(),
    /** 目标资源的稳定 ID；种类由原请求或清理目标 kind 确定 */
    resourceId: text("resource_id").notNull(),
    /** 清理捕获的任务版本上限；NULL 为非任务目标，不能扩大到后续新版本 */
    cutoffVersion: integer("cutoff_version"),
    /** 目标是否完成清理：0 待处理、1 已完成 */
    done: integer("done").notNull().default(0),
  },
  (t): SQLiteTableExtraConfigValue[] => [
    primaryKey({ columns: [t.jobId, t.kind, t.resourceId] }),
    /** 按作业查找未完成固定目标，按种类及资源 ID 分批清理。 */
    index("cleanup_targets").on(t.jobId, t.done, t.kind, t.resourceId),
    /** 按资源种类和 ID 判断是否已纳入固定清理目标。 */
    index("history_cleanup_resource").on(t.kind, t.resourceId),
    foreignKey({ columns: [t.jobId], foreignColumns: [historyCleanupJobs.id] }),
  ],
);

/** 业务写入请求摘要与资源身份；正文删除后继续保留，冲突摘要不能复用请求。 */
export const idempotency = sqliteTable(
  "idempotency",
  {
    /** 当前命名空间内唯一键；语义见模块入口 */
    key: text("key").primaryKey(),
    /** 输入摘要；同一调用身份不能接受不同输入 */
    digest: text("digest").notNull(),
    /** 目标资源的稳定 ID；种类由原请求或清理目标 kind 确定 */
    resourceId: text("resource_id").notNull(),
  },
  (_t): SQLiteTableExtraConfigValue[] => [],
);

/** 应用成员及管理员授权；与 auth_user 显式唯一关联。业务 ID 不因认证绑定而改变。 已有业务引用时拒绝直接删除；禁用账号不改变业务资源归属。 */
export const members = sqliteTable(
  "members",
  {
    /** 稳定标识；保留存量身份 */
    id: text("id").primaryKey(),
    /** 显式关联 Better Auth 用户；唯一，NULL 为尚未绑定成员 */
    authId: text("auth_id"),
    /** 邮箱地址；用于验证身份，不作为资源归属主键 */
    email: text("email").notNull().default(""),
    /** 成员角色：user 普通用户，admin 管理员 */
    role: text("role").notNull().default("user"),
    /** 成员是否停用：0/1 */
    disabled: integer("disabled").notNull().default(0),
    /** 成员最近成功领取时点；NULL 表示从未领取，公平调度优先考虑；UTC Unix 毫秒 */
    lastClaimAt: integer("last_claim_at"),
    /** 个人每日启动阈值；限制暂停时不拦截 */
    dailyRuns: integer("daily_runs").notNull().default(5),
    /** 个人已启用定时任务阈值 */
    scheduledTasks: integer("scheduled_tasks").notNull().default(3),
    /** 个人排队任务阈值 */
    queuedRuns: integer("queued_runs").notNull().default(5),
    /** 个人每日聊天阈值；限制暂停时不拦截 */
    dailyChat: integer("daily_chat").notNull().default(50),
    /** 个人每日模型阈值；限制暂停时不拦截 */
    dailyModels: integer("daily_models").notNull().default(200),
    /** 个人限制临时暂停的到期时点；NULL 表示未设置临时暂停；UTC Unix 毫秒 */
    dailyQuotaPausedUntil: integer("daily_quota_paused_until"),
    /** 个人额度限制是否暂停；默认 1 */
    dailyQuotaPaused: integer("daily_quota_paused").notNull().default(1),
  },
  (t): SQLiteTableExtraConfigValue[] => [
    /** 与 SQL 基线同源的校验约束；不得在 ORM 迁移中放宽。 */
    check("members_check_0", sql.raw("role IN ('user','admin')")),
    /** 与 SQL 基线同源的校验约束；不得在 ORM 迁移中放宽。 */
    check("members_check_1", sql.raw("last_claim_at IS NULL OR typeof(last_claim_at)='integer'")),
    /** 与 SQL 基线同源的校验约束；不得在 ORM 迁移中放宽。 */
    check(
      "members_check_2",
      sql.raw("daily_quota_paused_until IS NULL OR typeof(daily_quota_paused_until)='integer'"),
    ),
    /** 与 SQL 基线同源的校验约束；不得在 ORM 迁移中放宽。 */
    check("members_check_3", sql.raw("daily_quota_paused IN (0,1)")),

    uniqueIndex("members_unique_0").on(t.authId),
    foreignKey({ columns: [t.authId], foreignColumns: [authUser.id] }),
  ],
);

/** 聊天正文、异构 parts 与可选私密密文；同消息唯一，删除元数据时级联清理。 */
export const messageBodies = sqliteTable(
  "message_bodies",
  {
    /** 稳定标识；保留存量身份 */
    id: text("id").primaryKey(),
    /** 正文或公开占位；敏感原文仅存 private_content */
    content: text("content").notNull().default(""),
    /** 本人可解密的敏感正文，AAD 为 message:<thread_id>:<id> */
    privateContent: text("private_content"),
    /** ChatPart[] JSON，格式由 format_version 声明；contracts/execution 校验，消息正文权威，禁止秘密进入网页执行环境 */
    parts: text("parts").notNull().default("[]"),
    /** 本表 JSON/正文格式版本；当前仅支持 1 */
    formatVersion: integer("format_version").notNull().default(1),
  },
  (t): SQLiteTableExtraConfigValue[] => [
    /** 与 SQL 基线同源的校验约束；不得在 ORM 迁移中放宽。 */
    check("message_bodies_check_0", sql.raw("json_valid(parts)")),
    /** 与 SQL 基线同源的校验约束；不得在 ORM 迁移中放宽。 */
    check("message_bodies_check_1", sql.raw("format_version=1")),

    foreignKey({ columns: [t.id], foreignColumns: [aiMessages.id] }).onDelete("cascade"),
  ],
);

/** 不可变模型配置版本；密钥按模型 ID/版本加密，运行固定版本。能力探测可更新同版本的实际能力记录。 任务/聊天/运行仍引用时保留版本身份，不随当前头切换删除。 */
export const modelProfileVersions = sqliteTable(
  "model_profile_versions",
  {
    /** 稳定标识；保留存量身份 */
    id: text("id").notNull(),
    /** 本实体内的递增版本 */
    version: integer("version").notNull(),
    /** 模型配置 JSON，格式 1；modelInputSchema 校验，版本配置权威，不含明文 API Key */
    config: text("config").notNull(),
    /** 模型 API Key 密文；AAD 为 model:<id>:<version>，仅可信服务端配置/出站适配器读取，不向网页或设备返回密钥 */
    secret: text("secret").notNull(),
    /** 模型能力 JSON，格式 1；models 的能力探测/读取入口维护，实际探测结果权威，不暗换模型 */
    capabilities: text("capabilities").notNull(),
    /** 记录创建时点；UTC Unix 毫秒 */
    createdAt: integer("created_at").notNull(),
  },
  (t): SQLiteTableExtraConfigValue[] => [
    /** 与 SQL 基线同源的校验约束；不得在 ORM 迁移中放宽。 */
    check(
      "model_profile_versions_check_0",
      sql.raw("created_at IS NULL OR typeof(created_at)='integer'"),
    ),

    primaryKey({ columns: [t.id, t.version] }),
    foreignKey({ columns: [t.id], foreignColumns: [models.id] }),
  ],
);

/** 模型响应的真实用量和阶段时点；属于用户及可选运行/调用，未知 token 保持 NULL。 保留实际用量明细；聊天正文清理不删除计费事实，不把未知用量补成零。 */
export const modelUsage = sqliteTable(
  "model_usage",
  {
    /** 稳定标识；保留存量身份 */
    id: text("id").primaryKey(),
    /** 所属运行 ID；NULL 表示未关联执行 */
    runId: text("run_id"),
    /** 固定模型配置 ID */
    modelId: text("model_id").notNull(),
    /** 固定模型配置版本 */
    modelVersion: integer("model_version").notNull(),
    /** 提供方实际输入 token 数，NULL 表示未知 */
    inputTokens: integer("input_tokens"),
    /** 提供方实际输出 token 数，NULL 表示未知 */
    outputTokens: integer("output_tokens"),
    /** 事实记录时点；UTC Unix 毫秒 */
    at: integer("at").notNull(),
    /** 所属业务成员 ID；由服务端授权，不接受网页扩权 */
    userId: text("user_id").notNull(),
    /** 原模型调用账本 ID；NULL 表示无可绑定的调用身份 */
    callId: text("call_id"),
    /** 执行器推理开始时点；NULL 表示未提供；UTC Unix 毫秒 */
    inferenceStartedAt: integer("inference_started_at"),
    /** 提供方调用开始时点；NULL 表示未记录；UTC Unix 毫秒 */
    providerStartedAt: integer("provider_started_at"),
  },
  (t): SQLiteTableExtraConfigValue[] => [
    /** 与 SQL 基线同源的校验约束；不得在 ORM 迁移中放宽。 */
    check("model_usage_check_0", sql.raw("at IS NULL OR typeof(at)='integer'")),
    /** 与 SQL 基线同源的校验约束；不得在 ORM 迁移中放宽。 */
    check(
      "model_usage_check_1",
      sql.raw("inference_started_at IS NULL OR typeof(inference_started_at)='integer'"),
    ),
    /** 与 SQL 基线同源的校验约束；不得在 ORM 迁移中放宽。 */
    check(
      "model_usage_check_2",
      sql.raw("provider_started_at IS NULL OR typeof(provider_started_at)='integer'"),
    ),

    /** 用户时间范围用量查询，at、ID 提供稳定顺序。 */
    index("usage_user").on(t.userId, t.at, t.id),
    /** 按运行读取实际用量，at、ID 提供稳定顺序。 */
    index("usage_run").on(t.runId, t.at, t.id),
    /** 按运行和非空调用 ID 关联真实用量与模型耗时；无调用绑定记录不入索引。 */
    index("model_usage_call_timing").on(t.runId, t.callId).where(sql.raw("call_id IS NOT NULL")),
    foreignKey({ columns: [t.userId], foreignColumns: [members.id] }),
  ],
);

/** 模型配置主表；保存当前版本指针，版本正文和密钥只在 model_profile_versions。 版本仍被任务/聊天引用时拒绝物理删除，当前版本头与正文在同一事务写入。 */
export const models = sqliteTable(
  "models",
  {
    /** 是否启用；停用会失败关联排队与执行任务 */
    enabled: integer("enabled").notNull().default(1),
    /** 管理操作代次 */
    managementVersion: integer("management_version").notNull().default(1),
    /** 本次状态修改的事务身份 */
    managementToken: text("management_token"),
    /** 稳定标识；保留存量身份 */
    id: text("id").primaryKey(),
    /** 当前版本指针；版本正文独立存储 */
    currentVersion: integer("current_version").notNull(),
    /** 记录创建时点；UTC Unix 毫秒 */
    createdAt: integer("created_at").notNull(),
  },
  (t): SQLiteTableExtraConfigValue[] => [
    check("models_enabled_check", sql.raw("enabled IN (0,1)")),

    /** 与 SQL 基线同源的校验约束；不得在 ORM 迁移中放宽。 */
    check("models_check_0", sql.raw("created_at IS NULL OR typeof(created_at)='integer'")),

    foreignKey({
      columns: [t.id, t.currentVersion],
      foreignColumns: [modelProfileVersions.id, modelProfileVersions.version],
    }),
  ],
);

/** 短期设备配对流程；验证码及轮询摘要绑定设备，令牌密文仅配对交付，过期回收。 */
export const pairings = sqliteTable(
  "pairings",
  {
    /** 稳定标识；保留存量身份 */
    id: text("id").primaryKey(),
    /** 短期配对码 */
    code: text("code").notNull(),
    /** 设备配对轮询凭证摘要 */
    pollHash: text("poll_hash").notNull(),
    /** 设备令牌密文；AAD 为 pair:<id>，只向对应配对设备交付，过期删除 */
    tokenSecret: text("token_secret").notNull(),
    /** 所属执行设备 ID */
    deviceId: text("device_id").notNull(),
    /** 界面显示名称 */
    name: text("name").notNull(),
    /** 管理员是否已批准配对：0/1 */
    approved: integer("approved").notNull().default(0),
    /** 记录或对象到期时点；UTC Unix 毫秒 */
    expiresAt: integer("expires_at").notNull(),
    /** 记录创建时点；UTC Unix 毫秒 */
    createdAt: integer("created_at").notNull(),
  },
  (t): SQLiteTableExtraConfigValue[] => [
    /** 与 SQL 基线同源的校验约束；不得在 ORM 迁移中放宽。 */
    check("pairings_check_0", sql.raw("expires_at IS NULL OR typeof(expires_at)='integer'")),
    /** 与 SQL 基线同源的校验约束；不得在 ORM 迁移中放宽。 */
    check("pairings_check_1", sql.raw("created_at IS NULL OR typeof(created_at)='integer'")),
    uniqueIndex("pairings_unique_0").on(t.code),
  ],
);

/** 历史清理后保留的用户当日启动统计；上海日期维度，不是新的平台预算。 */
export const quotaCarry = sqliteTable(
  "quota_carry",
  {
    /** 所属业务成员 ID；由服务端授权，不接受网页扩权 */
    userId: text("user_id").notNull(),
    /** 上海时区 YYYY-MM-DD；用于当日统计 */
    day: text("day").notNull(),
    /** 该日已保留的启动次数 */
    runs: integer("runs").notNull(),
  },
  (t): SQLiteTableExtraConfigValue[] => [primaryKey({ columns: [t.userId, t.day] })],
);

/** 用户聊天/模型额度幂等预留；个人限制默认暂停，保留实际统计与重试防重。 */
export const quotaReservations = sqliteTable(
  "quota_reservations",
  {
    /** 稳定标识；保留存量身份 */
    id: text("id").primaryKey(),
    /** 所属业务成员 ID；由服务端授权，不接受网页扩权 */
    userId: text("user_id").notNull(),
    /** 上海时区 YYYY-MM-DD；用于当日统计 */
    day: text("day").notNull(),
    /** 预留种类：chat 聊天交办、model 模型请求；同请求身份防重 */
    kind: text("kind").notNull(),
    /** 记录创建时点；UTC Unix 毫秒 */
    createdAt: integer("created_at").notNull(),
  },
  (t): SQLiteTableExtraConfigValue[] => [
    /** 与 SQL 基线同源的校验约束；不得在 ORM 迁移中放宽。 */
    check("quota_reservations_check_0", sql.raw("kind IN ('chat','model')")),
    /** 与 SQL 基线同源的校验约束；不得在 ORM 迁移中放宽。 */
    check(
      "quota_reservations_check_1",
      sql.raw("created_at IS NULL OR typeof(created_at)='integer'"),
    ),

    /** 按用户、上海日期及预留种类统计个人额度。 */
    index("quota_owner").on(t.userId, t.day, t.kind),
    foreignKey({ columns: [t.userId], foreignColumns: [members.id] }),
  ],
);

/** 认证或请求入口的固定时间窗口限流；到期可重用窗口，不保存原始凭据。 */
export const requestLimits = sqliteTable(
  "request_limits",
  {
    /** 当前命名空间内唯一键；语义见模块入口 */
    key: text("key").primaryKey(),
    /** 当前窗口计数 */
    count: integer("count").notNull(),
    /** 记录或对象到期时点；UTC Unix 毫秒 */
    expiresAt: integer("expires_at").notNull(),
  },
  (_t): SQLiteTableExtraConfigValue[] => [
    /** 与 SQL 基线同源的校验约束；不得在 ORM 迁移中放宽。 */
    check("request_limits_check_0", sql.raw("expires_at IS NULL OR typeof(expires_at)='integer'")),
  ],
);

/** 已确认的执行条件与任务版本；保留既有调度能力，不作为新交办的前置要求。 历史清理回收条件正文及原运行关联记录。 */
export const runConditions = sqliteTable(
  "run_conditions",
  {
    /** 所属原运行 ID；必须关联执行 */
    runId: text("run_id").primaryKey(),
    /** 所属任务 ID */
    taskId: text("task_id").notNull(),
    /** 固定任务定义版本 */
    taskVersion: integer("task_version").notNull(),
    /** 本运行内用户指令递增版本；补充消息推进，拒绝旧指令结果 */
    instructionVersion: integer("instruction_version").notNull(),
    /** Conditions JSON，格式 1，校验见 conditionsSchema；旧已确认调度条件的来源，非私密回复字段 */
    content: text("content").notNull(),
    /** 记录创建时点；UTC Unix 毫秒 */
    createdAt: integer("created_at").notNull(),
    /** 本人确认条件的时点；NULL 表示未确认；UTC Unix 毫秒 */
    confirmedAt: integer("confirmed_at"),
    /** 本人确认后批准的任务版本；作用域为 task_id，NULL 表示尚未批准 */
    approvedVersion: integer("approved_version"),
    /** 本人确认的 Conditions JSON，格式 1；conditionsSchema 校验，NULL 表示尚未确认 */
    confirmedContent: text("confirmed_content"),
  },
  (t): SQLiteTableExtraConfigValue[] => [
    /** 与 SQL 基线同源的校验约束；不得在 ORM 迁移中放宽。 */
    check("run_conditions_check_0", sql.raw("created_at IS NULL OR typeof(created_at)='integer'")),
    /** 与 SQL 基线同源的校验约束；不得在 ORM 迁移中放宽。 */
    check(
      "run_conditions_check_1",
      sql.raw("confirmed_at IS NULL OR typeof(confirmed_at)='integer'"),
    ),

    /** 按任务查找既有条件记录，创建时间支持历史定位。 */
    index("conditions_task").on(t.taskId, t.createdAt),
    foreignKey({ columns: [t.taskId], foreignColumns: [tasks.id] }),
    foreignKey({ columns: [t.runId], foreignColumns: [runs.id] }),
  ],
);

/** 运行最终回复正文；按运行唯一，事务提交时绑定租约，迟到请求不能替换已提交结果。 历史删除时可独立回收正文，运行安全状态继续保留。 */
export const runResults = sqliteTable(
  "run_results",
  {
    /** 所属原运行 ID；必须关联执行 */
    runId: text("run_id").primaryKey(),
    /** RunResult JSON，格式 1；校验见 contracts 的 runResultSchema，终态回复正文，安全状态以 runs 为准 */
    result: text("result").notNull(),
    /** 本表 JSON/正文格式版本；当前仅支持 1 */
    formatVersion: integer("format_version").notNull().default(1),
  },
  (t): SQLiteTableExtraConfigValue[] => [
    /** 与 SQL 基线同源的校验约束；不得在 ORM 迁移中放宽。 */
    check("run_results_check_0", sql.raw("format_version=1")),

    foreignKey({ columns: [t.runId], foreignColumns: [runs.id] }).onDelete("cascade"),
  ],
);

/** 运行固化的执行快照；按运行唯一，不随任务后续修改变化。正文清理不删除运行安全身份。 */
export const runSnapshots = sqliteTable(
  "run_snapshots",
  {
    /** 所属原运行 ID；必须关联执行 */
    runId: text("run_id").primaryKey(),
    /** TaskDefinition JSON 执行快照，格式 1；校验见 contracts，版本固定，不是当前任务定义权威 */
    taskSnapshot: text("task_snapshot").notNull(),
    /** 本表 JSON/正文格式版本；当前仅支持 1 */
    formatVersion: integer("format_version").notNull().default(1),
  },
  (t): SQLiteTableExtraConfigValue[] => [
    /** 与 SQL 基线同源的校验约束；不得在 ORM 迁移中放宽。 */
    check("run_snapshots_check_0", sql.raw("format_version=1")),

    foreignKey({ columns: [t.runId], foreignColumns: [runs.id] }).onDelete("cascade"),
  ],
);

/** 执行状态与安全控制主表；属于任务及用户。快照和结果独立存储，终态与浏览器清理分别确认。 历史清理回收快照/结果，保留运行、租约和未知结果安全身份。 */
export const runs = sqliteTable(
  "runs",
  {
    /** 是否由新执行器登记执行总结 */
    learningEnabled: integer("learning_enabled").notNull().default(0),
    /** 是否要求定时任务扩展能力 */
    requiresScheduling: integer("requires_scheduling").notNull().default(0),
    /** 稳定标识；保留存量身份 */
    id: text("id").primaryKey(),
    /** 所属任务 ID */
    taskId: text("task_id").notNull(),
    /** 运行状态：queued 排队、running 执行、waiting_user 等待用户、verifying 收尾、succeeded 已回复、failed 失败、cancelled 取消、expired 过期、unknown 结果未知；浏览器清理由独立标志确认 */
    status: text("status").notNull(),
    /** 本次运行的计划时点；UTC Unix 毫秒 */
    scheduledFor: integer("scheduled_for").notNull(),
    /** 排队领取窗口的截止时点；UTC Unix 毫秒 */
    deadline: integer("deadline").notNull(),
    /** 所属执行设备 ID；NULL 表示尚未领取 */
    deviceId: text("device_id"),
    /** 运行租约代次；旧代次消息必须拒绝 */
    leaseEpoch: integer("lease_epoch").notNull().default(0),
    /** 运行执行租约到期时点；NULL 表示未领取或已收尾；UTC Unix 毫秒 */
    leaseExpiresAt: integer("lease_expires_at"),
    /** 停止标志；每次工具及提交前重新检查 */
    cancelRequested: integer("cancel_requested").notNull().default(0),
    /** 操作已登记但未获得后续观察；不得自动重放 */
    writePending: integer("write_pending").notNull().default(0),
    /** 账号 ID 或 task:<任务ID> 的独占资源键 */
    accountKey: text("account_key").notNull(),
    /** 同用户任务提交的稳定防重键；重试不产生第二次运行 */
    idempotencyKey: text("idempotency_key").notNull(),
    /** 记录创建时点；UTC Unix 毫秒 */
    createdAt: integer("created_at").notNull(),
    /** 最近业务更新时点；UTC Unix 毫秒 */
    updatedAt: integer("updated_at").notNull(),
    /** 被核查的原 unknown 运行；NULL 为普通执行 */
    reconciliationOf: text("reconciliation_of"),
    /** 可能发生写入且结果未确认；保留 unknown 防重 */
    mayHaveWritten: integer("may_have_written").notNull().default(0),
    /** 所属业务成员 ID；由服务端授权，不接受网页扩权 */
    userId: text("user_id").notNull(),
    /** Main 管理的浏览器目录身份；不等于主机路径 */
    profileId: text("profile_id"),
    /** 上海时区 YYYY-MM-DD；用于启动统计 */
    startedDay: text("started_day"),
    /** 本运行内用户指令递增版本；补充消息推进，拒绝旧指令结果 */
    instructionVersion: integer("instruction_version").notNull().default(0),
    /** 领取要求的执行协议版本 */
    executionProtocol: integer("execution_protocol").notNull().default(18),
    /** 原聊天 ID；关闭后不得改挂新聊天 */
    threadId: text("thread_id"),
    /** 上下文撤回标志；本人历史可读，后续 AI 不得使用原文 */
    contextWithdrawn: integer("context_withdrawn").notNull().default(0),
    /** 历史已删除标志；迟到终态仅可收尾，不能恢复正文 */
    historyDeleted: integer("history_deleted").notNull().default(0),
    /** 所属站点账号 ID；NULL 表示临时环境或尚未选择账号 */
    accountId: text("account_id"),
    /** 领取时固定的账号凭据版本；作用域为 account_id，不随账号后续修改变化 */
    accountCredentialVersion: integer("account_credential_version").notNull().default(1),
    /** 领取时固化的账号状态撤销代次；不得读取已撤销浏览器状态 */
    accountStateEpoch: integer("account_state_epoch").notNull().default(1),
    /** 浏览器清理待确认标志；终态后仍占用设备 */
    cleanupPending: integer("cleanup_pending").notNull().default(0),
    /** Main 已确认自有浏览器进程退出 */
    cleanupConfirmed: integer("cleanup_confirmed").notNull().default(0),
    /** 本运行提交的浏览器状态候选对象键 */
    stateCandidateKey: text("state_candidate_key"),
    /** 账号轮转执行组 ID；NULL 表示独立运行 */
    dispatchGroupId: text("dispatch_group_id"),
    /** 同一账号执行组内从零开始的成员位置 */
    dispatchIndex: integer("dispatch_index"),
    /** 固定任务定义版本 */
    taskVersion: integer("task_version"),
  },
  (t): SQLiteTableExtraConfigValue[] => [
    /** 与 SQL 基线同源的校验约束；不得在 ORM 迁移中放宽。 */
    check(
      "runs_status",
      sql.raw(
        "status IN ('queued','running','waiting_user','verifying','succeeded','failed','cancelled','expired','unknown')",
      ),
    ),
    check("runs_check_0", sql.raw("scheduled_for IS NULL OR typeof(scheduled_for)='integer'")),
    /** 与 SQL 基线同源的校验约束；不得在 ORM 迁移中放宽。 */
    check("runs_check_1", sql.raw("deadline IS NULL OR typeof(deadline)='integer'")),
    /** 与 SQL 基线同源的校验约束；不得在 ORM 迁移中放宽。 */
    check(
      "runs_check_2",
      sql.raw("lease_expires_at IS NULL OR typeof(lease_expires_at)='integer'"),
    ),
    /** 与 SQL 基线同源的校验约束；不得在 ORM 迁移中放宽。 */
    check("runs_check_3", sql.raw("created_at IS NULL OR typeof(created_at)='integer'")),
    /** 与 SQL 基线同源的校验约束；不得在 ORM 迁移中放宽。 */
    check("runs_check_4", sql.raw("updated_at IS NULL OR typeof(updated_at)='integer'")),
    /** 与 SQL 基线同源的校验约束；不得在 ORM 迁移中放宽。 */
    check("runs_check_5", sql.raw("context_withdrawn IN (0,1)")),
    /** 与 SQL 基线同源的校验约束；不得在 ORM 迁移中放宽。 */
    check("runs_check_6", sql.raw("history_deleted IN (0,1)")),
    /** 与 SQL 基线同源的校验约束；不得在 ORM 迁移中放宽。 */
    check("runs_check_7", sql.raw("task_version IS NOT NULL OR history_deleted=1")),

    /** 单设备执行/清理占用唯一性；账号 unknown 锁另行保留。 */
    uniqueIndex("run_device_active")
      .on(t.deviceId)
      .where(
        sql.raw(
          "device_id IS NOT NULL AND (status IN ('running','waiting_user','verifying') OR cleanup_pending=1)",
        ),
      ),
    /** 单用户执行/清理占用唯一性；终态但浏览器未关闭仍持有占用。 */
    uniqueIndex("run_user_active")
      .on(t.userId)
      .where(sql.raw("status IN ('running','waiting_user','verifying') OR cleanup_pending=1")),
    /** 用户未删除运行的 created_at、ID 倒序键集分页；条件 history_deleted=0。 */
    index("runs_history")
      .on(t.userId, desc(t.createdAt), desc(t.id))
      .where(sql.raw("history_deleted=0")),
    /** 任务活动运行查询，先定位任务再过滤运行状态。 */
    index("runs_task").on(t.taskId, t.status),
    /** 按用户、清理标志及状态查找未完成资源回收。 */
    index("run_user_cleanup").on(t.userId, t.cleanupPending, t.status),
    /** 按设备、清理标志及状态查找浏览器清理占用。 */
    index("run_device_cleanup").on(t.deviceId, t.cleanupPending, t.status),
    /** 非空执行组内每个成员序号最多创建一个运行；独立运行不参与。 */
    uniqueIndex("run_dispatch_member")
      .on(t.dispatchGroupId, t.dispatchIndex)
      .where(sql.raw("dispatch_group_id IS NOT NULL")),
    /** 按用户和上海日期统计实际启动次数。 */
    index("runs_start_day").on(t.userId, t.startedDay),
    /** 按用户和状态读取排队/活动运行，创建时间保持队列顺序。 */
    index("runs_owner_queue").on(t.userId, t.status, t.createdAt),
    /** 按原运行及状态查找既有核对运行，避免重复创建。 */
    index("run_reconciliation").on(t.reconciliationOf, t.status),
    /** 按 queued 状态和创建时间领取最早排队运行。 */
    index("run_queue").on(t.status, t.createdAt),
    uniqueIndex("runs_unique_11").on(t.userId, t.id),
    uniqueIndex("runs_unique_12").on(t.idempotencyKey),
    foreignKey({ columns: [t.deviceId], foreignColumns: [devices.id] }),
    foreignKey({
      columns: [t.userId, t.accountId],
      foreignColumns: [accounts.userId, accounts.id],
    }),
    foreignKey({
      columns: [t.userId, t.threadId],
      foreignColumns: [aiThreads.userId, aiThreads.id],
    }),
    foreignKey({
      columns: [t.userId, t.taskId, t.taskVersion],
      foreignColumns: [taskVersions.userId, taskVersions.taskId, taskVersions.version],
    }),
    foreignKey({ columns: [t.userId], foreignColumns: [members.id] }),
  ],
);

/** 云端管理员配置、发布屏障及更新目录；D1 为唯一权威，不保存模型明文密钥。 由管理员/发布入口按键更新，不随用户历史删除。 */
export const settings = sqliteTable(
  "settings",
  {
    /** 当前命名空间内唯一键；语义见模块入口 */
    key: text("key").primaryKey(),
    /** 配置或序列化内容；格式与加密约束见所属模块 */
    value: text("value").notNull(),
  },
  (_t): SQLiteTableExtraConfigValue[] => [],
);

/** 数据库结构版本标记；正常服务只支持本基线，不在请求路径迁移旧结构。 随库生命周期保留，服务请求不自动升级、删除或重建它。 */
export const storageMeta = sqliteTable(
  "storage_meta",
  {
    /** 本实体内的递增版本 */
    version: integer("version").primaryKey(),
    /** 转换源库 SHA-256；NULL 为全新安装，用于阻止错误源库覆盖或恢复中断的转换 */
    sourceDigest: text("source_digest"),
  },
  (_t): SQLiteTableExtraConfigValue[] => [
    /** 与 SQL 基线同源的校验约束；不得在 ORM 迁移中放宽。 */
    check("storage_meta_check_0", sql.raw("version=2")),
  ],
);

/** 维护窗口中的私有对象核验记录；绑定不可变对象键，全部引用核验后才允许激活，正常业务不写入。 仅维护窗口写入，随目标库保留核验身份，不删除对应私有对象。 */
export const storageObjectChecks = sqliteTable(
  "storage_object_checks",
  {
    /** 核验对象种类：evidence 私有图片、browser-state 私有浏览器状态 */
    kind: text("kind").notNull(),
    /** 私有 DO 对象键；D1 引用为唯一发布事实 */
    objectKey: text("object_key").notNull(),
    /** 离线转换对象校验完成时点；UTC Unix 毫秒 */
    verifiedAt: integer("verified_at").notNull(),
  },
  (t): SQLiteTableExtraConfigValue[] => [
    /** 与 SQL 基线同源的校验约束；不得在 ORM 迁移中放宽。 */
    check("storage_object_checks_check_0", sql.raw("kind IN ('evidence','browser-state')")),
    /** 与 SQL 基线同源的校验约束；不得在 ORM 迁移中放宽。 */
    check(
      "storage_object_checks_check_1",
      sql.raw("verified_at IS NULL OR typeof(verified_at)='integer'"),
    ),
    primaryKey({ columns: [t.kind, t.objectKey] }),
  ],
);

/** 任务不可变定义版本；是业务定义唯一权威，运行引用固定版本。清理只回收目标截止版本。 */
export const taskVersions = sqliteTable(
  "task_versions",
  {
    /** 所属任务 ID */
    taskId: text("task_id").notNull(),
    /** 本实体内的递增版本 */
    version: integer("version").notNull(),
    /** TaskDefinition JSON，格式版本由 format_version 声明；版本定义权威，校验见 contracts */
    definition: text("definition").notNull(),
    /** 所属业务成员 ID；由服务端授权，不接受网页扩权 */
    userId: text("user_id").notNull(),
    /** 固定模型配置 ID */
    modelId: text("model_id"),
    /** 固定模型配置版本 */
    modelVersion: integer("model_version"),
    /** 本表 JSON/正文格式版本；当前仅支持 1 */
    formatVersion: integer("format_version").notNull().default(1),
  },
  (t): SQLiteTableExtraConfigValue[] => [
    /** 与 SQL 基线同源的校验约束；不得在 ORM 迁移中放宽。 */
    check("task_versions_check_0", sql.raw("format_version=1")),
    /** 与 SQL 基线同源的校验约束；不得在 ORM 迁移中放宽。 */
    check("task_versions_check_1", sql.raw("(model_id IS NULL)=(model_version IS NULL)")),

    primaryKey({ columns: [t.taskId, t.version] }),
    uniqueIndex("task_versions_unique_0").on(t.userId, t.taskId, t.version),
    foreignKey({
      columns: [t.modelId, t.modelVersion],
      foreignColumns: [modelProfileVersions.id, modelProfileVersions.version],
    }),
    foreignKey({ columns: [t.userId, t.taskId], foreignColumns: [tasks.userId, tasks.id] }),
  ],
);

/** 用户任务当前版本及调度入口；定义仅在版本表。删除/撤回先停止调度并撤回后续写入授权。 */
export const tasks = sqliteTable(
  "tasks",
  {
    /** 需求变化代次，隔离旧执行经验 */
    requirementRevision: integer("requirement_revision").notNull().default(0),
    /** 稳定标识；保留存量身份 */
    id: text("id").primaryKey(),
    /** 本实体内的递增版本 */
    version: integer("version").notNull(),
    /** 任务状态：active 启用、paused 暂停、pending_validation 等待验证；删除另由 deleted 控制 */
    status: text("status").notNull(),
    /** 下一次已确认调度时点；NULL 表示不自动调度；UTC Unix 毫秒 */
    nextRunAt: integer("next_run_at"),
    /** 记录创建时点；UTC Unix 毫秒 */
    createdAt: integer("created_at").notNull(),
    /** 最近业务更新时点；UTC Unix 毫秒 */
    updatedAt: integer("updated_at").notNull(),
    /** 所属业务成员 ID；由服务端授权，不接受网页扩权 */
    userId: text("user_id").notNull(),
    /** 已确认条件的来源运行 ID；NULL 表示无已确认条件 */
    confirmedCondition: text("confirmed_condition"),
    /** 上下文撤回标志；本人历史可读，后续 AI 不得使用原文 */
    contextWithdrawn: integer("context_withdrawn").notNull().default(0),
    /** 用户界面删除标志；先关闭写入再回收正文 */
    deleted: integer("deleted").notNull().default(0),
    /** 任务展示标题；与当前版本同步维护 */
    title: text("title").notNull(),
    /** 调度种类：manual 手动、once 单次或 cron 周期；不从大正文中筛选 */
    scheduleKind: text("schedule_kind").notNull(),
  },
  (t): SQLiteTableExtraConfigValue[] => [
    /** 与 SQL 基线同源的校验约束；不得在 ORM 迁移中放宽。 */
    check("tasks_status", sql.raw("status IN ('pending_validation','active','paused')")),
    check("tasks_check_0", sql.raw("next_run_at IS NULL OR typeof(next_run_at)='integer'")),
    /** 与 SQL 基线同源的校验约束；不得在 ORM 迁移中放宽。 */
    check("tasks_check_1", sql.raw("created_at IS NULL OR typeof(created_at)='integer'")),
    /** 与 SQL 基线同源的校验约束；不得在 ORM 迁移中放宽。 */
    check("tasks_check_2", sql.raw("updated_at IS NULL OR typeof(updated_at)='integer'")),
    /** 与 SQL 基线同源的校验约束；不得在 ORM 迁移中放宽。 */
    check("tasks_check_3", sql.raw("context_withdrawn IN (0,1)")),
    /** 与 SQL 基线同源的校验约束；不得在 ORM 迁移中放宽。 */
    check("tasks_check_4", sql.raw("deleted IN (0,1)")),
    /** 与 SQL 基线同源的校验约束；不得在 ORM 迁移中放宽。 */
    check("tasks_check_5", sql.raw("schedule_kind IN ('manual','once','cron')")),

    /** 用户未删除任务的 created_at、ID 倒序键集分页；条件 deleted=0。 */
    index("tasks_visible").on(t.userId, desc(t.createdAt), desc(t.id)).where(sql.raw("deleted=0")),
    /** 按用户和任务状态筛选本人任务。 */
    index("tasks_owner").on(t.userId, t.status),
    /** 按任务状态及 next_run_at 升序查找到期调度任务。 */
    index("task_due").on(t.status, t.nextRunAt),
    uniqueIndex("tasks_unique_3").on(t.userId, t.id),
    foreignKey({
      columns: [t.userId, t.id, t.version],
      foreignColumns: [taskVersions.userId, taskVersions.taskId, taskVersions.version],
    }),
    foreignKey({ columns: [t.userId], foreignColumns: [members.id] }),
  ],
);

/** 本人交办时固定的偏好快照，正文加密，随原聊天清理。 */
export const preferenceSnapshots = sqliteTable(
  "preference_snapshots",
  {
    /** 原交办身份 */
    id: text("id").primaryKey(),
    /** 所属成员 */
    owner: text("owner").notNull(),
    /** 原聊天身份 */
    threadId: text("thread_id").notNull(),
    /** 偏好密文，AAD preferences:<owner>:<id> */
    value: text("value").notNull(),
    /** 创建时点，UTC 毫秒 */
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    foreignKey({ columns: [table.owner], foreignColumns: [members.id] }),
    foreignKey({ columns: [table.threadId], foreignColumns: [aiThreads.id] }),
    // 按原聊天清理快照。
    index("preference_snapshots_thread").on(table.threadId),
  ],
);

/** 每个任务的独立调度与执行器确认。 */
export const taskSchedules = sqliteTable(
  "task_schedules",
  {
    taskId: text("task_id")
      .primaryKey()
      .references(() => tasks.id),
    threadId: text("thread_id").references(() => aiThreads.id),
    version: integer("version").notNull().default(1),
    taskVersion: integer("task_version").notNull(),
    requirementRevision: integer("requirement_revision").notNull().default(0),
    confirmedSeq: integer("confirmed_seq").notNull().default(0),
    summary: text("summary"),
    ready: integer("ready").notNull().default(0),
    state: text("state").notNull().default("off"),
    frequency: text("frequency"),
    schedule: text("schedule"),
    nextRunAt: integer("next_run_at"),
    legacy: integer("legacy").notNull().default(0),
  },
  (t) => [
    index("task_schedules_due").on(t.state, t.nextRunAt),
    check("task_schedules_state", sql`${t.state} IN ('off','enabled','paused')`),
  ],
);
/** 调度配置写入的幂等身份与摘要。 */
export const scheduleRequests = sqliteTable(
  "schedule_requests",
  {
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id),
    requestId: text("request_id").notNull(),
    digest: text("digest").notNull(),
    version: integer("version").notNull(),
  },
  (t) => [primaryKey({ columns: [t.taskId, t.requestId] })],
);
/** 每次执行的加密总结与经验，不改变用户任务记忆。 */
export const executionLearning = sqliteTable(
  "execution_learning",
  {
    runId: text("run_id")
      .primaryKey()
      .references(() => runs.id),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id),
    taskVersion: integer("task_version").notNull(),
    accountId: text("account_id"),
    requirementRevision: integer("requirement_revision").notNull().default(0),
    state: text("state").notNull().default("pending"),
    summary: text("summary"),
    improvements: text("improvements"),
    incomplete: integer("incomplete").notNull().default(1),
    error: text("error"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("execution_learning_task").on(t.taskId, t.taskVersion, t.createdAt)],
);
/** 原执行器逐次上报的加密操作记录。 */
export const executionRecords = sqliteTable(
  "execution_records",
  {
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    callId: text("call_id").notNull(),
    content: text("content").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.callId] })],
);
