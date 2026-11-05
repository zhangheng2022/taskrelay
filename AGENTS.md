# TaskRelay 开发与协作指南

本文适用于整个仓库，只记录已确认约束；架构候选不代表已授权的重构任务。

## 项目定位与开始工作

TaskRelay 为注册用户提供各自隔离的浏览器任务工作空间：网站描述和配置任务，Cloudflare 统一调度，管理员授权的 Windows 设备池执行，网站任务对话承接人工协助。桌面仅为执行器，不提供任务编辑、聊天或模型管理。公开注册默认关闭。仅参考 RewardPilot 的进程架构，不复用其 UI、积分业务或本地调度规则。

1. 阅读当前请求、本文及相关目录约定；查看 `git status --short`，保留已有改动，不顺手提交技能、截图、密钥或构建产物。
2. 按任务阅读 [架构](docs/ARCHITECTURE.md)、[产品](PRODUCT.md)、[部署](docs/DEPLOYMENT.md)、[验收](docs/ACCEPTANCE.md)，用下方导航定位源码。
3. 若 `graphify-out/graph.json` 存在，先用 `graphify query "具体问题"`；关系用 `graphify path`，概念用 `graphify explain`，wiki 用于广域导航。结论须核对源码；工具不可用时记录原因，改用源码检索继续。
4. 修改代码后执行 `graphify update .`；失败须报告，不得声称已更新。纯文档变更无需更新源码图。

Git 提交信息使用中文：标题和正文均用中文描述改动，代码标识符、命令和专有名词可保留原文。

## 核心约束

### 运行与授权

- **聊天主线（0.11.0 / 协议 14）**：用户交办由云端 AI 检查意图；明确直接交接，含糊才询问。执行器拥有观察、规划、操作、纠错和最终总结的完整循环；云端不逐步规划或另起报告。用户消息、云端协助、执行过程、截图和结果进入同一聊天，只有一个输入框。
- **按需求助**：执行器先向云端 AI 求助，云端查已有上下文和可用账号，无法解决再询问用户。普通补充直接给执行器，待协助的回复绑定当前询问。账号密码与验证码独立加密，本人聊天可查看；按用户强制要求，当前任务 AI 可以读取与使用这些信息，并自行判断回复是输入、新要求还是问题，不设置发送模式或输入框前置门槛。平台模型密钥、设备令牌及其他用户数据不在此授权范围。
- **AI 判断业务**：不设动作业务分类门槛、批量项目绑定、固定项目身份、成功判据硬匹配、强制核验表及独立报告阶段。普通目标与批量目标使用同一工具循环；AI 根据真实工具反馈结束并如实报告，部分完成或受阻也可以正常结束。取消五分钟、四十动作和人工等待五分钟上限。
- **保留的基础边界**：账号与设备身份隔离、凭据所属站点与设备校验、公共网络检查、单机并发、租约、停止控制与同一次工具调用的幂等标识保留。网页不能扩大用户授权，不提供任意脚本、Shell 或主机文件工具。不恢复网站授权名单。
- **原始上下文**：用户原话、补充及协助回复直接给执行器与 Stagehand，不拆账号/密码/验证码字段，不通过 target/value 或原文片段提取来交接。执行器使用原生工具调用，普通文字直接作为最终答复；不输出自定义动作计划或业务完成枚举。
- **Stagehand AI**：固定 4.3.0，执行使用原生快照及 act/observe/extract，通过 ClientLLM 转发到现有云端模型链路。高层 AI 表达自然语言操作，不生成选择器。页面结构和控件编号不经过聊天摘要；定位错误由 AI 重新观察纠正。SDK 自动重放仍关闭，避免已发送点击被隐藏重试。
- **未知动作**：只记录动作是否已送出和是否收到后续观察；不按 DOM/URL 指纹拦截不同操作。结果尚未返回时停止不自动重放。已有历史 unknown 及检查点保留，不自动恢复旧任务。
- **进程隔离**：Main 管理云端连接、SQLite、令牌和子进程；Preload 暴露校验后的命名入口；Renderer 不访问文件、明文设备令牌或执行进程。Stagehand 位于独立 utilityProcess，Main 拒绝旧 generation 消息。
- **截图与聊天**：脱敏截图作为消息图片长期保存，随聊天删除，不再十分钟失效。清理先关闭聊天和停止新写入，再清图片。执行终态可在聊天删除后独立收尾，不能重新把旧消息挂到新聊天。
- **调度与条件卡**：云端保持配置与设备分配权威，桌面不增加本地调度器。条件卡由用户确认频率、模型和账号的产品方向保留，但本轮暂不扩展，不成为执行前提。个人次数限制保持关闭。
- **窗口与退出**：关主窗口保留托盘，明确退出停止领取并关闭自有进程；自启动默认关闭。停止按钮直接控制执行器，不等待模型理解。

### 模型与出站

- **唯一生产链路**：所有生产模型请求经过 `models.invoke → egress → ModelEgress` 的美国 jurisdiction 与 alarm，再调用提供方；Renderer、Main、Executor 和普通请求处理均不得增加直连旁路。结构化输出统一使用 `models.generateStructured`，经 `invoke` 出站；Zod 仅负责校验适配。
- **单次 RPC 等待**：`submitAndWait` 合并提交和等待，循环留在对象内部。alarm 期间不能再次 RPC 轮询同一对象，避免新访客请求替换 I/O 上下文；取得终态结果后才 ack。
- **本地限制**：不得绕过 workerd 的 `MODEL_REGION_REQUIRES_DEPLOYMENT`，或改回访客请求链。测试可用隔离 adapter，真实模型联调与地区证据必须来自部署环境。
- **兼容与版本**：模型名自由输入，不限定 GPT；保留 Chat Completions 与 Responses。缺少必需能力时阻止使用，不暗换模型或提供方；运行使用任务快照中的模型配置版本。
- **地址与用量**：自定义地址只接受校验后的公网 HTTPS，不携带凭据跨域重定向；上游错误用固定公开分类，不透传响应正文。用量来自实际响应，未返回 token 或未配置单价时显示“未知”。

### 数据与认证

- 网站通过 Better Auth 会话与已验证邮箱校验身份，服务端实施用户归属与管理员角色隔离；Cloudflare Access 仅保留为可选外层限制，不能替代应用鉴权。设备使用可吊销 bearer token，不能访问用户或管理员接口；开发绕过仅限本机 `DEV_MODE=1`，生产关闭，不向公网暴露开发服务器。
- Main 用系统 `safeStorage` 保存设备令牌；模型密钥、账号凭据、敏感协助回复按上下文加密，普通日志和诊断包不得包含明文；当前任务模型可按上述强制要求读取用户的站点登录信息；用户已授权协助回复在本人聊天界面解密显示，清空聊天与保留期同时清理该密文。
- **不得重新生成或覆盖现有 `MASTER_KEY`**：D1 和出站作业的密文依赖它；轮换必须有迁移与恢复方案。
- 短期证据由私有 SQLite Durable Object 分块加密保存，协助完成或过期后清理；生产不绑定 R2，避免超出免费额度后计费。诊断包不得包含 Profile、SQLite 或 API Key。
- Cloudflare 保持 Free；普通 Worker 仅路由，业务计算进入 DO，长 AI 回合通过持久化 outbox 与 alarm 执行。不设置项目级每日平台预算或全站模型上限，不自动购买或切换付费服务；官方平台限制、保留期与验证范围见架构和部署文档。
- 数据库变更添加迁移并兼容已安装客户端数据；SQLite 拒绝高于支持版本的 schema，不得覆盖重建。数据库结构以 SQL 迁移为准，`schema.ts` 仅覆盖部分 Drizzle 查询。

## 任务导航与技能

表中花括号为路径缩写；图和文档用于定位，实现结论以源码为准。

| 任务 | 优先阅读 |
| --- | --- |
| 创建对话、确认卡、成功判据、授权、时间规则 | `packages/contracts/src/{index,execution,schedule}.ts`；`packages/ui/src/{task-compose,task-summary}.tsx`；`apps/cloud/src/user.ts` |
| 调度、领取、取消、租约、账号锁、只读核查 | `apps/cloud/src/{store,runner,user}.ts`；`tests/{reliability,api}.test.ts` |
| 模型配置、能力、协议、地区出站 | `apps/cloud/src/{models,egress,egress-state,model-egress}.ts`；`packages/model/src/index.ts`；`tests/{model,structured-production,egress}.test.ts` |
| 人工协助与敏感回复 | `apps/cloud/src/{user,runner}.ts`；`apps/desktop/src/executor/runtime.ts`；`packages/ui/src/conversation.tsx` |
| 桌面生命周期、恢复、停止、离线 | `apps/desktop/src/main/{index,executor-host,journal,cloud,browser}.ts` |
| Preload / Renderer 权限 | `apps/desktop/src/preload/index.ts`；`apps/desktop/src/shared/ipc.ts`；`apps/desktop/src/renderer/main.tsx`；Main 的 IPC 注册与参数校验 |
| 页面动作、站点限制、证据 | `apps/desktop/src/executor/{entry,runtime,proxy}.ts`；`packages/contracts/src/{execution,security}.ts` |
| 共享 UI | `packages/ui/src/{chat-parts,model-selector,task-compose,conversation}.tsx`；宿主 `apps/web/src/main.tsx`、`apps/desktop/src/renderer/main.tsx`；[检查记录](docs/UI-REVIEW.md) |
| Windows 打包与安装 | `apps/desktop/{forge.config,vite.executor.config}.mts`；`scripts/{stage-runtime,prepare-browser,verify-browser,smoke,release-manifest}.mjs` |
| Cloudflare 绑定、认证、迁移 | `apps/web/wrangler.jsonc`；`apps/cloud/src/{worker,index,auth,pairing,env}.ts`；`apps/cloud/migrations/` |

技能先读 `SKILL.md`，仅执行与任务相关的部分；明确调用优先，不因已安装而执行全部流程。

| 场景 | 技能与边界 |
| --- | --- |
| 架构分析、module 深化 | [improve-codebase-architecture](.agents/skills/improve-codebase-architecture/SKILL.md) ＋ [codebase-design](.agents/skills/codebase-design/SKILL.md)：按技能术语，先事实、deletion test、实际 adapter，再给候选，不提前设计 interface；删除后知识扩散到调用方的平台 adapter 应保留 |
| React 行为或性能 | [vercel-react-best-practices](.agents/skills/vercel-react-best-practices/SKILL.md) 的相关规则 |
| shadcn/UI、表单、对话、可访问性 | [shadcn](.agents/skills/shadcn/SKILL.md) 及下方 UI 基准 |
| Hono 路由、中间件 | [hono](.agents/skills/hono/SKILL.md)；React UI 不因后端为 Hono 而启用 hono-jsx / hono-void |
| Workers、D1、R2、DO、部署 | 会话中对应的 Cloudflare、workers-best-practices、durable-objects、wrangler 技能；从当前技能目录获取路径，不硬编码其他机器的插件版本 |
| 动画、UI 原语迁移 | 实际涉及时才用 vercel-react-view-transitions / migrate-radix-to-base，不作为架构分析的默认动作 |

## UI 专项要求

网站与 Windows Renderer 的 AI 交互统一遵循 [shadcn/ui AI Elements](https://ui.shadcn.com/docs/ai-elements)；“Codex 式”仅指侧栏、会话主区和底部输入区布局，组件及交互以对应 pattern 为准。设置、导航使用常规 shadcn/ui。

AI Elements 组合统一放在 `packages/ui` 供双端共用；保留 React＋Vite＋TypeScript、默认中性色、语义 tokens、组件 variants 和浅色/深色/系统主题，应用层负责布局与业务编排。

修改前读取 shadcn 技能和对应官方 pattern，核对 `packages/ui/components.json`、已安装组件，用 CLI 获取文档、检查更新差异，选与现有原语库一致的示例。AI SDK、Next.js、演示 transport 按需适配现有 `Transport`，不得改变宿主架构或核心约束。

| 场景 / pattern | 要求 |
| --- | --- |
| Chat / Message | `MessageScroller`、`Message`、`Bubble`；稳定消息标识，跟随、上翻和回到最新由官方滚动组件负责 |
| Prompt Input / Suggestion | `InputGroup`；Enter 发送、Shift+Enter 换行、中文输入法组合态不发送；自然语言只追问缺失信息，详细表单为次级入口，确认规则见核心约束 |
| Model Selector | 展示实际配置与能力；额外选项仅在后端支持时提供 |
| Tool / Task / Plan | `Trace` 组织真实步骤与状态，可展开输入、输出、错误，仅展示实际运行事实、脱敏摘要和证据 |
| Confirmation | 在当前任务对话展示具体操作与明确选择，遵守统一协助的绑定和后端校验要求 |

加载、等待协助、离线、失败、取消、完成由真实业务状态驱动；流式输出、附件、停止生成仅在能力接通后启用。UI 规则不代表已全量对齐，实际实现及检查写入 UI-REVIEW 和验收台账。

## 验证与交付

开发机 Node.js 24+、npm workspaces，最终用户无需 Node.js。命令以根 `package.json` 为准；初始化见 [README 开发](README.md#开发)，另开终端用 `npm run desktop` 启动桌面。`setup-local` 仅在缺失时写本地密钥，`db:migrate` 仅迁移本地 D1。

按变更范围选择下表验证，涉及多项取并集；跨多个运行流程执行 `npm test`。检查通过后仅因新改动、失败或未解风险扩大/重复验证。

| 变更范围 | 必要验证 |
| --- | --- |
| 纯文档 | 核对源码、命令、相对链接、Markdown；`git diff --check`，无需真实模型调用或打包 |
| 协议、状态、策略 | `npm run typecheck`；相关 `tests/{api,reliability}.test.ts` |
| 模型协议、结构化输出 | `npm run typecheck`；`tests/{model,structured-production}.test.ts`；地区/加密作业变更加 `tests/egress.test.ts` |
| Web / 共享 UI | `npm run typecheck`、`npm run test:ui`、`npm run build`；对照 pattern 检查手机、窄桌面、键盘/输入法、历史滚动，以及加载、失败、离线、等待确认/协助；组件测试挂载实际共享组件并验证 Transport 请求 |
| Executor、原生依赖、Forge | 打包后 smoke；恢复逻辑另验证真实 `execute` / `ExecutorHost` 故障流程 |
| 仓库结构、依赖或交付脚本 | `npm run check:repo`，并按实际影响补充上列验证 |

测试可用 `node --import tsx --test tests/model.test.ts tests/structured-production.test.ts tests/egress.test.ts` 按范围选择文件；须命中生产 interface，不能只测未接入的 helper。`npm run build` 是 Web 工作区构建，不包含桌面打包；JSDOM 不替代布局/滚动或真实 Electron 验证，Node SQLite D1 stand-in 不替代真实 D1 并发验证。

### Windows 更新交付

构建步骤和产物位置见 [README Windows 构建](README.md#windows-构建)，安装操作见 [部署说明](docs/DEPLOYMENT.md#windows-更新交付)。交付必须满足：

- 固定 Stagehand 4.3.0，保留 Executor 原生动态 `import()` 和暂存运行依赖；浏览器/扩展在 ASAR 外，打包前验证资源哈希。不得无筛选打入整个 `node_modules`；升级工具须检查安装后的加载路径，Vite 构建成功不足以证明可用。
- 提升 `apps/desktop/package.json` 版本并同步锁文件，不用同版本新包替代更新。`out/`、`.cache/`、打包资源、图产物不是源文件；`scripts/smoke.mjs` 要求本次新报告，`scripts/release-manifest.mjs` 要求打包/安装 smoke 均新于本次产物。
- 从实际桌面/开始菜单入口启动，核对安装版本、进程路径及安装/构建 `app.asar` 哈希；直接启动 `out/` 的 exe 不证明系统入口已更新。
- 核对清单 `installedAsarPath`：Codex MSIX 可能将 AppData 重定向至 `LocalCache`，宿主内验证仅证明该副本。发生重定向时须从 Windows 系统入口安装、实际桌面快捷方式启动，并核对外部进程路径和安装哈希。

smoke 仅证明安装产物中的独立 Stagehand、原生依赖和自建站操作，**不调用 `runtime.execute()` 或 `ExecutorHost`**，不能证明完整调度、恢复、租约流程。

交付报告分别说明源码测试、构建、打包/安装目录、干净 Windows、真实模型、真实网站、连续观察的验证范围；未执行不得写成通过，真实 Responses 能力通过不等于 GPT/非 GPT 浏览器闭环完成。

## 文档维护

| 内容变更 | 维护位置 |
| --- | --- |
| 协作约定 | 本文，不另建第二份 agent 指南 |
| 事实归属、执行顺序、协议、状态、打包规则及架构候选实施状态 | [ARCHITECTURE](docs/ARCHITECTURE.md) |
| 开发/构建步骤、部署/安装操作 | [README](README.md)、[DEPLOYMENT](docs/DEPLOYMENT.md) |
| UI 实现与检查、验收证据 | [UI-REVIEW](docs/UI-REVIEW.md)、[ACCEPTANCE](docs/ACCEPTANCE.md) |
| 产品目标 | [PRODUCT](PRODUCT.md) |

阶段性通过记录和候选实施进度只在对应文档维护，不在本文重复记录。
