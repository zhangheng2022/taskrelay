import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  ArrowRight,
  CheckCircle2,
  Clock3,
  Layers3,
  ListTodo,
  Loader2,
  MessageSquare,
  Monitor,
  Pause,
  Play,
  Plus,
  Settings as SettingsIcon,
  WifiOff,
} from "lucide-react";
import type {
  Snapshot,
  TaskDefinition,
  TaskRun,
  Transport,
} from "../../contracts/src/index";
import { Button } from "./components/ui/button";
import { Badge } from "./components/ui/badge";
import { TaskEditor } from "./task-editor";
import { Settings } from "./settings";
import { Conversation } from "./conversation";
import "./styles.css";
export const labels: Record<string, string> = {
  pending_validation: "待试运行",
  active: "已启用",
  paused: "已暂停",
  needs_input: "待补充",
  queued: "等待设备",
  running: "正在执行",
  waiting_user: "需要协助",
  verifying: "正在核验",
  succeeded: "已完成",
  failed: "执行失败",
  unknown: "结果待核查",
  cancelled: "已取消",
  expired: "已过期",
};
export function formatDate(value: string | null | undefined) {
  return value
    ? new Intl.DateTimeFormat("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: "Asia/Shanghai",
      }).format(new Date(value))
    : "—";
}
export function Status({ value }: { value: string }) {
  return (
    <Badge variant="outline" className={`status status-${value}`}>
      <span className="status-dot" />
      {labels[value] ?? value}
    </Badge>
  );
}
export function ErrorText({ error }: { error: string }) {
  const friendly: Record<string, string> = {
    MODEL_HTTP_403_UNSUPPORTED_REGION:
      "请求被模型服务判定来自不支持的地区。请使用支持当前使用地区的兼容服务，或联系服务商确认可用性。",
    MODEL_HTTP_403_PERMISSION:
      "模型服务拒绝访问。请检查 API Key 所属项目和模型权限。",
    MODEL_HTTP_403_ORGANIZATION_RESTRICTED:
      "模型服务限制了当前组织，请检查服务商控制台。",
    MODEL_HTTP_403_ACCOUNT_RESTRICTED: "模型服务限制了当前账号，请联系服务商。",
    MODEL_HTTP_403_GATEWAY_DENIED:
      "模型服务网关拒绝了请求，请检查接口地址及服务商访问策略。",
    MODEL_HTTP_403: "模型服务返回 403，请检查服务商地区支持、账号及模型权限。",
    MODEL_HTTP_401_INVALID_KEY: "API Key 未通过服务商验证，请重新检查密钥。",
    MODEL_HTTP_404_MODEL_UNAVAILABLE:
      "模型不存在或当前项目无访问权限，请填写服务商 API 实际提供的模型名称。",
    MODEL_HTTP_429_QUOTA: "模型服务额度不足，请检查服务商账户的额度。",
    MODEL_DNS_FAILED: "无法校验模型服务地址，请检查域名或稍后重试。",
    MODEL_PROTOCOL_MISMATCH:
      "接口路径与所选协议不一致，请使用对应的 Base URL。",
    MODEL_BASE_URL_INVALID: "Base URL 不能包含查询参数或片段。",
    MODEL_REDIRECT_BLOCKED: "模型服务返回了重定向，请填写最终 HTTPS 接口地址。",
    ACCESS_REQUIRED: "请通过 Cloudflare Access 登录后刷新页面。",
    DEVICE_UNAUTHORIZED: "设备授权已失效，请重新连接。",
    MODEL_CAPABILITIES_REQUIRED: "模型尚未通过能力测试，请到设置中测试。",
    TRIAL_REQUIRED: "请先完成一次成功的试运行，再启用调度。",
    CHALLENGE_STALE: "这条协助请求已过期或已回复，请刷新当前任务。",
    EXPLICIT_APPROVAL_REQUIRED: "请核对具体操作，再输入“确认执行”。",
    CHALLENGE_UNSUPPORTED: "此验证无法通过当前对话通道完成。",
    OFFLINE: "暂时无法连接云端。已保留缓存，连接恢复后自动刷新。",
    MODEL_INVALID_JSON: "模型返回的格式不正确，请检查模型配置后重试。",
  };
  return (
    <div role="alert" className="error-message">
      {friendly[error] ?? `操作未完成：${error}。请检查配置后重试。`}
    </div>
  );
}
export function App({ transport }: { transport: Transport }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [page, setPage] = useState<"tasks" | "runs" | "settings">("tasks"),
    [selected, setSelected] = useState<string | null>(null),
    [runId, setRunId] = useState<string | null>(null),
    [editor, setEditor] = useState<TaskDefinition | true | null>(null);
  const [assistanceJump, setAssistanceJump] = useState(0);
  const [pair, setPair] = useState<{
    name: string;
    code: string;
    approved: boolean;
  } | null>(null);
  const load = useCallback(async () => {
    try {
      setSnapshot(
        await transport.request<Snapshot>("GET", "/api/user/snapshot"),
      );
      const device = await transport.desktop?.status();
      setError(device?.paired && !device.online ? "OFFLINE" : "");
    } catch (e) {
      setError((e as Error).message || "OFFLINE");
    }
  }, [transport]);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [load]);
  useEffect(() => {
    const code = new URLSearchParams(location.search).get("pair");
    if (code)
      void transport
        .request<typeof pair>(
          "GET",
          `/api/user/pairings/${encodeURIComponent(code)}`,
        )
        .then(setPair)
        .catch((e) => setError(e.message));
  }, [transport]);
  const act = async (method: string, path: string, body?: unknown) => {
    setBusy(true);
    try {
      await transport.request(method, path, body);
      await load();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const task = snapshot?.tasks.find((t) => t.id === selected) ?? null;
  const selectedRun =
    snapshot?.runs.find((r) => r.id === runId) ??
    (task ? snapshot?.runs.find((r) => r.taskId === task.id) : null) ??
    null;
  const pending =
    snapshot?.challenges.filter((c) => c.status === "pending") ?? [];
  return (
    <div className="app-shell">
      <aside className="navigation">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setPage("tasks");
          }}
        >
          <span className="brand-symbol">
            <Layers3 size={22} />
          </span>
          <strong>TaskRelay</strong>
        </a>
        <nav aria-label="主导航">
          {(
            [
              { id: "tasks", label: "任务", icon: ListTodo },
              { id: "runs", label: "运行记录", icon: Activity },
              { id: "settings", label: "设置", icon: SettingsIcon },
            ] as const
          ).map((item) => (
            <button
              key={item.id}
              aria-label={item.label}
              aria-current={page === item.id ? "page" : undefined}
              onClick={() => setPage(item.id)}
            >
              <item.icon size={19} />
              <span>{item.label}</span>
              {item.id === "tasks" && pending.length > 0 && (
                <span className="nav-count">{pending.length}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="nav-footer">
          <span className={`connection-dot ${error ? "disconnected" : ""}`} />
          <span>{error ? "连接中断" : "云端统一调度"}</span>
          <small>个人工作空间</small>
        </div>
      </aside>
      <main className="workspace">
        <header className="page-header">
          <div>
            <h1>
              {page === "tasks"
                ? "把重复的事，交给任务。"
                : page === "runs"
                  ? "每次执行，都有迹可循。"
                  : "你的任务环境"}
            </h1>
            <p>
              {page === "tasks"
                ? "描述目标，确认范围。需要你时，在这里接力。"
                : page === "runs"
                  ? "查看执行步骤、实际结果和需要核查的操作。"
                  : "模型服务、站点账号与执行设备，由你管理。"}
            </p>
          </div>
          {page === "tasks" && (
            <Button
              onClick={() => setEditor(true)}
              disabled={!snapshot || !!error}
            >
              <Plus />
              新建任务
            </Button>
          )}
        </header>
        {error && (
          <div className="connection-banner">
            <WifiOff size={18} />
            <ErrorText error={error} />
            <Button variant="ghost" size="sm" onClick={() => void load()}>
              重试
            </Button>
          </div>
        )}
        {pair && (
          <section className="pair-banner">
            <Monitor />
            <div>
              <h2>{pair.approved ? "设备已授权" : "授权连接这台设备"}</h2>
              <p>
                {pair.name} · 校验码 <code>{pair.code}</code>
              </p>
              <p>请与桌面客户端显示的校验码核对一致。</p>
            </div>
            <Button
              disabled={busy || !!pair.approved}
              onClick={() =>
                void act(
                  "POST",
                  `/api/user/pairings/${pair.code}/approve`,
                ).then((ok) => {
                  if (ok) setPair({ ...pair, approved: true });
                })
              }
            >
              {pair.approved ? "已授权" : "授权设备"}
            </Button>
          </section>
        )}
        {!snapshot ? (
          <div className="loading-state" role="status">
            <Loader2 className="spin" />
            正在连接工作空间…
          </div>
        ) : page === "settings" ? (
          <Settings transport={transport} snapshot={snapshot} refresh={load} />
        ) : (
          <>
            {pending.length > 0 && (
              <button
                className="assistance-banner"
                onClick={() => {
                  const r = snapshot.runs.find(
                    (r) => r.id === pending[0].runId,
                  );
                  if (r) {
                    setSelected(r.taskId);
                    setRunId(r.id);
                    setPage("tasks");
                    setAssistanceJump((v) => v + 1);
                  }
                }}
              >
                <MessageSquare size={20} />
                <span>
                  <strong>{pending.length} 个任务正在等你</strong>
                  <small>在任务对话中补充信息，完成后继续执行</small>
                </span>
                <ArrowRight size={20} />
              </button>
            )}
            {page === "tasks" && snapshot.tasks.length === 0 ? (
              <section className="welcome">
                <div className="welcome-mark">
                  <Layers3 size={42} />
                </div>
                <h2>从一件重复的小事开始</h2>
                <p>
                  查询信息、监测变化、登录签到或填写表单。
                  <br />
                  任务在你的 Windows 设备上执行，结果回到这里。
                </p>
                <div className="setup-list">
                  <button onClick={() => setPage("settings")}>
                    <span
                      className={
                        snapshot.models.some((m) => m.capabilities.tools)
                          ? "done"
                          : ""
                      }
                    >
                      {snapshot.models.some((m) => m.capabilities.tools) ? (
                        <CheckCircle2 size={18} />
                      ) : (
                        1
                      )}
                    </span>
                    <div>
                      <strong>连接一个模型</strong>
                      <small>支持 OpenAI、DeepSeek、百炼及兼容服务</small>
                    </div>
                    <ArrowRight size={18} />
                  </button>
                  <button onClick={() => setPage("settings")}>
                    <span
                      className={
                        snapshot.devices.some((d) => !d.revoked) ? "done" : ""
                      }
                    >
                      {snapshot.devices.some((d) => !d.revoked) ? (
                        <CheckCircle2 size={18} />
                      ) : (
                        2
                      )}
                    </span>
                    <div>
                      <strong>连接 Windows 执行器</strong>
                      <small>浏览器和账号环境保留在本机</small>
                    </div>
                    <ArrowRight size={18} />
                  </button>
                  <button onClick={() => setEditor(true)}>
                    <span>3</span>
                    <div>
                      <strong>创建任务并试运行</strong>
                      <small>核验成功后，再开始周期调度</small>
                    </div>
                    <ArrowRight size={18} />
                  </button>
                </div>
                <Button
                  size="lg"
                  disabled={!!error}
                  onClick={() => setEditor(true)}
                >
                  创建第一个任务
                  <ArrowRight />
                </Button>
              </section>
            ) : page === "tasks" ? (
              <div className={`task-layout ${task ? "has-selection" : ""}`}>
                <section className="task-list" aria-label="任务列表">
                  <div className="list-heading">
                    <h2>
                      全部任务 <span>{snapshot.tasks.length}</span>
                    </h2>
                    <span>上海时间</span>
                  </div>
                  {snapshot.tasks.map((t) => {
                    const latest = snapshot.runs.find((r) => r.taskId === t.id);
                    return (
                      <button
                        className={`task-row ${task?.id === t.id ? "selected" : ""}`}
                        key={t.id}
                        onClick={() => {
                          setSelected(t.id);
                          setRunId(null);
                        }}
                      >
                        <div className="task-row-top">
                          <strong>{t.title}</strong>
                          <Status
                            value={
                              latest &&
                              ![
                                "succeeded",
                                "failed",
                                "cancelled",
                                "expired",
                              ].includes(latest.status)
                                ? latest.status
                                : t.status
                            }
                          />
                        </div>
                        <p>{t.goal}</p>
                        <div className="task-meta">
                          <span>{new URL(t.entryUrl).hostname}</span>
                          <span>
                            <Clock3 size={13} />
                            {t.nextRunAt
                              ? formatDate(t.nextRunAt)
                              : t.schedule.kind === "manual"
                                ? "手动运行"
                                : "待试运行"}
                          </span>
                        </div>
                      </button>
                    );
                  })}
                </section>
                <section className="detail-pane">
                  {task ? (
                    <>
                      <div className="detail-header">
                        <div>
                          <button
                            className="back-link"
                            onClick={() => setSelected(null)}
                          >
                            返回任务列表
                          </button>
                          <h2>{task.title}</h2>
                          <p>
                            {new URL(task.entryUrl).hostname} · v{task.version}
                          </p>
                        </div>
                        <div className="detail-actions">
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={busy || !!error}
                            onClick={() => setEditor(task)}
                          >
                            编辑
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={busy || !!error}
                            onClick={() =>
                              void act(
                                "POST",
                                `/api/user/tasks/${task.id}/state`,
                                { enabled: task.status !== "active" },
                              )
                            }
                          >
                            {task.status === "active" ? <Pause /> : <Play />}
                            {task.status === "active" ? "暂停" : "启用"}
                          </Button>
                          <Button
                            size="sm"
                            disabled={busy || !!error}
                            onClick={() =>
                              void act(
                                "POST",
                                `/api/user/tasks/${task.id}/run`,
                                { requestId: crypto.randomUUID() },
                              )
                            }
                          >
                            <Play />
                            立即运行
                          </Button>
                        </div>
                      </div>
                      <Conversation
                        assistanceJump={assistanceJump}
                        transport={transport}
                        task={task}
                        run={selectedRun}
                        challenges={snapshot.challenges.filter(
                          (c) => c.runId === selectedRun?.id,
                        )}
                        refresh={load}
                      />
                    </>
                  ) : (
                    <div className="empty-detail">
                      <MessageSquare size={30} />
                      <h2>选择一个任务</h2>
                      <p>查看任务对话、最近结果或回复协助请求。</p>
                    </div>
                  )}
                </section>
              </div>
            ) : (
              <section className="runs-view">
                {snapshot.runs.length === 0 ? (
                  <div className="empty-detail">
                    <Activity size={32} />
                    <h2>还没有运行记录</h2>
                    <p>任务开始执行后，步骤和结果会出现在这里。</p>
                  </div>
                ) : (
                  <>
                    <div className="run-table">
                      <div className="run-table-head">
                        <span>任务</span>
                        <span>状态</span>
                        <span>执行时间</span>
                        <span>结果</span>
                      </div>
                      {snapshot.runs.map((r) => (
                        <button
                          className="run-table-row"
                          key={r.id}
                          onClick={() => {
                            setSelected(r.taskId);
                            setRunId(r.id);
                            setPage("tasks");
                          }}
                        >
                          <strong>{r.task.title}</strong>
                          <Status value={r.status} />
                          <time>{formatDate(r.createdAt)}</time>
                          <span>{r.result?.summary ?? "等待执行结果"}</span>
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </section>
            )}
          </>
        )}
      </main>
      {editor && snapshot && (
        <TaskEditor
          task={editor === true ? null : editor}
          snapshot={snapshot}
          transport={transport}
          onClose={() => setEditor(null)}
          onSaved={async (id) => {
            setEditor(null);
            setSelected(id);
            setPage("tasks");
            await load();
          }}
        />
      )}
    </div>
  );
}
