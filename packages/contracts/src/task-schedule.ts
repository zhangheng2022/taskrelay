/** 定时卡片的用户配置；Cron 只在服务端生成，旧表达式保持只读兼容。 */
import { z } from "zod";
export const frequencySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("once"), at: z.iso.datetime(), timezone: z.string() }),
  z.object({ kind: z.literal("daily"), time: z.string(), timezone: z.string() }),
  z.object({
    kind: z.literal("weekly"),
    time: z.string(),
    timezone: z.string(),
    days: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  }),
  z.object({
    kind: z.literal("monthly"),
    time: z.string(),
    timezone: z.string(),
    day: z.number().int().min(1).max(31),
  }),
]);
export type Frequency = z.infer<typeof frequencySchema>;
/** 将表单的当地日期时间转换为 UTC；不存在的夏令时时刻拒绝保存。 */
export function localScheduleInstant(local: string, timezone: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!match) throw Error("SCHEDULE_TIME_INVALID");
  const [, year, month, day, hour, minute] = match.map(Number);
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const formatter = new Intl.DateTimeFormat("sv-SE", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  let instant = wall;
  for (let i = 0; i < 4; i++) {
    const shown = formatter.format(new Date(instant)).replace(" ", "T");
    if (shown === local) return new Date(instant).toISOString();
    instant += wall - Date.parse(shown + "Z");
  }
  throw Error("SCHEDULE_TIME_INVALID");
}
export interface ScheduleCard {
  version: number;
  taskVersion: number;
  summary: string;
  ready: boolean;
  state: "off" | "enabled" | "paused";
  frequency: Frequency | null;
  legacy: { expression: string; timezone: string } | null;
  nextRunAt: string | null;
}
export interface ExecutionLearning {
  runId: string;
  createdAt: string;
  accountId: string | null;
  accountName: string | null;
  state: string;
  summary: string | null;
  improvements: string | null;
  applied: boolean;
  incomplete: boolean;
  error: string | null;
}
