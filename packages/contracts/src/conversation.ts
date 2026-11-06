/** 聊天快照协议：两类历史各有游标，写入确认仍由 requestId 与会话版本负责。 */
import type { TaskInput } from "./index";
export type ThreadPage = {
  id: string;
  version: number;
  modelId: string;
  taskId?: string | null;
  queued?: { id: string; content: string; at: string }[];
  conditions?: {
    run_id: string;
    task_version: number;
    instruction_version: number;
    content: string;
    confirmed_content: string | null;
    confirmed_at: string | null;
    approved_version: number | null;
    current_version: number;
  } | null;
  draft: TaskInput | null;
  partial: { facts?: string; missing?: string[] };
  activeTurn: string | null;
  latestTurn?: { id?: string; status: string; error?: string | null } | null;
  waiting?: { id: string; request: string } | null;
  messages: {
    id: string;
    seq: number;
    role: string;
    content: string;
    at: string;
    private?: boolean;
    source?: string;
    reply_to?: string | null;
    run_id?: string | null;
    parts?: import("./execution").ChatPart[];
  }[];
  nextCursor: number | null;
  replies?: {
    id: string;
    cursor: number;
    role: string;
    content: string;
    at: string;
    status: string;
  }[];
  nextReplyCursor?: number | null;
};
