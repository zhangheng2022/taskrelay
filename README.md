# TaskRelay

个人浏览器任务工作台：网站配置任务，Cloudflare 调度，Windows 客户端在专用 Chromium 中执行。所有验证码、扫码和操作确认都通过任务对话处理。

工作空间：https://taskrelay.zhangheng.workers.dev （Cloudflare Access，仅配置的本人邮箱可访问）

## 使用

1. 在网站“设置 → 模型服务”填写自己的公网 OpenAI 兼容服务和任意模型名称。默认 Chat Completions，也支持 Responses。Base URL 示例 `https://api.openai.com/v1`；粘贴完整 `/responses` 或 `/chat/completions` 地址时自动规范，并检查协议是否一致。
2. 保存后执行“测试能力”。连接、工具调用、结构化输出都通过后才能创建 AI 任务。图像能力可以单独测试。未返回用量或未设置单价时显示未知。
3. 安装 Windows x64 的 `TaskRelay Setup.exe`。在客户端“设置 → 设备”通过系统浏览器授权，核对网站和客户端的校验码。
4. 描述任务，检查生成的任务卡中的网站、账号、时间、操作授权和成功判据，再点击“创建并试运行”。核验成功才启用周期调度。
5. 需要协助时在任务对话回复。敏感信息不会进入普通聊天历史。结果待核查时先运行只读核查，不自动重复提交。

客户端关闭窗口后保留托盘；从托盘选择退出会停止本机进程。自启动默认关闭。离线时可读缓存、停止本机执行，不能创建或调度新任务。

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

## Windows 构建

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
| apps/cloud         | Hono API、D1 调度/租约/幂等、加密、R2、美国区域模型网关        |
| apps/desktop       | Electron Main、受限 Preload、独立 utilityProcess 执行器、Forge |
| packages/contracts | Zod 协议、授权策略、时区调度                                   |
| packages/model     | Chat Completions / Responses 适配                              |
| packages/ui        | 自行设计的 React + shadcn/ui 共享界面                          |

架构现状与改进候选见 [ARCHITECTURE.md](docs/ARCHITECTURE.md)，开发及技能指引见 [AGENTS.md](AGENTS.md)。部署说明见 [DEPLOYMENT.md](docs/DEPLOYMENT.md)，实际验证范围见 [ACCEPTANCE.md](docs/ACCEPTANCE.md)。
