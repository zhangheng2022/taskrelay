import { z } from "zod";

export const PROTOCOL_VERSION = 3;
export const limits = {
  durationMs: 300_000,
  actions: 40,
  waitMs: 300_000,
  leaseMs: 90_000,
  heartbeatMs: 15_000,
  lateMs: 3_600_000,
};
export const idSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-zA-Z0-9_-]+$/);
export const scheduleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("manual") }),
  z.object({ kind: z.literal("once"), at: z.iso.datetime() }),
  z.object({
    kind: z.literal("cron"),
    expression: z.string().min(5).max(120),
    timezone: z.string().default("Asia/Shanghai"),
  }),
]);
export const verificationSchema = z.object({
  kind: z.enum(["text_present", "text_absent", "url", "extraction"]),
  value: z.string().min(1).max(2000),
});
export const taskInputSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    goal: z.string().min(1).max(6000),
    entryUrl: z.url().max(2000),
    allowedOrigins: z.array(z.url()).min(1).max(20),
    accountId: idSchema.nullable().default(null),
    modelId: idSchema,
    allowedActions: z
      .array(z.enum(["read", "navigate", "fill", "submit", "publish"]))
      .min(1),
    verification: verificationSchema,
    schedule: scheduleSchema,
  })
  .strict();
export type TaskInput = z.infer<typeof taskInputSchema>;
export interface TaskDefinition extends TaskInput {
  id: string;
  version: number;
  modelVersion: number;
  status: "pending_validation" | "active" | "paused" | "needs_input";
  createdAt: string;
  nextRunAt: string | null;
}
export const runStatusSchema = z.enum([
  "queued",
  "running",
  "waiting_user",
  "verifying",
  "succeeded",
  "failed",
  "unknown",
  "cancelled",
  "expired",
]);
export type RunStatus = z.infer<typeof runStatusSchema>;
export interface TaskRun {
  userId: string;
  profileId: string;
  queueReason?: string;
  id: string;
  taskId: string;
  task: TaskDefinition;
  status: RunStatus;
  scheduledFor: string;
  deadline: string;
  deviceId: string | null;
  leaseEpoch: number;
  leaseExpiresAt: string | null;
  cancelRequested: boolean;
  writePending: boolean;
  mayHaveWritten?: boolean;
  result: RunResult | null;
  createdAt: string;
  updatedAt: string;
  reconciliationOf?: string | null;
}
export const runResultSchema = z.object({
  summary: z.string().max(8000),
  outcome: z.enum([
    "completed_now",
    "already_done",
    "read_result",
    "unconfirmed",
    "stopped",
    "error",
  ]),
  data: z.unknown().optional(),
  evidence: z
    .array(
      z.object({
        url: z.string().max(2000),
        quote: z.string().max(4000),
        capturedAt: z.iso.datetime(),
      }),
    )
    .max(10),
  errorCode: z.string().max(100).optional(),
});
export type RunResult = z.infer<typeof runResultSchema>;
export interface RunEvent {
  id: string;
  runId: string;
  sequence: number;
  kind: string;
  message: string;
  at: string;
}
export const challengeInputSchema = z
  .object({
    kind: z.enum(["code", "scan", "approval", "information", "unsupported"]),
    instruction: z.string().min(1).max(2000),
    stepId: idSchema,
    version: z.number().int().positive(),
    target: z.string().max(2000).optional(),
    actionDigest: z.string().max(100).optional(),
  })
  .strict()
  .refine((v) => !["code", "information", "scan"].includes(v.kind) || !!v.target?.trim(), {
    message: "CHALLENGE_TARGET_REQUIRED", path: ["target"],
  });
export interface HumanChallenge extends z.infer<typeof challengeInputSchema> {
  id: string;
  runId: string;
  leaseEpoch: number;
  expiresAt: string;
  status: "pending" | "answered" | "consuming" | "consumed" | "expired";
  imageId?: string;
}
export const modelInputSchema = z
  .object({
    name: z.string().min(1).max(80),
    baseUrl: z.url().max(2000),
    protocol: z.enum(["chat", "responses"]).default("chat"),
    model: z.string().min(1).max(200),
    contextTokens: z.number().int().min(8192).max(200000).optional(),
    outputTokens: z.number().int().min(512).max(8192).optional(),
    apiKey: z.string().max(4000).optional(),
    inputPrice: z.number().nonnegative().nullable().default(null),
    outputPrice: z.number().nonnegative().nullable().default(null),
  })
  .strict().refine(v=>(v.contextTokens??16000)-(v.outputTokens??4096)>=4096,'上下文预算须比输出预留至少多4096');
export type ModelInput = z.infer<typeof modelInputSchema>;
export interface ModelCapabilities {
  connection: boolean;
  tools: boolean;
  structured: "schema" | "json" | "none";
  vision: boolean;
  visionTestedAt?: string;
  testedAt: string | null;
  tokenParameter?: "max_tokens" | "max_completion_tokens";
  error?: string;
}
export interface ModelProfile extends Omit<ModelInput, "apiKey"> {
  id: string;
  version: number;
  hasKey: boolean;
  capabilities: ModelCapabilities;
}
export interface SiteAccount {
  assignedDeviceId?: string | null;
  loginReset?: boolean;
  id: string;
  name: string;
  origin: string;
  usernameHint: string;
  createdAt: string;
}
export interface Device {
  id: string;
  name: string;
  lastSeen: string | null;
  revoked: boolean;
  protocolVersion: number;
}
export interface Snapshot {
  platformBudget?: {resetAt:string;limits:{model:number;turn:number;evidence:number};used:{model:number;turn:number;evidence:number}};
  me?: { id:string;email:string;role:"admin"|"user" };
  quota?: {resetAt:string;limits:{runs:number;scheduled:number;queued:number;chat:number;models:number};used:{runs:number;chat:number;models:number}};
  tasks: TaskDefinition[];
  runs: TaskRun[];
  models: ModelProfile[];
  accounts: SiteAccount[];
  devices: Device[];
  challenges: HumanChallenge[];
  serverTime: string;
}
export const browserActionSchema = z
  .object({
    kind: z.enum([
      "navigate",
      "observe",
      "click",
      "fill",
      "credential",
      "extract",
      "wait",
      "human",
      "finish",
    ]),
    instruction: z.string().max(4000),
    target: z.string().max(2000).nullable(),
    value: z.string().max(4000).nullable(),
    effect: z.enum(["read", "fill", "submit", "publish", "high_impact"]),
    challengeKind: z
      .enum(["code", "scan", "approval", "information", "unsupported"])
      .nullable(),
  })
  .strict()
  .refine((v) => v.kind !== "human" || !["code", "information", "scan"].includes(v.challengeKind ?? "information") || !!v.target?.trim(), {
    message: "CHALLENGE_TARGET_REQUIRED: human code/information/scan needs an exact target selector", path: ["target"],
  });
export type BrowserAction = z.infer<typeof browserActionSchema>;
export interface DesktopStatus {
  update: import('./updates').DesktopUpdateStatus;
  paired: boolean;
  cloudUrl: string;
  paused: boolean;
  online: boolean;
  activeRunId: string | null;
  version: string;
  autoStart: boolean;
  error: string | null;
}
export interface Transport {
  request<T>(method: string, path: string, body?: unknown): Promise<T>;
  subscribe?(fn:()=>void):()=>void;
  desktop?: {
    status(): Promise<DesktopStatus>;
    configure(url: string): Promise<{ url: string; code: string }>;
    pairPoll(): Promise<boolean>;
    pause(value: boolean): Promise<void>;
    autoStart(value: boolean): Promise<void>;
    stop(): Promise<void>;
    diagnostics(): Promise<string>;
    checkUpdate(): Promise<void>;
    downloadUpdate(version: string): Promise<void>;
    subscribe(fn: () => void): () => void;
  };
}
