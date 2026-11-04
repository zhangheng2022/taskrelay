# TaskRelay

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

TaskRelay / 任务接力. Chinese UI. React and official shadcn/ui default neutral styles. The responsive website owns task conversations; the Windows client is a standalone executor. Light, dark and system themes. [shadcn/ui AI Elements](https://ui.shadcn.com/docs/ai-elements) is the reference for task chat, prompt input, model selection, execution steps, results and confirmation. Codex-like refers to the task sidebar, conversation and bottom composer layout. Natural-language task creation asks only for missing information and requires explicit confirmation of the generated task card before saving or running. Detailed forms remain secondary. Implementation rules live in [AGENTS.md](AGENTS.md#ui-专项要求).

## Product Principles
- Cloud task versions and durable execution facts drive state.
- Human input is scoped to a specific live challenge.
- Show uncertainty and capability limits explicitly.
- Secrets never enter ordinary logs or exported diagnostics.

## Evidence on Hand
Implemented web, Workers and Windows desktop code, with source tests, development-machine packaging/installation smoke evidence, and a real Responses read-only browser-task loop recorded in docs/ACCEPTANCE.md. The standalone smoke path does not exercise the full task executor or recovery flow; dedicated tests now call the production Host and execute implementations with isolated platform adapters. Clean-machine acceptance, additional model protocols/providers and seven-day observation require separate evidence. RewardPilot was examined only as an architecture reference.
`2026-11-03`：创建对话支持直接输入 `www.baidu.com`、`example.com/path` 等明确域名，自动补全 HTTPS；确认卡显示完整地址。网站名称、查看内容、时间和成功判据仍需明确，不替用户猜测。
