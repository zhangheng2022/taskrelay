# TaskRelay 开发与协作指南

本文适用于整个仓库，记录已确认的产品约束和实际代码入口，不把架构候选方案当作已批准的重构任务。

## 项目目标与阅读顺序

TaskRelay 面向个人：网站描述并配置浏览器任务，Cloudflare 统一调度，Windows 客户端执行，任务对话承接人工协助。仅参考 RewardPilot 的进程架构，不复用其 UI、积分业务或本地调度规则。

1. 阅读用户当前请求、本文和相关目录的适用约定。
2. 查看 `git status --short`，保留用户已有改动。不要顺手提交技能、截图、密钥或构建产物。
3. 按需读取 [架构现状](docs/ARCHITECTURE.md)、[产品说明](PRODUCT.md)、[部署说明](docs/DEPLOYMENT.md)、[验收记录](docs/ACCEPTANCE.md)。
4. 若 `graphify-out/graph.json` 存在，先执行 `graphify query "具体问题"`；关系查询用 `graphify path`，概念查询用 `graphify explain`。有 wiki 时用于广域导航。图只负责定位，结论必须核对源码。
5. 修改代码后执行 `graphify update .`；仅修改文档不需要为了满足形式而重新生成源码图。

## 任务导航

| 要修改的行为 | 优先阅读 |
| --- | --- |
| 任务卡、成功判据、授权范围、时间规则 | `packages/contracts/src/{index,policy,schedule}.ts`，`packages/ui/src/task-editor.tsx`，`apps/cloud/src/user.ts` |
| 调度、领取、取消、租约、账号锁、只读核查 | `apps/cloud/src/{store,runner,user}.ts`，`tests/{reliability,api}.test.ts` |
| 模型配置、能力测试、协议与地区出站 | `apps/cloud/src/{models,egress,egress-state,model-egress}.ts`，`packages/model/src/index.ts`，`tests/{model,egress}.test.ts` |
| 验证码、扫码、确认、敏感回复 | `apps/cloud/src/{challenges,user,runner}.ts`，`apps/desktop/src/executor/runtime.ts`，`packages/ui/src/conversation.tsx` |
| 桌面生命周期、崩溃恢复、停止、离线 | `apps/desktop/src/main/{index,executor-host,journal,cloud,browser}.ts` |
| Preload 与 Renderer 权限 | `apps/desktop/src/{preload/index,shared/ipc,renderer/main}.ts` 或 `.tsx`，Main 中的 IPC 注册与参数校验 |
| 页面动作、站点限制、证据 | `apps/desktop/src/executor/{entry,runtime,proxy}.ts`，`packages/contracts/src/{policy,security}.ts` |
| 共享界面与样式 | `packages/ui/src/`，`apps/web/src/main.tsx`，`apps/desktop/src/renderer/main.tsx`，`docs/UI-REVIEW.md` |
| Windows 安装与原生运行依赖 | `apps/desktop/forge.config.mts`，`apps/desktop/vite.executor.config.mts`，`scripts/{stage-runtime,prepare-browser,verify-browser,smoke}.mjs` |
| Cloudflare 绑定、认证、迁移 | `apps/web/wrangler.jsonc`，`apps/cloud/src/{worker,index,auth,pairing,env}.ts`，`apps/cloud/migrations/` |

表中花括号是导航缩写，不是实际文件名。数据库结构以 SQL 迁移为准；`schema.ts` 只覆盖部分 Drizzle 查询，不能据此推断整个数据库结构。

## 按任务使用技能

先读取技能 `SKILL.md`，再遵循适用部分；不要只因仓库安装了某个技能就执行其全部流程。用户明确调用的技能优先纳入工作范围。

| 场景 | 技能与使用方式 |
| --- | --- |
| 架构分析、module 深化 | [improve-codebase-architecture](.agents/skills/improve-codebase-architecture/SKILL.md) 配合 [codebase-design](.agents/skills/codebase-design/SKILL.md)：先事实、deletion test、实际 adapter，再给候选；不提前设计新 interface |
| React 行为或性能变更 | [vercel-react-best-practices](.agents/skills/vercel-react-best-practices/SKILL.md)：选与当前问题相关的规则 |
| shadcn/ui 增改、表单、对话、可访问性 | [shadcn](.agents/skills/shadcn/SKILL.md)，同时遵循 TaskRelay 自己的 UI 设计 |
| Hono 路由和中间件实现 | [hono](.agents/skills/hono/SKILL.md)；当前 UI 是 React，不因 Hono 后端而启用 `hono-jsx` 或 `hono-void` |
| Workers、D1、R2、Durable Objects、部署 | 使用会话中可用的 Cloudflare、workers-best-practices、durable-objects、wrangler 等对应技能；从当前技能目录获取路径，不硬编码另一台机器的插件版本目录 |
| 动画或 UI 原语迁移 | 仅在任务实际涉及时使用 `vercel-react-view-transitions` 或 `migrate-radix-to-base`；不要把迁移当作架构分析的默认动作 |

架构讨论使用 `module`、`interface`、`implementation`、`depth`、`deep`、`shallow`、`seam`、`adapter`、`leverage`、`locality` 的技能定义。薄的文件也可能是必要的平台 adapter；删除后知识扩散到调用方，说明该 module 应保留。

## 必须保留的运行约束

- **云端权威**：任务配置、模型版本、调度、租约及运行状态由云端管理。离线仅查看缓存和停止本机执行，不新增本地调度器。
- **进程隔离**：Main 管理云端连接、SQLite、令牌和进程；Preload 仅暴露受校验的命名入口；Renderer 不访问文件、明文设备令牌或执行进程；Stagehand 留在独立 `utilityProcess`。
- **模型出站**：所有生产模型请求经过 `models.invoke → egress → ModelEgress` 的美国 jurisdiction 与 alarm，再调用提供方。不要在 Renderer、Main、Executor 或普通请求处理中增加直连模型的旁路。
- **本地限制**：本地 workerd 的 `MODEL_REGION_REQUIRES_DEPLOYMENT` 是明确限制，不得用本地直连或改回访客请求链来“修复”。测试可使用隔离 adapter；真实地区证据来自部署环境。
- **兼容模型**：模型名自由输入，不限定 GPT；保留 Chat Completions 与 Responses。缺少必需能力时阻止使用，不暗换模型或提供方。运行使用任务快照中的模型配置版本。
- **副作用先记事实**：本地检查点和云端动作意图先于执行；动作后重新观察。模型宣称成功不能替代程序核验。
- **未知结果不重放**：可能已写入但结果丢失时进入 `unknown`，保持账号锁，先只读核查。不得靠重复点击、重试提交或重新排队掩盖不确定性。
- **租约与代次**：设备上传必须绑定运行及 `leaseEpoch`；Main 拒绝旧 child/generation 消息。取消、停止、恢复不得让旧进程修改新状态；确认旧进程退出后才能开启新执行。
- **统一协助**：验证码、扫码、外部确认、高影响操作均通过任务对话。回复绑定运行、步骤、版本、租约和消费编号；原文截取保留前导零和大小写。填写或收到“已完成”后仍核查站点实际状态。不新增本地浏览器接管入口。
- **授权范围**：网页和模型内容不能扩大任务卡授权。保留目标事实校验、允许站点限制、公共网络检查；不增加任意 JavaScript、Shell 或主机文件工具。
- **默认限额**：全机并发 1，心跳 15 秒，租约 90 秒，自动执行 5 分钟/40 动作，人工等待 5 分钟，迟到窗口 1 小时且只补最近一次。常量位于 `packages/contracts/src/index.ts`；并发由领取及 Main/Host 守卫共同约束。
- **窗口与退出**：关主窗口保留托盘，明确退出时停止领取并关闭自有进程；自启动默认关闭。不要因 UI 重载重启任务。

## 数据、认证和安全

- 网站用 Cloudflare Access 校验 owner；设备使用可吊销 bearer token。开发绕过仅限本机 `DEV_MODE=1`，生产关闭。
- 设备令牌由 Main 用系统 `safeStorage` 保存。模型密钥、账号凭据、敏感协助回复按上下文加密；普通日志、聊天、诊断包不能包含这些明文。
- **不要重新生成或覆盖现有 `MASTER_KEY`**：D1 和出站作业已有密文依赖它。涉及轮换必须实现迁移与恢复方案。
- 自定义模型地址只接受校验后的公网 HTTPS；不能携带凭据跨域重定向。上游错误使用可公开的固定分类，不直接透传响应正文。
- 使用量来自实际提供方响应；未返回 token 或未配置单价时显示“未知”。
- R2 为私有证据存储；人工协助完成或过期时清理敏感回复与短期图片。不要把 Profile、SQLite 或 API Key 装入诊断包。
- 数据库变更添加迁移；保留已安装客户端数据兼容。SQLite 拒绝高于本程序支持版本的 schema，不能覆盖重建用户数据。

## 开发与验证

开发机 Node.js 24+，npm workspaces；最终用户无需 Node.js。以根 `package.json` 为命令来源。

```powershell
npm ci
node scripts/setup-local.mjs
npm run db:migrate
npm run dev
# 另一个终端启动桌面开发进程
npm run desktop
```

`setup-local` 只在缺失时写本地开发密钥；`db:migrate` 是本地 D1 迁移。真实模型联调使用部署环境；不要把开发服务器暴露到公网。

| 变更范围 | 对应验证 |
| --- | --- |
| 纯文档 | 核对源码、命令、相对链接、Markdown 及 `git diff --check`；无需重新调用真实模型或打包 |
| 协议、状态、策略 | `npm run typecheck`；相关 `api` / `reliability` 测试；改动跨多个运行流程时执行 `npm test` |
| 模型协议与结构化输出 | `tests/model.test.ts` 加实际生产入口测试；地区/加密作业修改同时验证 `tests/egress.test.ts`，避免只测未接入的 helper |
| Web/共享 UI | `npm run typecheck`、`npm run build`；检查手机、窄桌面、键盘及加载/离线/错误/等待协助状态 |
| Executor、原生依赖、Forge | 打包后 smoke；恢复逻辑还需针对真实 `execute` / `ExecutorHost` 的故障验证，不能由 smoke 代替 |

```powershell
npm run typecheck
npm test
npm run build
npm run check:repo
```

可按范围执行 `node --import tsx --test tests/model.test.ts tests/egress.test.ts`。验证应命中实际生产 interface；检查通过后，只有新改动、失败或未解风险才需要扩大/重复测试。

## Windows 打包与证据

```powershell
npm run prepare:browser
npm run package
npm run test:smoke
npm run make
```

固定 Stagehand 4.3.0；保留 Executor 的原生动态 `import()` 和暂存的运行依赖。浏览器与扩展位于 ASAR 外，打包前验证资源哈希。不要把所有 `node_modules` 无筛选打进安装包。升级这些工具时检查安装后的加载路径，不能只凭 Vite 构建成功判断。

`TaskRelay Setup.exe` 位于 `apps/desktop/out/make/squirrel.windows/x64/`。`out/`、`.cache/`、打包资源和图产物不是源文件；不要用旧 smoke JSON 冒充本次结果。`scripts/smoke.mjs` 校验报告的新鲜度。

现有 smoke 在安装产物中运行独立 Stagehand 流程，**不调用 `runtime.execute()` 或 `ExecutorHost`**。它证明原生依赖和自建站操作可用，不能证明完整调度、恢复与租约流程。Node SQLite 的 D1 stand-in 也不能代替真实 D1 并发验证。

结果报告分别说明：源码测试、构建、打包/安装目录、干净 Windows、真实模型、真实网站和连续观察。以 [ACCEPTANCE.md](docs/ACCEPTANCE.md) 为验收台账；未执行不得改成通过。当前真实 Responses 能力测试通过不等于 GPT/非 GPT 浏览器闭环完成。

## 文档与架构变更

修改事实归属、执行顺序、协议、状态或打包规则时同步更新 `docs/ARCHITECTURE.md`；修改协作约定时更新本文，避免维护第二份 agent 指南。验收证据变动更新验收台账，产品目标变动更新 `PRODUCT.md`。

结构化输出候选已获授权并落地：生产统一使用 `models.generateStructured`，通过 `invoke` 保留美国出站；Zod 与 Ajv 仅负责校验适配。其余运行状态、恢复、协助生命周期候选仍未实施。不要直接接入未使用的 `assertTransition`。
