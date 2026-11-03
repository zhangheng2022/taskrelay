# TaskRelay

<!-- impeccable:product-schema 1 -->

## Platform
web

## Stack
React, Vite, TypeScript, shadcn/ui, Tailwind CSS; Electron Forge Windows x64 desktop; Stagehand 4.3.0; Cloudflare Workers, Hono, D1, Drizzle and private R2. npm workspaces.

## Users
Personal use by the owner, including remote task management from a phone and execution on a Windows computer.

## Product Purpose
Describe a browser task once, schedule it centrally, execute on an authorized local device, and inspect verifiable results. Human verification always uses the task conversation.

## Capabilities and Constraints
Cloud is authoritative. Desktop shares task management, caches history and can stop execution offline, but does not schedule offline. Public OpenAI-compatible endpoints support Chat Completions and Responses; no GPT-only restriction. Credential and verification parsing may use the configured model. No direct browser takeover or remote desktop. RewardPilot is an architecture reference only; UI and business implementation are independent. No automatic updater in v1. Never infer success from a model claim alone or replay uncertain external writes.

## Brand Commitments
TaskRelay / 任务接力. Chinese UI. React and official shadcn/ui components. Full Windows desktop client and responsive website with shared TaskRelay UI.

## Product Principles
- Cloud task versions and durable execution facts drive state.
- Human input is scoped to a specific live challenge.
- Show uncertainty and capability limits explicitly.
- Secrets never enter ordinary logs or exported diagnostics.

## Evidence on Hand
Implemented web, Workers and Windows desktop code, with source tests, development-machine packaging/installation smoke evidence, and a real Responses model capability check recorded in docs/ACCEPTANCE.md. The smoke path does not exercise the full task executor or recovery flow. Real GPT/non-GPT browser-task loops, clean-machine acceptance and seven-day observation remain incomplete. RewardPilot was examined only as an architecture reference.
