# TaskRelay

个人浏览器任务工作台：网站配置任务，Cloudflare 调度，Windows 客户端在专用 Chromium 中执行。所有验证码、扫码和操作确认都通过任务对话处理。

工作空间：https://tr.zhangheng.eu.org （Cloudflare Access，仅配置的本人邮箱可访问）。原地址 https://taskrelay.zhangheng.workers.dev 继续可用；已配对客户端可继续使用原地址。

新旧域名均已通过真实模型草稿生成验证。自定义域名的地区拒绝已修复，美国区域出站流程保留；范围和证据见 [验收记录](docs/ACCEPTANCE.md)。

## 使用

1. 在网站“设置 → 模型服务”填写自己的公网 OpenAI 兼容服务和任意模型名称。默认 Chat Completions，也支持 Responses。Base URL 示例 `https://api.openai.com/v1`；粘贴完整 `/responses` 或 `/chat/completions` 地址时自动规范，并检查协议是否一致。
2. 保存后执行“测试能力”。连接、工具调用、结构化输出都通过后才能创建 AI 任务。图像能力可以单独测试。未返回用量或未设置单价时显示未知。
3. 安装 Windows x64 的 `TaskRelay Setup.exe`。在客户端“设置 → 设备”通过系统浏览器授权，核对网站和客户端的校验码。
4. 点击“新建任务”，用一句话描述目标和完整网站地址；信息不足时继续对话补充。检查确认卡中的网站、账号、时间、操作授权和成功判据，再点击“创建并试运行”。核验成功才启用周期调度。
5. 需要协助时在任务对话回复。敏感信息不会进入普通聊天历史。结果待核查时先运行只读核查，不自动重复提交。

客户端关闭窗口后保留托盘；从托盘选择退出会停止本机进程。自启动默认关闭。离线时可读缓存、停止本机执行，不能创建或调度新任务。

网站和桌面共用 shadcn/ui 默认中性色主题，支持浅色、深色和跟随系统。左侧选择任务，中间查看对话、折叠步骤和结果，底部回复；通过“调整任务”生成修改草稿，确认后保存并重新试运行。“编辑配置”保留详细配置入口。

所有模型请求统一由美国区域的 Cloudflare Durable Object 后台发出，覆盖能力测试、任务解析、执行规划和人工协助解析。网站及桌面均不直连模型服务，也不向模型服务传递访问者的地区/IP 请求上下文。现有 `gpt-6-luna / Responses` 已通过真实连接、工具及严格结构化输出测试；这不等同于真实网站任务闭环验收。

## 开发

开发机需要 Node.js 24+；最终用户无需 Node.js。

```powershell
npm ci
node scripts/setup-local.mjs
npm run db:migrate
npm run dev
```

网站本地地址 `http://127.0.0.1:5173`。仅本地 DEV_MODE 允许跳过 Access；生产固定关闭。不要将开发服务器暴露到网络。

本地 workerd 不实现地区约束，真实模型调用会明确返回 `MODEL_REGION_REQUIRES_DEPLOYMENT`。真实模型联调请使用已部署的 Cloudflare 环境；本地协议/状态测试使用隔离模拟，不静默回退到本地网络发送密钥。

```powershell
npm run typecheck
npm test
npm run build
npm run check:repo
```

可选 `node scripts/seed-ui.mjs` 向本地 D1 写入明确标记为“演示”的界面检查数据，不连接生产环境。

界面验收也可打开 `/ui-fixture.html`：只在开发模式渲染共享 App，使用演示 Transport，不访问生产服务。可用 `?state=challenge`、`?state=failed`、`?state=offline`、`?desktop=1`、`?fail=1` 检查协助、未知结果、离线、桌面和首次请求失败。详情见 [UI-REVIEW.md](docs/UI-REVIEW.md)。

## Windows 构建

品牌图形的矢量源文件为 `resources/brand-mark.svg`，共享 UI 使用同一图形并随主题着色。修改后运行 `npm run icons`，生成网站 favicon、Apple Touch Icon 和 Windows PNG/多尺寸 ICO；生成资源随源码保存，普通构建不需要重新生成。桌面窗口、托盘、EXE 和安装器沿用 `resources/icon.png` / `resources/icon.ico` 路径。

```powershell
npm run prepare:browser
npm run package
npm run test:smoke
npm run make
```

`prepare:browser` 从官方 Chrome for Testing 下载 Windows x64 浏览器，固定到生成的版本/哈希清单。资源在 ASAR 外；构建验证浏览器文件哈希。Stagehand 固定 4.3.0，执行器保留原生 `import()` 并单独暂存生产依赖。

- 安装包：`apps/desktop/out/make/squirrel.windows/x64/TaskRelay Setup.exe`
- 解包程序：`apps/desktop/out/TaskRelay-win32-x64/TaskRelay.exe`
- 安装产物测试：`out/packaged-smoke.json`
- 安装目录测试：`out/installed-smoke.json`
- 安装包 SHA-256 与测试结果：`out/release-manifest.json`
- 本机状态：Electron 的 `app.getPath('userData')`，通常 `%APPDATA%/TaskRelay`。SQLite 为 WAL/FULL，设备令牌使用 Windows 系统加密，账号 Profile 分离。

`test:smoke` 在打包后的 Electron utilityProcess 中加载实际 Stagehand/Chromium，使用独立自建站与确定性模型回调检查读取、提取、监测、错误验证码、前导零、登录签到和表单提交。它走独立 smoke 流程，不调用 `runtime.execute()` 或 `ExecutorHost`；不能替代完整任务恢复、真实模型或真实网站验收。

## 工程结构

| 路径               | 职责                                                           |
| ------------------ | -------------------------------------------------------------- |
| apps/web           | Vite 网站和 Cloudflare 部署配置                                |
| apps/cloud         | DO 内的 Hono API、D1 调度/租约/幂等、加密短期证据、美国区域模型网关 |
| apps/desktop       | Electron Main、受限 Preload、独立 utilityProcess 执行器、Forge |
| packages/contracts | Zod 协议、授权策略、时区调度                                   |
| packages/model     | Chat Completions / Responses 适配                              |
| packages/ui        | 自行设计的 React + shadcn/ui 共享界面                          |

架构现状与改进候选见 [ARCHITECTURE.md](docs/ARCHITECTURE.md)，开发及技能指引见 [AGENTS.md](AGENTS.md)。部署说明见 [DEPLOYMENT.md](docs/DEPLOYMENT.md)，实际验证范围见 [ACCEPTANCE.md](docs/ACCEPTANCE.md)。


### LangChain 与 Cloudflare 免费运行架构

普通 Worker 只处理静态资源和轻量路由，Hono 业务进入 SQLite Durable Objects；对话通过 D1 outbox 异步执行，网站与客户端使用休眠 WebSocket 通知和低频兜底。短期图片在 DO 加密保存，生产已移除 R2 绑定。模型 API 保持现有配置与美国 alarm 出站链路，模型提供方费用不属于 Cloudflare 免费承诺。免费预算耗尽时停止接收新工作，不自动开通付费服务；详见 [免费部署](docs/DEPLOYMENT.md#cloudflare-free-运行架构)。

`node scripts/test-free-runtime.mjs` 验证隔离 workerd 的真实 DO 路由、异步 alarm、加密分块证据及 WebSocket 撤销；不调用真实模型。

本机 CPU 对照采样：`node scripts/profile-worker.mjs .cache/ai-profile/current`。脚本在本机 workerd 使用隔离 D1、合成账号和模型响应，输出 CPU profile 与统计；不读取生产密钥，不验证真实模型地区。统计含本地 D1 绑定开销，不能等同 Cloudflare 计费 CPU 或免费套餐达标证明。保留某次构建后可加 `--reuse-bundle` 重跑同一版本。

云端已接入 LangChain.js、LangGraph 与 D1 持久化。创建对话和任务聊天支持云端恢复、游标历史和滚动摘要；设置中的“我的记忆”管理明确确认的偏好。任务卡确认版本、设备租约和美国模型出站约束保持有效。

本地迁移使用 `npm run db:migrate`；现有生产已完成 [0.3.0 一次性切换](docs/DEPLOYMENT.md#langchain-030-一次性切换)，不得重复清理。免费架构新增 `0007_free_runtime.sql`，保留协议 3 和 SQLite schema 3。源码、安装包与生产验证范围分别记录在 [验收](docs/ACCEPTANCE.md)。
