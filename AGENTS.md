# TaskRelay 开发与协作指南

适用于全仓。当前请求优先；架构候选不等于重构授权。实现以源码为准，版本和验收状态见对应文档。

## 工作流程

TaskRelay 为用户提供隔离的浏览器任务空间：网站交办与聊天，Cloudflare 规划和调度，管理员授权的 Windows 设备池执行。桌面仅为执行器，不提供任务编辑、聊天或模型管理；公开注册默认关闭。RewardPilot 仅参考进程架构，不复用 UI、积分业务或本地调度。

1. 阅读请求和目录约定，查看 `git status --short`，保留已有改动；不顺手提交技能、截图、密钥、缓存或产物。
2. 按任务查阅 [架构](docs/ARCHITECTURE.md)、[产品](PRODUCT.md)、[部署](docs/DEPLOYMENT.md)、[验收](docs/ACCEPTANCE.md)，由下方导航定位源码。
3. 存在 `graphify-out/graph.json` 时先 `graphify query "具体问题"`；关系用 `path`，概念用 `explain`，wiki 用于导航。核对源码；工具不可用则记录原因并继续检索。
4. 实现变更同步维护注释和文档，按范围测试、OCR 审查，再 `graphify update .`；报告失败与未解析范围。纯文档无需更新图。
5. Git 提交标题和正文使用中文，标识符、命令与专有名词可保留原文。

## 代码质量、注释与审查

### 模块功能注释

- 新增主要模块或调整职责时，在文件顶部或主要导出入口维护简短中文注释：职责、关键流程、上下游分工，必要的输入输出、副作用、状态所有权和安全边界。
- 复杂分支、并发/恢复、幂等、租约及跨进程交互解释原因和约束，不逐行翻译代码；简单函数/组件和生成文件不强制注释。
- 注释与实现、测试同步，不把设计意图写成已验证保证；删除失效注释、调试代码和注释掉的旧实现。纯注释改动确认没有行为变化。
- 按职责组织模块，复用平台 adapter；不为抽象拆出无独立职责的薄层。

### OCR 委托审查

代码变更交付/提交前默认使用 [open-code-review-delegate](.agents/skills/open-code-review-delegate/SKILL.md)，纯文档仅作文档检查；用户指定范围优先。

1. 读技能，执行 `ocr delegate preview --format json` 和 `ocr delegate rule --format json <paths...>`。**OCR 只筛文件、解析规则；宿主 AI 审查，不调用 OCR 外部模型。**
2. 默认审本次变更及上下文；全仓另建完整清单，补审被默认排除的测试/配置。依赖、生成文件、产物另列排除原因，不能把改动预览算作全仓覆盖。
3. Git 命令用 `git --no-pager`，diff 关闭 external diff、textconv 和颜色；分批完整阅读，按 `(path, status)` 标记 `reviewed` 或附具体原因的 `skipped`。
4. 重点检查正确性、权限/秘密、并发、幂等、停止/恢复、资源及生产入口测试。问题须有位置、触发条件和影响，必要时隔离复现，排除猜测和无价值风格意见。
5. 按严重程度报告 `path`、`content`、行号、`category`、`severity`，汇总 `total_files`、`reviewed_files`、`skipped_files`、`coverage_rate`；排除项另列，跳过不算已审。
6. 仅审查不改行为；要求修复时完成授权问题、回归及差异复审。区分已修、未解决和验证限制，审查不替代测试。

CLI 故障按技能处理并说明替代方式，未执行成功不称为 OCR 审查。临时快照、patch、复现和报告放仓库外或忽略目录，不提交密钥、用户数据或产物。

## 产品与架构边界

### 执行、授权与状态

- **云端大步骤、桌面执行**：云端 LangGraph 理解意图，明确交办生成可调整的大步骤并交接，含糊才询问；不逐步控制浏览器或另起报告。桌面 LangGraph 负责观察、具体规划、串行工具、纠错和最终回复。阶段建议不能覆盖用户原话和后续纠正。
- **一个聊天入口**：用户消息、云端协助、过程、截图和结果进入同一聊天。执行器先求助云端，云端查上下文和可用账号，仍缺信息才问用户；普通补充直接交给执行器，协助回复绑定当前询问。
- **原文与敏感输入**：用户原话、补充和回复整体交给执行器及 Stagehand，不拆账号/密码/验证码，不用 target/value 或原文片段交接。用户明确授权当前任务 AI 理解、读取和使用这些站点信息，并判断回复是输入、新要求还是问题；不设置发送模式或输入框前置门槛。平台模型密钥、设备令牌和其他用户数据不在授权内。
- **AI 判断业务**：普通与批量目标共用原生工具循环，普通文字直接作为最终答复；不输出自定义动作计划或业务完成枚举。不得恢复动作业务分类门槛、批量项目绑定、固定项目身份、成功硬匹配、强制核验表、独立报告阶段或五分钟/四十动作/人工等待五分钟上限。依据真实反馈如实报告，部分完成或受阻也可结束。
- **基础边界保留**：用户、账号和设备隔离，凭据站点与设备校验，公网检查，单机并发、租约、停止和同次调用幂等。网页不能扩大授权；不恢复网站授权名单，不开放任意脚本、Shell 或主机文件工具。
- **框架与恢复**：LangChain 统一模型、工具和原生消息，LangGraph 为唯一 AI 编排；鉴权、租约、加密、出站和防重 adapter 保留。工具串行，interrupt 等待节点无先行副作用；桌面协助仅在同一 generation 恢复，不跨进程恢复浏览器任务。
- **未知结果不重放**：记录操作是否送出、是否收到后续观察，不用 DOM/URL 指纹阻拦不同操作；观察不等于业务成功。停止时结果未返回不自动重放，历史 unknown 和检查点保留，不自动恢复旧任务。
- **进程与控制**：Main 管连接、SQLite、令牌和子进程；Preload 仅暴露校验后的命名入口；Renderer 不访问文件、明文令牌或执行进程。Stagehand 在 utilityProcess，Main 拒绝旧 generation。停止直接控制执行器；关窗口保留托盘，明确退出停止领取并关闭自有进程，自启动默认关闭。
- **调度权威**：配置和设备分配归云端，不加桌面本地调度器。条件卡确认频率、模型和账号的方向保留，当前不扩展、不作为执行前提；个人次数限制保持关闭。

### 模型与出站

- 所有生产模型请求走 `models.invoke → egress → ModelEgress` 的美国 jurisdiction 与 alarm，再调用提供方；各进程和普通请求均不得直连。结构化输出走 `models.generateStructured → invoke`，Zod 只校验适配。
- `submitAndWait` 在同次 RPC 内提交并等待；alarm 执行中不再次 RPC 轮询同一对象，取得终态才 ack，避免新请求替换 I/O 上下文。
- 不绕过 workerd 的 `MODEL_REGION_REQUIRES_DEPLOYMENT`，不改回访客请求链。测试可用隔离 adapter，真实模型及地区证据须来自部署环境。
- 模型名自由输入，保留 Chat Completions 与 Responses；缺能力即阻止使用，不暗换模型/提供方。运行固定任务快照中的模型配置版本。
- 自定义地址仅接受校验后的公网 HTTPS，不携带凭据跨域重定向；错误仅返回固定公开分类，不透传上游正文。用量来自实际响应，缺 token 或单价显示“未知”。

### 身份、数据与费用

- 网站用 Better Auth 会话和已验证邮箱，服务端检查用户归属与管理员角色；Cloudflare Access 仅可作外层限制。设备用可吊销 bearer token，不得访问用户/管理员接口。开发绕过仅限本机 `DEV_MODE=1`，生产关闭，开发服务不暴露公网。
- Main 用系统 `safeStorage` 保存设备令牌；模型密钥、账号凭据及敏感回复按上下文加密。本人聊天可解密已授权回复，清空和保留期同步清理密文。日志/诊断包不含明文秘密、Profile、SQLite 或 API Key。
- **不得重新生成或覆盖现有 `MASTER_KEY`**；密文依赖它，轮换须有迁移与恢复方案。
- 截图先脱敏再保存，秘密及敏感匹配结果不得传入网页执行环境。聊天图片长期保存，随聊天删除/保留期清理；先关闭聊天、阻止新写入，再清图片。终态可独立收尾，不能把旧消息挂到新聊天。
- 证据由私有 SQLite DO 分块加密保存，短期协助证据在完成/过期后清理；生产不绑定 R2。Cloudflare 保持 Free，普通 Worker 仅路由、业务进入 DO，长 AI 回合经持久化 outbox 与 alarm；不加项目每日预算或全站模型上限，不自动购买/切换付费服务。
- 数据库变更加迁移并兼容已安装客户端；SQLite 拒绝高于支持版本的 schema，不覆盖重建。SQL 迁移为结构权威，`schema.ts` 只覆盖部分 Drizzle 查询。

## 源码与技能导航

以下 `cloud` = `apps/cloud/src`，`desktop` = `apps/desktop/src`，`ui` = `packages/ui/src`；花括号为缩写。技能先读 `SKILL.md`，只执行相关部分，明确调用优先。

| 任务 | 优先入口 |
| --- | --- |
| 聊天、云端规划与协助 | `cloud/ai/`；`cloud/{chat-messages,execution-help}.ts` |
| 合同、调度、租约与停止 | `packages/contracts/src/`；`cloud/{store,runner,user}.ts`；`tests/{api,reliability}.test.ts` |
| 模型与出站 | `cloud/{models,egress,egress-state,model-egress}.ts`、`cloud/ai/model.ts`；`packages/model/src/` |
| 桌面生命周期与权限 | `desktop/main/`；`desktop/preload/index.ts`、`desktop/shared/ipc.ts` |
| 浏览器工具、图与截图 | `desktop/executor/{entry,runtime,execution-graph,session-checkpointer,stagehand-model,proxy,snapshots}.ts` |
| 共享 UI 与宿主 | `ui/{app,chat-parts,task-compose,conversation,model-selector,executor-app}.tsx`、`ui/use-thread.ts`；`apps/{web,desktop}/src/`；[UI 检查](docs/UI-REVIEW.md) |
| 认证、设备与云端绑定 | `cloud/{worker,index,auth,identity,pairing,env}.ts`；`apps/cloud/migrations/`；`apps/web/wrangler.jsonc` |
| Windows 打包 | `apps/desktop/{forge.config,vite.executor.config}.mts`；`scripts/{stage-runtime,prepare-browser,verify-browser,smoke,release-manifest}.mjs` |

| 场景 | 技能与边界 |
| --- | --- |
| 架构分析 | [improve-codebase-architecture](.agents/skills/improve-codebase-architecture/SKILL.md) ＋ [codebase-design](.agents/skills/codebase-design/SKILL.md)：先事实、deletion test、实际 adapter，再给候选；不提前设计 interface，不把平台知识扩散到调用方 |
| React 行为/性能 | [vercel-react-best-practices](.agents/skills/vercel-react-best-practices/SKILL.md) 的相关规则 |
| UI、表单、对话、可访问性 | [shadcn](.agents/skills/shadcn/SKILL.md) 与下方 UI 规则 |
| Hono 路由/中间件 | [hono](.agents/skills/hono/SKILL.md)；React 不因后端为 Hono 而启用 hono-jsx / hono-void |
| Workers、D1、DO、部署 | 从当前会话技能目录选 Cloudflare、workers-best-practices、durable-objects、wrangler，不硬编码其他机器/插件版本路径 |
| 动画、原语迁移 | 实际涉及才用 vercel-react-view-transitions / migrate-radix-to-base |

## Stagehand 规则

基于 [官方 TypeScript AI rules](https://docs.stagehand.dev/v4/first-steps/ai-rules)，以本项目授权、运行和出站约束为准。

1. 涉及 Stagehand 先通过 `stagehand-docs` 的 `search_stagehand` 查 v4 API，再用 `query_docs_filesystem_stagehand` 读返回路径，不猜路径。MCP 不可用则说明并读官方网页。查询仅含技术问题，不发送私有运行数据；配置见 [`.codex/config.toml`](.codex/config.toml)。
2. 跟随经过验证的最新正式版本，直接依赖和锁文件固定本轮解析版本；升级时核对 `dist/index.d.mts`、实现和生产入口测试，不用 `any` 掩盖差异。生产用 `localBrowser.connect({ cdpUrl })` 连接 Main 管理的 Chromium，再 `await Stagehand.create({ browser, model, ... })`；不使用旧 `new/init` 或 `agent()`。
3. 保留 Executor 原生动态 `import()`。正常、异常和停止均清理资源：先关闭 Stagehand，再由 Main/Host 按所有权回收浏览器。调用后仍检查停止/租约。
4. 页面来自 `browser.context`，多页显式传 `{ page }`；在 Stagehand 实例调用 act/observe/extract。act 是清晰的单步自然语言操作，不塞整个流程，不让高层 AI 生成 CSS/XPath。原生页面结构/控件编号不经过聊天摘要；定位失败交 AI 重新观察。
5. 消费 `{ data, metadata }`，检查 act 的 `data.success` 和错误，处理 observe 空候选；observe 不证明执行或完成。已知结构用就近 Zod Schema / `z.infer`，URL 按语义校验；保留当前 SDK 合法的无 Schema extract 路径，不强套模板。
6. 复用 `stagehand-model.ts` 的 ClientLLM 与云端 `/stagehand` 链路；不引入提供方直连、额外密钥或 Browserbase 托管浏览器。保持 `cache:false`、`selfHeal:false`、`logging:{level:"off"}`；不借候选/缓存绕过动作登记、停止、租约和凭据校验。官方 variables 示例不改变已确认的原文与敏感输入授权。

相关验证优先覆盖 `tests/{stagehand-relay,executor-runtime,chat-execution,structured-production}.test.ts`，资源生命周期和打包另按下表验证。

## UI 规则

网站和 Windows Renderer 遵循 [shadcn/ui AI Elements](https://ui.shadcn.com/docs/ai-elements)；“Codex 式”仅指侧栏、会话主区与底部输入布局，设置/导航用常规 shadcn。组合放 `packages/ui`，宿主负责布局与业务；保持 React＋Vite＋TypeScript、中性色、语义 tokens、variants 和浅色/深色/系统主题。

改 UI 前读技能与对应 pattern，核对 `packages/ui/components.json` 和已安装组件，通过 CLI 查文档及更新差异，选择一致的原语库。按现有 `Transport` 适配示例，不因 AI SDK/Next.js/演示 transport 改宿主架构。

- 聊天使用 `MessageScroller`、`Message`、`Bubble` 和稳定消息标识；跟随、上翻、回到最新由官方滚动组件负责。
- 输入用 `InputGroup`：Enter 发送、Shift+Enter 换行、中文组合态不发送；只追问缺失信息，详细表单为次级入口。
- Model Selector 展示真实配置/能力；Tool/Task/Plan 用 `Trace` 展示实际步骤、状态及可展开的脱敏输入输出/错误；确认在原聊天中提供具体操作与明确选择，并遵守后端绑定校验。
- 加载、协助、离线、失败、取消、完成由真实状态驱动；流式、附件、停止生成和额外模型选项仅在能力接通后启用。实现与检查写入 UI-REVIEW / ACCEPTANCE，不声称已全量对齐。

## 验证与交付

开发机 Node.js 24+、npm workspaces，用户无需 Node.js；命令以根 `package.json` 为准。初始化见 [README](README.md#开发)，桌面用 `npm run desktop`；`setup-local` 只在缺失时写密钥，`db:migrate` 只迁移本地 D1。

| 范围 | 必要验证 |
| --- | --- |
| 纯文档/注释 | 核对事实、链接、命令和差异；`git diff --check`。注释涉及 TS/TSX 时补类型检查，不为注释编写镜像测试 |
| 协议、状态、策略 | `npm run typecheck`；相关 `tests/{api,reliability}.test.ts` |
| 模型、结构化输出 | 类型检查；`tests/{model,structured-production}.test.ts`；地区/加密作业加 `tests/egress.test.ts` |
| Web / 共享 UI | 类型检查、`npm run test:ui`、`npm run build`；实际共享组件验证 Transport；按改动检查窄屏/手机、键盘/输入法、历史滚动及加载/错误/离线/等待状态 |
| Executor、原生依赖、Forge | 相关生产入口测试、打包后 smoke；恢复逻辑加实际 `execute` / `ExecutorHost` 故障流程 |
| 结构、依赖、交付脚本 | `npm run check:repo`，叠加实际影响范围的检查 |

多范围取并集，跨运行流程执行 `npm test`；定向测试用 `node --import tsx --test <测试文件...>`。测试命中生产 interface，不只测未接入 helper；通过后仅因新改动、失败或未解风险追加验证。

### Windows 交付与证据边界

步骤见 [README 构建](README.md#windows-构建) 与 [部署说明](docs/DEPLOYMENT.md#windows-更新交付)。

- 保留 Stagehand 原生导入、精选暂存生产依赖；浏览器/扩展在 ASAR 外并验证哈希，原生模块及伴随 DLL 正确解包。不无筛选打入整个 `node_modules`，升级后检查实际加载路径。
- 提升 `apps/desktop/package.json` 版本并同步锁文件，不用同版本新包覆盖更新。smoke 报告必须本次新生成；release-manifest 要求打包/安装 smoke 均新于产物。
- 系统安装交付必须从实际桌面/开始菜单入口启动，核对版本、进程路径及安装/构建 ASAR 哈希；启动 `out/` 不证明已安装。核对 `installedAsarPath`，Codex MSIX 重定向至 `LocalCache` 时，宿主内检查仅证明该副本，须核验 Windows 系统入口和外部进程。
- 分别报告源码测试、Web 构建、打包/实际安装、干净 Windows、真实模型/网站及连续观察。Web build 不含桌面包；独立 smoke 不调用 `runtime.execute()` / `ExecutorHost`，不证明完整调度、恢复和租约；JSDOM 不替代布局/真实 Electron，SQLite stand-in 不替代 D1 并发，Responses 能力探测不等于多模型浏览器闭环。未验证不得写成通过。

## 文档归属

| 内容 | 唯一维护位置 |
| --- | --- |
| 协作、注释与 OCR 规则 | 本文，不另建第二份 agent 指南 |
| 架构事实、流程、协议/状态、候选实施情况 | [ARCHITECTURE](docs/ARCHITECTURE.md) |
| 开发/构建、部署/安装 | [README](README.md)、[DEPLOYMENT](docs/DEPLOYMENT.md) |
| UI 检查、验收证据与限制 | [UI-REVIEW](docs/UI-REVIEW.md)、[ACCEPTANCE](docs/ACCEPTANCE.md) |
| 产品目标 | [PRODUCT](PRODUCT.md) |

阶段版本、通过记录和实施进度只在对应文档维护，不在本文重复。
