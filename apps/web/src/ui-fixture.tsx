// Dedicated development-only UI fixture; not imported by the production entry.
import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "../../../packages/ui/src/app";
import { taskInputSchema } from "../../../packages/contracts/src/index";
import type {
  Snapshot,
  TaskDefinition,
  TaskInput,
  Transport,
  DesktopStatus,
} from "../../../packages/contracts/src/index";
const options = new URLSearchParams(location.search),
  state = options.get("state") ?? "new";
const definition: TaskDefinition = {
  id: "demo_task",
  version: 1,
  modelVersion: 1,
  status: "active",
  createdAt: new Date().toISOString(),
  nextRunAt: null,
  title: "演示 · 每日查询",
  goal: "每天上午九点查询 https://example.com 的信息",
  entryUrl: "https://example.com/",
  allowedOrigins: ["https://example.com"],
  accountId: null,
  modelId: "fixture_model",
  allowedActions: ["read", "navigate"],
  verification: { kind: "text_present", value: "操作成功" },
  schedule: {
    kind: "cron",
    expression: "0 9 * * *",
    timezone: "Asia/Shanghai",
  },
};
const snapshot: Snapshot = {
  tasks: state === "new" ? [] : [definition],
  runs: [],
  accounts: [],
  devices: [],
  challenges: [],
  serverTime: new Date().toISOString(),
  models: [
    {
      id: "fixture_model",
      version: 1,
      name: "演示模型",
      baseUrl: "https://example.com/v1",
      model: "fixture",
      protocol: "chat",
      hasKey: true,
      inputPrice: null,
      outputPrice: null,
      capabilities: {
        connection: true,
        tools: true,
        structured: "schema",
        vision: false,
        testedAt: null,
      },
    },
  ],
};
if (state !== "new")
  snapshot.runs.push({
    id: "demo_run",
    taskId: definition.id,
    task: definition,
    status:
      state === "challenge"
        ? "waiting_user"
        : state === "failed"
          ? "unknown"
          : state === "running"
            ? "running"
            : "succeeded",
    scheduledFor: new Date().toISOString(),
    deadline: new Date(Date.now() + 3600000).toISOString(),
    deviceId: "demo_device",
    leaseEpoch: 1,
    leaseExpiresAt: null,
    cancelRequested: false,
    writePending: false,
    result:
      state === "challenge" || state === "running"
        ? null
        : {
            summary: "演示结果：页面信息已整理。",
            outcome: "read_result",
            evidence: [
              {
                url: "https://example.com/",
                quote: "操作成功",
                capturedAt: new Date().toISOString(),
              },
            ],
          },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
if (state === "challenge")
  snapshot.challenges.push({
    id: "demo_challenge",
    runId: "demo_run",
    leaseEpoch: 1,
    version: 1,
    stepId: "demo_step",
    kind: "code",
    instruction: "演示验证：请输入 0012aB。此页面不连接真实网站。",
    expiresAt: new Date(Date.now() + 300000).toISOString(),
    status: "pending",
  });
const messages: { id: string; role: string; content: string; at: string }[] =
  [];
const created = new Map<string, string>();
let failed = false;
const desktop: DesktopStatus = {
  paired: true,
  cloudUrl: "https://example.com",
  paused: false,
  online: state !== "offline",
  activeRunId: state === "running" ? "demo_run" : null,
  version: "演示",
  autoStart: false,
  error: null,
};
const transport: Transport = {
  async request<T>(method: string, path: string, body?: any): Promise<T> {
    await new Promise((r) => setTimeout(r, 200));
    let result: unknown;
    if (path === "/api/user/snapshot") result = structuredClone(snapshot);
    else if (path === "/api/user/tasks/compose") {
      if (options.has("fail") && !failed) {
        failed = true;
        throw new Error("MODEL_EGRESS_TIMEOUT");
      }
      const last = body.messages.at(-1).content;
      result =
        !body.current &&
        !body.messages.some((m: any) => m.content.includes("https://"))
          ? { reply: "请提供要操作的网站完整 HTTPS 地址。", task: null }
          : {
              reply: "已整理好任务，请核对范围后试运行。",
              task: {
                ...taskInputSchema.strip().parse(definition),
                ...body.current,
                modelId: body.modelId,
                title: "演示 · 新建任务",
                goal: body.current?.goal ?? last,
              },
            };
    } else if (path === "/api/user/tasks" && method === "POST") {
      let id = created.get(body.requestId);
      if (!id) {
        id = "demo_created_" + created.size;
        created.set(body.requestId, id);
        snapshot.tasks.unshift({
          ...definition,
          ...body.task,
          id,
          status: "pending_validation",
        });
      }
      result = { id };
    } else if (path.match(/tasks\/[^/]+$/) && method === "PUT") {
      const task = snapshot.tasks.find((t) => path.endsWith(t.id))!;
      Object.assign(task, body.task, { version: task.version + 1 });
      result = { id: task.id };
    } else if (path.endsWith("/chat")) {
      if (method === "POST") {
        messages.push(
          {
            id: crypto.randomUUID(),
            role: "user",
            content: body.content,
            at: new Date().toISOString(),
          },
          {
            id: crypto.randomUUID(),
            role: "assistant",
            content: "这是界面演示回复。",
            at: new Date().toISOString(),
          },
        );
        result = { ok: true };
      } else result = messages;
    } else if (path.includes("/challenges/")) {
      snapshot.challenges[0].status = "consumed";
      snapshot.runs[0].status = "running";
      result = { ok: true };
    } else if (path.startsWith("/api/user/runs/"))
      result = {
        events: [
          {
            id: "demo_event",
            runId: "demo_run",
            sequence: 1,
            kind: "observed",
            message: "已打开授权网站并读取页面。",
            at: new Date().toISOString(),
          },
        ],
        usage: [{ input: 11, output: 7, cost: null }],
      };
    else if (path === "/api/user/settings") result = { retentionDays: 30 };
    else result = { ok: true };
    return result as T;
  },
};
if (options.has("desktop") || state === "offline")
  transport.desktop = {
    status: async () => ({ ...desktop }),
    configure: async () => ({ url: "https://example.com", code: "DEMO" }),
    pairPoll: async () => true,
    pause: async (v) => {
      desktop.paused = v;
    },
    autoStart: async (v) => {
      desktop.autoStart = v;
    },
    stop: async () => {
      desktop.activeRunId = null;
    },
    diagnostics: async () => "演示诊断，不含敏感信息",
    subscribe: () => () => {},
  };
if (import.meta.env.DEV)
  createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App transport={transport} />
    </React.StrictMode>,
  );
