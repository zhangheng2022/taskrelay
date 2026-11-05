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
export function TaskSummary({
  task,
  accountName,
}: {
  task: TaskInput;
  accountName?: string;
}) {
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
      <dt className="text-muted-foreground">允许操作</dt>
      <dd>
        {task.allowedActions
          .map(
            (x) =>
              ({
                read: "读取",
                navigate: "导航",
                fill: "填写",
                submit: "提交",
                publish: "发布",
              })[x],
          )
          .join("、")}
      </dd>
      <dt className="text-muted-foreground">完成标准</dt>
      <dd className="break-words">
        {
          {
            goal: "AI 根据页面证据核验业务目标",
            batch: "逐项核验全部范围内项目",
          }[task.verification.kind]
        }
        ：{task.verification.value}
      </dd>
      {task.verification.kind==='batch'&&<>
        <dt className="text-muted-foreground">批量范围</dt><dd className="break-words">{task.verification.scope}</dd>
        <dt className="text-muted-foreground">处理资格</dt><dd className="break-words">{task.verification.eligibility}</dd>
        <dt className="text-muted-foreground">排除范围</dt><dd className="break-words">{task.verification.exclusions.join('；')||'无'}</dd>
        <dt className="text-muted-foreground">核验方式</dt><dd>AI 根据实际页面规划、逐项采证并判断范围覆盖；总数未知时如实说明。证据不足或达到限额时报告实际进度与未核实部分。</dd>
      </>}
    </dl>
  );
}
