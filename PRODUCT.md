# TaskRelay · 任务接力

<!-- impeccable:product-schema 1 -->

## Platform
web

## Stack
React、Vite、TypeScript、shadcn/ui、Tailwind CSS；Electron Forge Windows x64 执行器；Stagehand 4.3.0；Cloudflare Workers、Hono、D1 与加密 SQLite Durable Objects。npm workspaces，生产不绑定 R2。

## Users
注册用户在网站拥有隔离的浏览器任务空间，支持手机访问。管理员维护共享模型与可信 Windows 设备池。公开注册默认关闭。

## Product Purpose
用户在同一聊天交办、补充、提供协助并查看执行结果。明确任务由云端理解意图、生成可调整的大步骤后交给执行器；阶段计划在聊天中显示，信息含糊才询问。执行器根据现场页面细化操作、纠错和最终回复，用户补充优先于阶段计划。云端不逐步控制浏览器或另起报告。

## Capabilities and Constraints
- 网站负责任务、聊天、图片、历史、账号与设置；桌面只负责连接、执行、暂停、停止、自启动和诊断。
- 普通与批量目标共用 AI 工具循环，依实际反馈报告进度、部分完成或受阻。没有固定项目身份、强制核验表、文字/地址成功硬匹配或独立报告阶段。
- 账号、密码与验证码按用户要求可在本人聊天显示并由当前任务 AI 使用；敏感回复独立加密，平台密钥与设备令牌不进入任务上下文。
- 不设网站授权名单；保留身份隔离、公网访问、凭据所属站点、设备并发、租约、停止与同次工具调用防重。未知结果不自动重放。
- Chat Completions 与 Responses 均支持，模型名自由输入。能力不足明确拒绝，不静默切换模型或提供方；所有模型请求统一经过美国区域后台链路。
- 当前新任务按手动交办执行。条件卡、频率、模型和账号确认保留为产品方向，尚不生成新条件卡。保存偏好尚未进入执行上下文，界面明确说明。
- Cloudflare 保持 Free，个人次数限制保持关闭；不自动购买或切换付费服务，模型费用由提供方计费。

## Brand Commitments
中文界面，默认中性色、浅色/深色/系统主题。侧栏、会话主区与底部输入区布局遵循 shadcn/ui AI Elements，交办、补充和协助共用一个输入框。reported 显示“已回复”，不承诺业务全部成功。

Windows 关闭窗口保留托盘，明确退出停止自有进程，自启动默认关闭。安装版下载更新须确认，等待任务与回传结束才安装；更新流量经 Cloudflare，不直连 GitHub。

## Evidence on Hand
源码、开发机打包/系统安装、真实模型与有引导的网站执行证据见 [验收记录](docs/ACCEPTANCE.md)。尚不能认定无人引导的完整自主执行、干净 Windows、更多提供方、休眠/断网故障和长期观察全部通过。工程约束见 [AGENTS.md](AGENTS.md)，当前实现见 [架构](docs/ARCHITECTURE.md)。
