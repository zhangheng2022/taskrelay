import type {
  Snapshot,
  TaskDefinition,
  TaskRun,
  HumanChallenge,
  Transport,
} from "../packages/contracts/src/index";

export const task: TaskDefinition = {
  id: "task-ui",
  version: 1,
  modelVersion: 1,
  status: "active",
  createdAt: new Date().toISOString(),
  nextRunAt: null,
  title: "检查公告",
  goal: "查询公告",
  entryUrl: "https://example.com/",
  accountId: null,
  modelId: "model-ui",
  allowedActions: ["navigate", "read"],
  verification: { kind: "goal", value: "公告" },
  schedule: { kind: "manual" },
};
export const snapshot: Snapshot = {
  tasks: [task],
  runs: [],
  challenges: [],
  accounts: [],
  devices: [],
  serverTime: new Date().toISOString(),
  models: [
    {
      id: "model-ui",
      version: 1,
      name: "自定义",
      model: "non-gpt",
      connectionId: "conn_test",
      protocol: "responses",
      region: "inherit",
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
export const run: TaskRun = {
  id: "run-ui",
  userId: "demo",
  profileId: "profile_demo",
  taskId: task.id,
  task,
  status: "waiting_user",
  scheduledFor: new Date().toISOString(),
  deadline: new Date(Date.now() + 300_000).toISOString(),
  deviceId: "device-ui",
  leaseEpoch: 2,
  leaseExpiresAt: null,
  cancelRequested: false,
  writePending: false,
  result: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};
export const challenge: HumanChallenge = {
  id: "challenge-ui",
  runId: run.id,
  kind: "code",
  instruction: "请输入验证码",
  stepId: "step-ui",
  version: 3,
  leaseEpoch: 2,
  expiresAt: new Date(Date.now() + 300_000).toISOString(),
  status: "pending",
};
export function transportWith(
  request: (method: string, path: string, body?: any) => Promise<unknown>,
): Transport {
  return { request: request as Transport["request"] };
}

export const threadPage = {
  id: "thread_ui",
  kind: "compose",
  version: 0,
  modelId: "model-ui",
  draft: null,
  partial: {},
  activeTurn: null,
  messages: [],
  nextCursor: null,
};
