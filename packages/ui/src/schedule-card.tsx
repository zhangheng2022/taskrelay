/** 会话定时卡片：服务端预览与版本化保存；编辑草稿不随后台刷新覆盖。 */
import { useId, useRef, useState } from "react";
import { CalendarClock } from "lucide-react";
import type { Transport } from "../../contracts/src/index";
import {
  localScheduleInstant,
  type Frequency,
  type ScheduleCard as CardData,
  type ExecutionLearning,
} from "../../contracts/src/task-schedule";
import { useTransportQuery } from "./queries";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { NativeSelect, NativeSelectOption } from "./components/ui/native-select";
import { Field, FieldGroup, FieldLabel, FieldDescription } from "./components/ui/field";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "./components/ui/sheet";
import { useIsMobile } from "./hooks/use-mobile";
import { ErrorText } from "./feedback";

const stateLabels = { off: "未开启", enabled: "已开启", paused: "已暂停" };
const weekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
function frequencyLabel(card: CardData) {
  const f = card.frequency;
  if (!f) return card.legacy ? `原有频率 · ${card.legacy.expression}` : "设置执行频率";
  if (f.kind === "once") return "执行一次";
  return `${f.kind === "daily" ? "每天" : f.kind === "weekly" ? f.days.map((d) => weekdays[d]).join("、") : `每月 ${f.day} 日`} ${f.time}`;
}
function displayTime(at: string, zone: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: zone,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(at));
}
export function ScheduleCard({
  transport,
  taskId,
  offline,
}: {
  transport: Transport;
  taskId: string;
  offline: boolean;
}) {
  const [open, setOpen] = useState(false);
  const query = useTransportQuery(
    transport,
    ["schedule", taskId],
    (signal) =>
      transport.request<{ card: CardData | null; learning: ExecutionLearning[] }>(
        "GET",
        `/api/user/tasks/${taskId}/schedule`,
        undefined,
        { signal },
      ),
    5000,
  );
  const learningQuery = useTransportQuery(
    transport,
    ["schedule-learning", taskId],
    (signal) =>
      transport.request<{ learning: ExecutionLearning[] }>(
        "GET",
        `/api/user/tasks/${taskId}/schedule?learning=1`,
        undefined,
        { signal },
      ),
    5000,
    open,
  );
  const mobile = useIsMobile(),
    card = query.data?.card;
  if (!card) return null;
  const zone = card.frequency?.timezone ?? card.legacy?.timezone ?? "Asia/Shanghai";
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        aria-label={`定时任务：${stateLabels[card.state]}`}
      >
        <CalendarClock data-icon="inline-start" />
        <span>{stateLabels[card.state]}</span>
        <span className="hidden max-w-48 truncate lg:inline">{frequencyLabel(card)}</span>
        {card.nextRunAt && (
          <span className="hidden xl:inline">下次 {displayTime(card.nextRunAt, zone)}</span>
        )}
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side={mobile ? "bottom" : "right"}
          className="max-h-[90dvh] overflow-y-auto md:max-h-none md:w-full md:max-w-md"
        >
          <SheetHeader>
            <SheetTitle>定时任务</SheetTitle>
            <SheetDescription>{card.summary}</SheetDescription>
          </SheetHeader>
          {open && (
            <ScheduleEditor
              key={taskId}
              card={card}
              learning={learningQuery.data?.learning ?? []}
              transport={transport}
              taskId={taskId}
              offline={offline}
              refresh={query.refresh}
            />
          )}
          {query.error && <ErrorText error={query.error.message} />}
          {learningQuery.error && <ErrorText error={learningQuery.error.message} />}
        </SheetContent>
      </Sheet>
    </>
  );
}
function ScheduleEditor({
  card,
  learning,
  transport,
  taskId,
  offline,
  refresh,
}: {
  card: CardData;
  learning: ExecutionLearning[];
  transport: Transport;
  taskId: string;
  offline: boolean;
  refresh: () => Promise<void>;
}) {
  const [older, setOlder] = useState<ExecutionLearning[]>([]),
    [more, setMore] = useState(true),
    [loadingOlder, setLoadingOlder] = useState(false);
  const combined = [
    ...learning,
    ...older.filter((item) => !learning.some((recent) => recent.runId === item.runId)),
  ];
  async function loadOlder() {
    setLoadingOlder(true);
    try {
      const data = await transport.request<{ learning: ExecutionLearning[] }>(
        "GET",
        `/api/user/tasks/${taskId}/schedule?learning=1&learningBefore=${encodeURIComponent(combined.at(-1)!.runId)}`,
      );
      setOlder([...older, ...data.learning]);
      setMore(data.learning.length === 50);
    } catch (e) {
      setError(e);
    } finally {
      setLoadingOlder(false);
    }
  }
  const initial = card.frequency;
  const [kind, setKind] = useState<Frequency["kind"]>(initial?.kind ?? "daily");
  const [time, setTime] = useState(initial && "time" in initial ? initial.time : "09:00");
  const [zone, setZone] = useState(initial?.timezone ?? card.legacy?.timezone ?? "Asia/Shanghai");
  const [date, setDate] = useState(
    initial?.kind === "once"
      ? new Intl.DateTimeFormat("sv-SE", {
          timeZone: initial.timezone,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          hourCycle: "h23",
        })
          .format(new Date(initial.at))
          .replace(" ", "T")
      : "",
  );
  const [days, setDays] = useState(initial?.kind === "weekly" ? initial.days : [1]);
  const [day, setDay] = useState(initial?.kind === "monthly" ? initial.day : 1);
  const [replaceLegacy, setReplaceLegacy] = useState(false),
    [times, setTimes] = useState<string[] | null>(null),
    [error, setError] = useState<unknown>(),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState("");
  const [version, setVersion] = useState(card.version);
  const [taskVersion] = useState(card.taskVersion);
  const attempt = useRef<{ digest: string; requestId: string } | null>(null),
    id = useId();
  const legacy = !!card.legacy && !replaceLegacy;
  const invalidated = version !== card.version || taskVersion !== card.taskVersion;
  const value = (): Frequency =>
    kind === "once"
      ? { kind, at: localScheduleInstant(date, zone), timezone: zone }
      : kind === "weekly"
        ? { kind, time, timezone: zone, days }
        : kind === "monthly"
          ? { kind, time, timezone: zone, day }
          : { kind, time, timezone: zone };
  const dirty = () => {
    setTimes(null);
    setNotice("");
  };
  async function preview() {
    setBusy(true);
    setError(undefined);
    try {
      const data = await transport.request<{ times: string[] }>(
        "POST",
        `/api/user/tasks/${taskId}/schedule/preview`,
        value(),
      );
      setTimes(data.times);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  async function save(enabled: boolean) {
    setBusy(true);
    setError(undefined);
    setNotice("");
    try {
      const body = {
          expectedVersion: version,
          expectedTaskVersion: taskVersion,
          enabled,
          ...(enabled && !legacy ? { frequency: value() } : {}),
        },
        digest = JSON.stringify(body);
      if (attempt.current?.digest !== digest)
        attempt.current = { digest, requestId: crypto.randomUUID() };
      const data = await transport.request<{ card: CardData }>(
        "POST",
        `/api/user/tasks/${taskId}/schedule`,
        { ...body, requestId: attempt.current.requestId },
      );
      setVersion(data.card.version);
      setNotice(enabled ? "已保存并启用" : "已暂停，当前运行不受影响");
      attempt.current = null;
      await refresh().catch(() => setNotice("已保存，状态刷新失败，请重新打开查看"));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex flex-col gap-6 px-4 pb-6">
      <div className="flex flex-col gap-1 text-sm">
        <p>
          {stateLabels[card.state]}
          {!card.ready ? " · 等待执行器重新理解需求" : ""}
        </p>
        {card.nextRunAt && (
          <p className="text-muted-foreground">
            下次执行：
            {displayTime(card.nextRunAt, card.frequency?.timezone ?? card.legacy?.timezone ?? zone)}
          </p>
        )}
      </div>
      {legacy ? (
        <div className="flex flex-col gap-3">
          <p className="text-sm">
            原有频率：{card.legacy!.expression}（{zone}）
          </p>
          <Button variant="outline" onClick={() => setReplaceLegacy(true)}>
            改用常用频率
          </Button>
        </div>
      ) : (
        <fieldset disabled={busy || offline}>
          <FieldGroup onChange={dirty}>
            <Field>
              <FieldLabel htmlFor={`${id}-kind`}>执行频率</FieldLabel>
              <NativeSelect
                id={`${id}-kind`}
                value={kind}
                onChange={(e) => {
                  setKind(e.target.value as Frequency["kind"]);
                  dirty();
                }}
              >
                <NativeSelectOption value="once">指定时间执行一次</NativeSelectOption>
                <NativeSelectOption value="daily">每天</NativeSelectOption>
                <NativeSelectOption value="weekly">每周</NativeSelectOption>
                <NativeSelectOption value="monthly">每月</NativeSelectOption>
              </NativeSelect>
            </Field>
            {kind === "weekly" && (
              <Field>
                <FieldLabel>执行日期</FieldLabel>
                <div className="flex flex-wrap gap-2">
                  {weekdays.map((name, index) => (
                    <Button
                      key={name}
                      type="button"
                      variant={days.includes(index) ? "default" : "outline"}
                      size="sm"
                      aria-pressed={days.includes(index)}
                      onClick={() => {
                        setDays(
                          days.includes(index) ? days.filter((d) => d !== index) : [...days, index],
                        );
                        dirty();
                      }}
                    >
                      {name}
                    </Button>
                  ))}
                </div>
              </Field>
            )}
            {kind === "monthly" && (
              <Field>
                <FieldLabel htmlFor={`${id}-day`}>每月几日</FieldLabel>
                <Input
                  id={`${id}-day`}
                  type="number"
                  min={1}
                  max={31}
                  value={day}
                  onChange={(e) => setDay(Number(e.target.value))}
                />
                <FieldDescription>选择 29—31 日时，没有该日期的月份将跳过。</FieldDescription>
              </Field>
            )}
            <Field>
              <FieldLabel htmlFor={`${id}-time`}>
                {kind === "once" ? "执行日期与时间" : "执行时间"}
              </FieldLabel>
              <Input
                id={`${id}-time`}
                type={kind === "once" ? "datetime-local" : "time"}
                value={kind === "once" ? date : time}
                onChange={(e) =>
                  kind === "once" ? setDate(e.target.value) : setTime(e.target.value)
                }
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${id}-zone`}>时区</FieldLabel>
              <Input
                id={`${id}-zone`}
                value={zone}
                onChange={(e) => setZone(e.target.value)}
                placeholder="Asia/Shanghai"
              />
              <FieldDescription>默认北京时间。夏令时不存在的时间请另选。</FieldDescription>
            </Field>
            <Button variant="outline" disabled={busy || offline} onClick={() => void preview()}>
              预览执行时间
            </Button>
            {times && (
              <div role="status" className="text-sm">
                <p>接下来将执行：</p>
                {times.length ? (
                  <ol className="list-inside list-decimal">
                    {times.map((at) => (
                      <li key={at}>{displayTime(at, zone)}</li>
                    ))}
                  </ol>
                ) : (
                  <p>没有未来的执行时间，请调整设置。</p>
                )}
              </div>
            )}
          </FieldGroup>
        </fieldset>
      )}
      {invalidated && (
        <p role="alert" className="text-sm">
          任务设置已变化，请关闭后重新打开，核对最新内容。
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={busy || offline || !card.ready || invalidated || (!legacy && !times?.length)}
          onClick={() => void save(true)}
        >
          {busy ? "正在处理…" : "保存并启用"}
        </Button>
        {card.state === "enabled" && (
          <Button
            variant="outline"
            disabled={busy || offline || invalidated}
            onClick={() => void save(false)}
          >
            暂停定时
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        首次任务照常执行。定时到点后进入队列，执行器可用时开始。
      </p>
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
      {error !== undefined && (
        <ErrorText error={error instanceof Error ? error.message : "保存失败，请重试"} />
      )}
      <details>
        <summary className="cursor-pointer text-sm font-medium">
          执行总结与流程优化（{combined.length}）
        </summary>
        <div className="mt-3 flex flex-col gap-4">
          {!combined.length && (
            <p className="text-sm text-muted-foreground">每次执行结束后自动总结，供下一次参考。</p>
          )}
          {combined.map((item) => (
            <article key={item.runId} className="flex flex-col gap-2 border-t pt-3 text-sm">
              <p className="text-muted-foreground">{displayTime(item.createdAt, zone)}</p>
              <p>
                {item.state === "done"
                  ? item.applied
                    ? "后续执行将使用"
                    : "历史总结"
                  : item.state === "failed"
                    ? "总结失败，保留上一版经验"
                    : "正在总结"}
                {item.accountName ? ` · ${item.accountName}` : ""}
              </p>
              {item.incomplete && (
                <p className="text-muted-foreground">记录可能不完整，未知操作不会自动重放。</p>
              )}
              <p className="whitespace-pre-wrap break-words">{item.summary}</p>
              {item.improvements && (
                <>
                  <p className="font-medium">下次改进</p>
                  <p className="whitespace-pre-wrap break-words">{item.improvements}</p>
                </>
              )}
            </article>
          ))}
          {learning.length === 50 && more && (
            <Button
              variant="outline"
              disabled={loadingOlder || offline}
              onClick={() => void loadOlder()}
            >
              {loadingOlder ? "正在加载…" : "加载更早总结"}
            </Button>
          )}
        </div>
      </details>
    </div>
  );
}
