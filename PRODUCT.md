# TaskRelay

## 0.11.0 聊天与 Stagehand AI 执行（2026-11-05）

本节取代下方历史版本的运行流程描述。明确交办经云端意图检查后直接交给执行器；执行器拥有完整 AI 工具循环，遇到问题先向云端求助，云端无法解决再在同一聊天询问用户。工具反馈、截图和执行器最终答复使用同一消息流；移除旧云端 plan、批量核验、挑战回复及独立报告生产入口。

原始消息整体交给执行器和 Stagehand，由 AI 理解账号密码、用户补充与实际页面。不要求输入字段分类、自定义动作计划或最终结果枚举；执行器直接回复实际结果。

迁移 0019 保留历史与连接配置，绑定运行/截图到原聊天，导入旧运行事件；图片由私有加密 Evidence 保存，长期保留至聊天删除。协议 14 只领取新版运行。个人次数限制不恢复。条件卡和定时暂不扩展。

已通过新主链生产接口集成：多项目处理、云端求助、原聊天私密回复、继续执行、图片与最终答复；模型使用隔离提供方响应，不能代替部署环境真实模型验收。当前源码验证、打包、部署及现场验收仍在进行，尚不宣称已安装或真实积分通过。


<!-- impeccable:product-schema 1 -->

## Platform
web

## Stack
React, Vite, TypeScript, shadcn/ui, Tailwind CSS; Electron Forge Windows x64 desktop; Stagehand 4.3.0; Cloudflare Workers, Hono, D1, Drizzle and encrypted SQLite Durable Objects for short-lived evidence. npm workspaces. Production has no R2 binding.

## Users
Registered users manage their own browser tasks on the website, including from a phone. Administrators maintain a shared pool of trusted Windows execution devices.

## Product Purpose
Describe a browser task once, schedule it centrally, execute on an administrator-authorized shared device, and inspect verifiable results. Human verification always uses the website task conversation.

## Capabilities and Constraints
Cloud is authoritative for identity, ownership, quotas, scheduling and leases. The Windows app only connects, claims, executes, requests assistance, reports results and recovers; its small window and tray expose status, pause, stop, autostart and diagnostics. It has no task editor, chat, model settings, account manager or history browser. Administrators configure shared models; users cannot read keys or change provider settings. Chat Completions and Responses remain supported without a GPT-only restriction. No direct browser takeover or remote desktop, paid plans, user-provided models or user-contributed devices. Never infer success from a model claim alone or replay uncertain external writes. Shared devices are trusted administrator environments; separate browser profiles do not hide data from device administrators.

## Brand Commitments
The installed Windows executor checks for releases and notifies the operator. Download and installation require confirmation; updates wait for active tasks and result delivery to finish. All update traffic passes through Cloudflare, with no direct client connection to GitHub.

TaskRelay / 任务接力. Chinese UI. React and official shadcn/ui default neutral styles. The responsive website owns task conversations; the Windows client is a standalone executor. Light, dark and system themes. [shadcn/ui AI Elements](https://ui.shadcn.com/docs/ai-elements) is the reference for task chat, prompt input, model selection, execution steps, results and confirmation. Codex-like refers to the task sidebar, conversation and bottom composer layout. Clear assignments start execution directly; questions do not. Keep creation, steering, assistance and reports in the same conversation. After success, the user reviews the generated running conditions and confirms frequency, model and account before repeated execution. Implementation rules live in [AGENTS.md](AGENTS.md#ui-专项要求).

## Product Principles

- 通用批量任务：用户确认业务目标、列表范围、处理资格及排除项；系统执行时发现清单、逐项读取状态并复核覆盖。全部完成判断由 AI 基于实际观察作出，不提供文字、URL 或数量硬匹配条件。无完整证据或超过限额时报告实际进度与未核实项目，不要求用户预先提供页面原文或数量。AI 根据实际页面规划、判断业务结果和纠错；总数可未知，范围结论须说明证据。不能保证任意网页流程自动完成。
- Cloud task versions and durable execution facts drive state.
- Ordinary instructions affect the current run; explicit future instructions update long-term requirements. Sensitive assistance remains bound to its live challenge.
- Show uncertainty and capability limits explicitly.
- Secrets never enter ordinary logs or exported diagnostics.

## Evidence on Hand
Implemented web, Workers and Windows desktop code, with source tests, development-machine packaging/installation smoke evidence, and a real Responses read-only browser-task loop recorded in docs/ACCEPTANCE.md. The standalone smoke path does not exercise the full task executor or recovery flow; dedicated tests now call the production Host and execute implementations with isolated platform adapters. Clean-machine acceptance, additional model protocols/providers and seven-day observation require separate evidence. RewardPilot was examined only as an architecture reference.
`2026-11-04`：目标和授权范围来自用户交办，网页可观察信息留给执行阶段判断。时间未指定只执行一次。仅要求未来执行时不提前运行；首次未来运行结束后也须用户确认条件卡才重复执行。失败、部分完成和未知结果只报告实际进度，不生成成功经验。个人次数限制保持用户指定的关闭状态，不自动恢复。项目级每日平台预算和全站模型总额度已删除；保留实际用量记录，Cloudflare 和模型提供方的外部限制仍由其各自执行。

网站访问不设授权名单；用户用品牌或产品名交办时，AI 可识别公开入口并继续任务，只有关键歧义才追问。凭据仅交给其所属网站，公开地址与 DNS 安全检查不变。


协助和补充要求共用一个输入框，由 AI 自主判断回复意图，不要求用户切换消息用途。按用户强制要求，账号、密码和验证码可在本人会话显示，并供当前任务 AI 理解和使用；协助回复仍加密保存。Stagehand 提供 AI 观察、动作和信息提取，高层规划不要求选择器。

AI 根据实际页面理解动作用途；登录、筛选、导航、编辑和业务处理无需预先建立批量项目。进度用于报告，动作账本用于未知结果保护和防重复提交。报告只总结所选运行，长证据压缩不会触发重新执行。
