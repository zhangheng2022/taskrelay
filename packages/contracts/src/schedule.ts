import { CronExpressionParser } from "cron-parser";
import type { TaskInput } from "./index";
export function nextOccurrence(
  schedule: TaskInput["schedule"],
  after = new Date(),
): string | null {
  if (schedule.kind === "manual") return null;
  if (schedule.kind === "once")
    return new Date(schedule.at) > after ? schedule.at : null;
  return CronExpressionParser.parse(schedule.expression, {
    tz: schedule.timezone,
    currentDate: after,
  })
    .next()
    .toDate()
    .toISOString();
}
export function latestDue(
  schedule: TaskInput["schedule"],
  now: Date,
): string | null {
  if (schedule.kind === "manual") return null;
  if (schedule.kind === "once")
    return new Date(schedule.at) <= now ? schedule.at : null;
  return CronExpressionParser.parse(schedule.expression, {
    tz: schedule.timezone,
    currentDate: new Date(now.getTime() + 1),
  })
    .prev()
    .toDate()
    .toISOString();
}
