import type { ScheduleCard } from "../../../packages/contracts/src/task-schedule";
import type { MemoryPreference } from "../../../packages/contracts/src/preferences";
import {
  PROTOCOL_VERSION,
  type Snapshot,
  type TaskDefinition,
  type Transport,
  type DesktopStatus,
} from "../../../packages/contracts/src/index";
import type { ThreadPage } from "../../../packages/ui/src/use-thread";

// 开发预览的隔离 Transport：按当前网站请求合同维护演示任务、聊天和执行器状态。
// 每次创建独立状态；只返回内存演示数据，不访问网络、模型或安装程序。
export function createFixtureTransport(options: URLSearchParams): Transport {
  let scheduleCard: ScheduleCard = {
    version: 1,
    taskVersion: 1,
    summary: "每天读取订单并汇总待处理事项",
    ready: true,
    state: "off",
    frequency: null,
    legacy: null,
    nextRunAt: null,
  };
  const state = options.get("state") ?? "new";
  const assistance = [
    "challenge",
    "approval",
    "scan",
    "expired",
    "unsupported",
    "answered",
  ].includes(state);
  const definition: TaskDefinition = {
    id: "demo_task",
    version: 1,
    modelVersion: 1,
    status: "active",
    createdAt: new Date().toISOString(),
    nextRunAt: null,
    title: "演示 · 每日查询",
    goal: "查询 https://example.com 的信息",
    entryUrl: "https://example.com/",
    accountId: null,
    modelId: "fixture_model",
    allowedActions: ["read", "navigate"],
    verification: { kind: "goal", value: "操作成功" },
    schedule: { kind: "manual" },
  };
  const snapshot: Snapshot = {
    me: { id: "demo", email: "demo@example.com", role: options.has("admin") ? "admin" : "user" },
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
  if (options.has("batch"))
    definition.verification = {
      kind: "batch",
      value: "每条普通记录标记为已处理",
      scope: "当前账号全部记录及其分页",
      eligibility: "普通记录",
      exclusions: ["已归档记录"],
    };
  if (state !== "new")
    snapshot.runs.push({
      id: "demo_run",
      userId: "demo",
      profileId: "profile_demo",
      taskId: definition.id,
      task: definition,
      status: assistance
        ? "waiting_user"
        : state === "failed"
          ? "unknown"
          : state === "error"
            ? "failed"
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
        assistance || state === "running"
          ? null
          : {
              summary: "演示结果：页面信息已整理。",
              outcome: "reported",
              data: {
                title: "页面公告",
                content: "这是用于验证结果布局的演示数据。",
                checked: true,
              },
              ...(state === "error" ? { errorCode: "MODEL_EGRESS_TIMEOUT" } : {}),
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
  if (options.has("batch") && snapshot.runs[0]?.result) {
    const result = snapshot.runs[0].result;
    result.summary = "批量任务尚未全部核验：本次完成 1 项，原已完成 1 项，排除 1 项，待核查 1 项。";
    delete result.data;
    result.batch = {
      coverage: "incomplete",
      expected: 4,
      reason: "最后一页仍需复核，未将已发现项目当作全部完成。",
      items: [
        { id: "one", label: "记录一：订单资料核对", status: "completed" },
        { id: "two", label: "记录二：供应商信息更新", status: "already_done" },
        { id: "three", label: "记录三：已归档的历史项目", status: "excluded" },
        {
          id: "four",
          label: "记录四：需要继续核查的长名称项目，用于检查手机上的换行与完整显示",
          status: "unknown",
        },
      ].map((item) => ({
        ...item,
        status: item.status as "completed" | "already_done" | "excluded" | "unknown",
        reason: item.status === "excluded" ? "已归档记录" : "",
        evidence: {
          url: "https://example.com/",
          quote: item.status === "unknown" ? "提交结果尚未确认" : "已读取对应项目状态",
          capturedAt: new Date().toISOString(),
        },
      })),
    };
  }
  if (assistance && state !== "answered")
    snapshot.waitingHelp = [{ id: "demo_help", runId: "demo_run", taskId: definition.id }];
  const messages: { id: string; role: string; content: string; at: string }[] = options.has(
    "history",
  )
    ? Array.from({ length: 24 }, (_, i) => ({
        id: `history-${i}`,
        role: i % 2 ? "assistant" : "user",
        content:
          i % 2
            ? `第 ${i + 1} 条演示回复：这里是已记录的执行情况。\n详情会随真实事件回传更新。`
            : `第 ${i + 1} 条任务询问`,
        at: new Date().toISOString(),
      }))
    : [];
  const threads = new Map<string, ThreadPage & { kind: "chat" }>();
  const memories = new Map<string, MemoryPreference>();
  if (options.has("settings")) {
    snapshot.accounts.push({
      id: "demo_account",
      name: "工作账号",
      origin: "https://example.com",
      usernameHint: "de***",
      enabled: true,
      managementVersion: 1,
      createdAt: new Date().toISOString(),
      assignedDeviceId: null,
      credentialVersion: 1,
      stateEpoch: 1,
      credentialStatus: "valid",
      syncStatus: "synced",
    });
    const at = new Date().toISOString();
    for (let i = 0; i < (options.has("long") ? 105 : 2); i++)
      memories.set("memory_" + i, {
        id: "memory_" + i,
        text:
          i === 0 ? "结果优先使用中文，保持简洁，列出仍需确认的事项。" : "日期使用年-月-日格式。",
        enabled: i === 0,
        version: 1,
        createdAt: at,
        updatedAt: at,
      });
  }
  let retentionDays = 30,
    claimsEnabled = "0";
  let failed = false;
  let threadFailures = 0;
  const desktop: DesktopStatus = {
    update: { phase: "current", release: null, progress: null, checkedAt: null, error: null },
    paired: true,
    cloudUrl: "https://example.com",
    paused: false,
    online: state !== "offline",
    activeRunId: state === "running" ? "demo_run" : null,
    version: "演示",
    autoStart: false,
    error: null,
  };
  const updatePhase = options.get("update");
  if (
    updatePhase &&
    ["available", "downloading", "waiting", "installing", "error"].includes(updatePhase)
  ) {
    desktop.version = "0.4.7";
    desktop.update = {
      phase: updatePhase as DesktopStatus["update"]["phase"],
      release: {
        version: "0.4.8",
        sha1: "a".repeat(40),
        sha256: "a".repeat(64),
        bytes: 1024,
        notes: "改进执行器的稳定性和更新体验。",
        publishedAt: new Date().toISOString(),
      },
      progress: 42,
      checkedAt: null,
      error: updatePhase === "error" ? "更新下载或完整性校验失败，请重试。" : null,
    };
  }
  const cleanupJobs = new Map<
    string,
    { id: string; status: string; total: number; completed: number; error: null; readyAt: number }
  >();
  let chatCleared = false;
  const transport: Transport = {
    async request<T>(method: string, path: string, body?: unknown): Promise<T> {
      await new Promise((r) => setTimeout(r, options.get("network") === "slow" ? 12000 : 200));
      // StrictMode probes the initial effect twice; both probes must see the outage.
      if (
        options.get("network") === "fail-once" &&
        path.split("?")[0] === "/api/user/threads" &&
        threadFailures++ < 2
      )
        throw new Error("OFFLINE");
      let result: unknown;
      if (path.includes("/schedule")) {
        if (path.endsWith("/preview"))
          result = {
            times: [1, 2, 3].map((days) => new Date(Date.now() + days * 86400000).toISOString()),
          };
        else {
          if (method !== "GET") {
            const input = body as { enabled: boolean; frequency?: ScheduleCard["frequency"] };
            scheduleCard = {
              ...scheduleCard,
              version: scheduleCard.version + 1,
              state: input.enabled ? "enabled" : "paused",
              frequency: input.frequency ?? scheduleCard.frequency,
              nextRunAt: input.enabled ? new Date(Date.now() + 86400000).toISOString() : null,
            };
          }
          result = {
            card: options.has("schedule") ? scheduleCard : null,
            learning: [
              {
                runId: "demo_run",
                createdAt: new Date().toISOString(),
                accountId: null,
                accountName: null,
                state: "done",
                summary: "已读取当天订单；页面没有额外结果。",
                improvements: "先核对日期范围，再读取列表，避免重复进入详情。",
                applied: true,
                incomplete: false,
                error: null,
              },
            ],
          };
        }
      } else if (path === "/api/user/snapshot") result = structuredClone(snapshot);
      else if (path.startsWith("/api/user/history-cleanups-preview"))
        result = {
          chats: snapshot.tasks.length,
          active: snapshot.runs.filter((r) =>
            ["queued", "running", "waiting_user", "verifying"].includes(r.status),
          ).length,
        };
      else if (path === "/api/user/history-cleanups") {
        if (method === "GET")
          result = [...cleanupJobs.values()].filter((j) => Date.now() < j.readyAt);
        else {
          const input = body as { scope: string; targetId: string | null; requestId: string };
          let job = cleanupJobs.get(input.requestId);
          if (!job) {
            job = {
              id: crypto.randomUUID(),
              status: "pending",
              total: 3,
              completed: 0,
              error: null,
              readyAt: Date.now() + 6000,
            };
            cleanupJobs.set(input.requestId, job);
            for (const [id, page] of threads)
              if (input.scope === "all" || page.taskId === input.targetId) threads.delete(id);
            snapshot.runs = snapshot.runs.filter(
              (r) => input.scope !== "all" && r.taskId !== input.targetId,
            );
            snapshot.waitingHelp = [];
            if (input.scope === "clear") {
              chatCleared = true;
              definition.status = "paused";
              definition.goal = "请重新交办任务";
              definition.schedule = { kind: "manual" };
            } else
              snapshot.tasks = snapshot.tasks.filter(
                (t) => input.scope !== "all" && t.id !== input.targetId,
              );
          }
          result = job;
        }
      } else if (path.split("?")[0] === "/api/user/threads") {
        if (method === "GET")
          result = {
            items: [...threads.values()].map((t) => ({
              ...t,
              model_id: t.modelId,
              task_id: t.taskId ?? null,
            })),
            nextCursor: null,
          };
        else {
          const input = body as { modelId: string; taskId?: string };
          const boundTask = snapshot.tasks.find((task) => task.id === input.taskId);
          if (input.taskId && !boundTask) throw new Error("TASK_NOT_FOUND");
          const id = crypto.randomUUID();
          const page: ThreadPage & { kind: "chat" } = {
            id,
            kind: "chat",
            taskId: input.taskId ?? null,
            modelId: input.modelId,
            version: 0,
            draft: boundTask ?? null,
            partial: {},
            activeTurn: null,
            nextCursor: null,
            messages:
              boundTask && !chatCleared ? messages.map((m, i) => ({ ...m, seq: i + 1 })) : [],
            waiting:
              boundTask && !chatCleared && assistance && state !== "answered"
                ? { id: "demo_help", request: "{}" }
                : null,
          };
          if (page.waiting)
            page.messages.push({
              id: "help-message",
              seq: page.messages.length + 1,
              role: "assistant",
              content: "请在同一聊天提供登录所需信息，或说明下一步要求。",
              at: new Date().toISOString(),
            });
          if (boundTask && snapshot.runs[0]?.result)
            page.messages.push({
              id: "final-message",
              seq: page.messages.length + 1,
              role: "assistant",
              content: snapshot.runs[0].result.summary,
              at: new Date().toISOString(),
            });
          threads.set(id, page);
          result = structuredClone(page);
        }
      } else if (path.startsWith("/api/user/threads/")) {
        const id = path.split("/")[4],
          page = threads.get(id);
        if (!page) throw new Error("THREAD_NOT_FOUND");
        if (method === "DELETE") {
          threads.delete(id);
          result = { ok: true };
        } else if (path.endsWith("/messages")) {
          if (options.has("fail") && !failed) {
            failed = true;
            throw new Error("MODEL_EGRESS_TIMEOUT");
          }
          page.version++;
          const { content } = body as { content: string };
          const at = new Date().toISOString();
          page.messages.push(
            { id: crypto.randomUUID(), seq: page.messages.length + 1, role: "user", content, at },
            {
              id: crypto.randomUUID(),
              seq: page.messages.length + 2,
              role: "assistant",
              content: "这是界面演示回复，不会执行真实任务。",
              at,
            },
          );
          page.waiting = null;
          snapshot.waitingHelp = [];
          result = { ...structuredClone(page), status: "done" };
        } else result = structuredClone(page);
      } else if (path.startsWith("/api/user/memory-page")) {
        const start = Number(new URL(path, "http://fixture").searchParams.get("before") ?? 0),
          values = [...memories.values()];
        result = {
          items: values.slice(start, start + 30),
          nextCursor: start + 30 < values.length ? String(start + 30) : null,
        };
      } else if (path === "/api/user/memories")
        result = [...memories.values()].map((m) => ({ key: m.id, value: { text: m.text } }));
      else if (path.startsWith("/api/user/memories/")) {
        const key = path.split("/").at(-1)!;
        if (method === "DELETE") memories.delete(key);
        else {
          const input = body as { text: string; enabled: boolean };
          const at = new Date().toISOString();
          memories.set(key, {
            id: key,
            text: input.text,
            enabled: input.enabled,
            version: (memories.get(key)?.version ?? 0) + 1,
            createdAt: memories.get(key)?.createdAt ?? at,
            updatedAt: at,
          });
        }
        result = { ok: true };
      } else if (path.endsWith("/cancel")) {
        snapshot.runs[0].cancelRequested = true;
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
            ...(state === "error"
              ? [
                  {
                    id: "demo_error",
                    runId: "demo_run",
                    sequence: 2,
                    kind: "error",
                    message: "模型请求未在允许时间内完成；未执行写操作。",
                    at: new Date().toISOString(),
                  },
                ]
              : []),
          ],
          usage: [{ input: 11, output: 7, cost: null }],
        };
      else if (path === "/api/user/settings" || path === "/api/admin/settings") {
        if (method === "PUT") retentionDays = (body as { retentionDays: number }).retentionDays;
        result = { retentionDays };
      } else if (path === "/api/admin/pool") {
        claimsEnabled = (body as { claimsEnabled: boolean }).claimsEnabled ? "1" : "0";
        result = { ok: true };
      } else if (path === "/api/admin/operations")
        result = {
          users: [
            { id: "demo", email: "demo@example.com", role: "admin", disabled: 0 },
            { id: "other", email: "member@example.com", role: "user", disabled: 0 },
          ],
          devices: [
            {
              id: "demo_device",
              name: "办公室执行器",
              last_seen: new Date().toISOString(),
              revoked: 0,
              protocol_version: PROTOCOL_VERSION,
              activeRunIds: [],
            },
          ],
          runs: [],
          accounts: snapshot.accounts.map((a) => ({
            id: a.id,
            name: a.name,
            origin: a.origin,
            user_id: "demo",
            assigned_device_id: null,
            login_reset: 0,
          })),
          settings: { claimsEnabled },
        };
      else result = { ok: true };
      return result as T;
    },
  };
  if (options.has("desktop") || options.has("executor") || state === "offline")
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
      checkUpdate: async () => {},
      downloadUpdate: async () => {},
      subscribe: () => () => {},
    };

  return transport;
}
