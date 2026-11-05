# TaskRelay 当前架构

本文描述当前源码。部署与安装见 [DEPLOYMENT](DEPLOYMENT.md)，验证证据与未完成项见 [ACCEPTANCE](ACCEPTANCE.md)。旧版本设计从 Git 历史追溯，不与当前流程并列。

## 职责与事实归属

| 层 | 职责 |
| --- | --- |
| 网站 / packages/ui | 用户隔离的任务聊天、模型选择、账号与设置、执行过程和图片；一个输入框承接交办、补充和协助 |
| Cloudflare | 应用鉴权、任务版本、运行快照、调度、租约、设备分配、云端意图检查与协助、模型出站 |
| Windows Main | 云端连接、safeStorage 设备令牌、SQLite journal/outbox、浏览器与执行子进程生命周期 |
| Preload / Renderer | 校验后的命名入口、连接与运行状态、暂停、停止、自启动和诊断；不提供聊天、任务编辑和模型管理 |
| Executor utilityProcess | 独立 Stagehand 4.3.0，完整观察、规划、操作、纠错与最终回复循环 |

普通 Worker 负责静态资源、health 与路由。请求按认证凭据哈希进入 RequestCoordinator 分片后仍执行完整 Hono 鉴权；分片哈希不是用户身份。Scheduler 执行定时工作，AiTurn 通过持久化 dispatch 与 alarm 处理长对话回合，NotificationHub 用休眠 WebSocket 通知变化，客户端仍从归属校验后的接口读取事实。

Cloudflare 保持 Free，不设置项目级每日平台预算或全站模型上限，不自动付费扩容。个人次数限制当前关闭；计费用量与平台、供应商限制仍有效。平台能力或额度变动须按部署时的官方说明核对，不把免费额度当容量承诺。

## 当前聊天与执行流程

协议为 14，桌面源码版本为 0.11.1；安装和部署状态见验收记录。

1. 用户在网站交办。云端 AI 检查意图；明确任务直接交接，缺少关键信息才询问，咨询直接回答。
2. conversation_inbox 以 requestId/digest 接收消息；线程内串行处理回合。commitDecision 只提交当前手动任务与 conversation_commands，随后幂等排队，不再处理旧的创建确认、调整范围或报告阶段分支。
3. 云端领取事务检查身份、设备并发、账号锁与租约；任务及模型配置版本固定在运行快照。Main 保存本地检查点后创建带 generation 的执行子进程，拒绝旧代次消息。
4. Executor 使用模型原生工具调用，执行 Stagehand 的 snapshot、act、observe、extract，以及导航、切换页面、等待和求助。高层 AI 给出自然语言操作，不生成选择器、自定义动作计划或业务完成枚举。
5. 执行器先向云端 AI 求助。云端读取已有上下文与可用账号，无法解决时才在原聊天询问用户。普通补充和当前协助回复共用消息入口。
6. 执行器用普通助手文字回复实际进度或结果；云端保存转发，不另起报告模型。reported 表示“已回复”，不代表业务全部完成，部分完成或受阻也可正常收尾。

当前新交办采用 manual；条件卡与频率确认保留为产品方向，不产生新条件草稿，也不构成执行前提。旧已确认条件的兼容路由和调度底层保留；没有 confirmedCondition 的任务不显示调度开关。用户偏好可保存，但当前执行上下文未消费这些偏好，修改偏好不会撤销运行或聊天回合。

## 原始上下文与 Stagehand

用户原话、补充及加密协助回复整体进入执行器与 Stagehand，不拆账号、密码或验证码，不提取 target/value 或原文片段。当前任务 AI 可读取用户提供的站点登录信息；平台模型密钥、设备令牌和其他用户数据不在此范围。

历史执行记录可按实际编码消息大小分块摘要并保存游标；原始用户输入不被摘要覆盖，Stagehand 原生页面树、控件编号和 Schema 不经过聊天摘要。每个摘要回合仍检查停止和租约。

Stagehand 使用 ClientLLM 转发至现有云端模型链路，cache/selfHeal 自动重放关闭。定位失败返回工具反馈，由 AI 重新观察纠正。没有任意脚本、Shell 或主机文件工具。网站无授权名单，但公网地址、DNS、凭据所属站点和设备校验保留，网页不能扩大用户授权。

每次 act 以清晰的单步自然语言操作为目标；observe 仅提供候选，空结果如实反馈。执行历史保留工具 data 和 metadata，act 的 success=false 交回 AI 纠正；导航异常不能显示为页面已打开。Stagehand 初始化返回后再次检查停止，正常与异常退出均关闭会话；Chromium 仍由 Main/Host 回收，不能把 SDK 4.3.0 的 browser.close() 当作只断开连接。

## 写入、停止与终态

动作调用编号用于同一次工具调用防重，不用 DOM/URL 指纹拦截不同操作。先记录本地检查点和云端动作意图，再发送操作；后续观察只表明已重新读取页面，不代表业务成功。发送后尚未取得观察的动作不能自动重放。

生产收尾唯一入口为 runner 的 /runs/:id/finish。事务核对设备、epoch、有效租约与当前状态；write_pending 优先落为 unknown，取消优先于普通回复。终态重试只接受原结果，不能覆盖已提交结果。确认终态后才附加原聊天的最终消息；原聊天关闭后仍可结束运行，但不把消息挂到新聊天。

未决操作保留账号锁。历史 unknown 和本地检查点不会自动恢复旧任务。清理历史属于明确授权的维护操作，不能把删历史当作正常恢复策略。

默认心跳 15 秒、租约 90 秒，全机并发 1；无五分钟执行、四十动作或五分钟人工等待的业务上限。停止直接控制执行器；Main 重连先回传 outbox，再领取任务。关窗口保留托盘，明确退出停止领取并关闭自有进程，自启动默认关闭。

## 协助、图片与删除

当前协助存于 execution_help；快照仅返回当前用户、未关闭聊天、活动运行中尚待回复的协助。旧 challenges 数据结构仅用于兼容迁移，不驱动当前界面。网站切换历史运行不改变停止按钮绑定的活动运行。

账号凭据和协助回复独立加密，本人聊天可显示，当前任务模型可以按授权使用。普通日志和诊断包不包含明文、Profile、SQLite 或 API Key。

聊天图片由私有 SQLite Evidence DO 分块加密保存，绑定原聊天，长期保留至聊天删除或保留期清理。先关闭聊天并阻止新写入，再删除图片；不能只删 D1 索引。历史清理同时处理正文和派生结果，正常保留期留下无正文 digest 墓碑防止旧请求重放。生产无 R2 绑定。

## 模型链路与平台 adapter

所有生产模型请求统一为 models.invoke → egress → ModelEgress 的 us jurisdiction 与 alarm → 提供方。结构化输出集中于 models.generateStructured，Zod adapter 负责校验适配；传输或结果未知不进入格式修复重试。

submitAndWait 一次 RPC 完成提交与等待，循环在对象内部。alarm 期间不能新建读取 RPC 替换入站 I/O 上下文，终态才 ack。作业与结果短期加密，未确认记录过期清理。上游调用前持久化 running；中断保持 MODEL_CALL_OUTCOME_UNKNOWN，不重放。workerd 的 MODEL_REGION_REQUIRES_DEPLOYMENT 不得绕过，地区和真实模型证据必须来自部署环境。

模型名自由输入，支持 Chat Completions 与 Responses。缺少必需能力时拒绝使用，不暗换模型或提供方。自定义服务仅允许校验后的公网 HTTPS，拒绝跨域重定向传递凭据；上游错误映射公开分类，不返回响应正文。用量来自实际响应，缺少 token 或价格显示“未知”。

LangGraph、RelayChatModel、D1Checkpointer、D1MemoryStore 保留；删除这些 adapter 会把模型出站、加密或持久化知识扩散到调用方。未使用的顶层 langchain 聚合依赖已移除，实际使用的 @langchain 包仍保留。本轮不重写 LangGraph。

## 数据与认证

D1 负责业务事实；完整结构以 apps/cloud/migrations 的增量 SQL 为准，schema.ts 只覆盖部分 Drizzle 查询。历史迁移不可按“旧代码”删除；兼容已安装数据库，SQLite 遇到高于支持版本的 schema 必须拒绝，不能覆盖重建。

网站使用 Better Auth 会话与已验证邮箱，服务端校验用户归属与管理员角色。设备 bearer token 可吊销，只访问设备/租约绑定入口。Cloudflare Access 是可选外层限制；DEV_MODE=1 只限本机，生产关闭。公开注册默认关闭。

Main 使用系统 safeStorage 保存设备令牌。MASTER_KEY 保护现有密文，禁止重新生成或覆盖；轮换必须有迁移与恢复方案。Profile 按账号/任务隔离，但不对可信设备管理员隐藏数据。

## 打包与验证边界

Stagehand 固定 4.3.0，Executor 保留原生动态 import；只暂存实际运行依赖，不打入整个 node_modules。Chromium 与扩展位于 ASAR 外，打包前校验资源哈希。extension adapter 在应用自有目录按内容哈希准备运行扩展，保留安装路径与文件完整性检查。

Web build 不包含桌面打包。smoke 只执行独立 Stagehand 自建站流程，不调用 runtime.execute 或 ExecutorHost；真实执行/恢复另有生产入口隔离测试。JSDOM 不证明布局滚动，SQLite stand-in 不证明真实 D1 并发，模型能力测试不证明真实网站闭环。交付还须核对实际系统入口、安装路径、版本与 ASAR，MSIX 重定向副本不能代替系统安装。
