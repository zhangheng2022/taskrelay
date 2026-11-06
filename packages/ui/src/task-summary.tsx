import type { TaskInput } from "../../contracts/src/index";
import { formatDate } from "./feedback";
export function scheduleLabel(schedule: TaskInput["schedule"]) {
  if (schedule.kind === "manual") return "手动执行";
  if (schedule.kind === "once") return `${formatDate(schedule.at)} · 上海时间`;
  const m = /^(\d+) (\d+) \* \* ([*0-6])$/.exec(schedule.expression);
  if (m)
    return `${m[3] === "*" ? "每天" : "每周" + ["日", "一", "二", "三", "四", "五", "六"][Number(m[3])]} ${m[2].padStart(2, "0")}:${m[1].padStart(2, "0")} · ${schedule.timezone}`;
  return `${schedule.expression} · ${schedule.timezone}`;
}
export function TaskSummary({ task, accountName }: { task: TaskInput; accountName?: string }) {
  return (
    <dl className="grid grid-cols-[5rem_minmax(0,1fr)] gap-x-4 gap-y-3 text-sm">
      <dt className="text-muted-foreground">目标</dt>
      <dd className="break-words">{task.goal}</dd>
      <dt className="text-muted-foreground">网站</dt>
      <dd className="break-all">{task.entryUrl}</dd>
      <dt className="text-muted-foreground">账号</dt>
      <dd>{accountName ?? (task.accountId ? "已选择账号" : "不使用账号")}</dd>
      <dt className="text-muted-foreground">时间</dt>
      <dd>{scheduleLabel(task.schedule)}</dd>
      <dt className="text-muted-foreground">结果说明</dt>
      <dd className="break-words">AI 根据实际页面反馈说明本次结果、未完成项或受阻原因。</dd>
      {task.verification.kind === "batch" && (
        <>
          <dt className="text-muted-foreground">批量范围</dt>
          <dd className="break-words">{task.verification.scope}</dd>
          <dt className="text-muted-foreground">处理资格</dt>
          <dd className="break-words">{task.verification.eligibility}</dd>
          <dt className="text-muted-foreground">排除范围</dt>
          <dd className="break-words">{task.verification.exclusions.join("；") || "无"}</dd>
        </>
      )}
    </dl>
  );
}
