import { ModelDialog } from "./model-dialog";
import { QueryBoundary, useTransportQuery } from "./queries";
import { createApi, rpcData } from "./api";
import { Memories } from "./memories";
import { Accounts } from "./accounts";
import { AdminPanel } from "./admin-panel";
import { AccountSecurity } from "./auth-gate";
import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Loader2, Plus } from "lucide-react";
import type { ModelProfile, Snapshot, Transport } from "../../contracts/src/index";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./components/ui/tabs";
import { FieldGroup } from "./components/ui/field";
import { Badge } from "./components/ui/badge";
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
  EmptyContent,
} from "./components/ui/empty";
import { Field } from "./form-field";
import { ErrorText, formatDate } from "./feedback";
export function Settings({
  transport,
  snapshot,
  refresh,
}: {
  transport: Transport;
  snapshot: Snapshot;
  refresh: () => Promise<void>;
}) {
  return (
    <QueryBoundary owner={transport}>
      <SettingsContent transport={transport} snapshot={snapshot} refresh={refresh} />
    </QueryBoundary>
  );
}
function SettingsContent({
  transport,
  snapshot,
  refresh,
}: {
  transport: Transport;
  snapshot: Snapshot;
  refresh: () => Promise<void>;
}) {
  const isAdmin = snapshot.me?.role === "admin";
  const config = useTransportQuery(
    transport,
    ["admin-settings"],
    (signal) => rpcData(createApi(transport).api.admin.settings.$get({}, { init: { signal } })),
    60000,
    isAdmin,
  );
  const daysDirty = useRef(false);
  const [tab, setTab] = useState(isAdmin ? "models" : "accounts"),
    [model, setModel] = useState<ModelProfile | true | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(""),
    [days, setDays] = useState(30);
  const act = async (id: string, fn: () => Promise<unknown>) => {
    setBusy(id);
    setError("");
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  useEffect(() => {
    if (config.data && !daysDirty.current) setDays(config.data.retentionDays);
  }, [config.data]);
  return (
    <Tabs className="settings" value={tab} onValueChange={setTab}>
      <TabsList className="w-full flex-wrap group-data-[orientation=horizontal]/tabs:h-auto">
        {[
          ["accounts", "站点账号"],
          ["security", "登录安全"],
          ["memories", "我的记忆"],
          ...(isAdmin
            ? [
                ["models", "模型服务"],
                ["devices", "设备"],
                ["data", "数据保留"],
                ["admin", "用户与配额"],
              ]
            : []),
        ].map(([id, label]) => (
          <TabsTrigger key={id} value={id} className="h-auto min-h-8">
            {label}
          </TabsTrigger>
        ))}
      </TabsList>
      {error && <ErrorText error={error} />}
      <TabsContent value={tab} className="settings-content">
        {tab === "memories" ? (
          <Memories transport={transport} />
        ) : tab === "admin" ? (
          <AdminPanel transport={transport} />
        ) : tab === "security" ? (
          <AccountSecurity />
        ) : tab === "models" ? (
          <>
            <div className="section-heading">
              <div>
                <h2>选择适合你的模型</h2>
                <p>手动填写模型名称。通过能力测试后，才能用于任务。</p>
              </div>
              <Button onClick={() => setModel(true)}>
                <Plus />
                添加模型
              </Button>
            </div>
            {!snapshot.models.length ? (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>先连接一个模型服务</EmptyTitle>
                  <EmptyDescription>
                    支持 Chat Completions 和 Responses。API Key 加密保存在云端。
                  </EmptyDescription>
                </EmptyHeader>
                <EmptyContent>
                  <Button variant="outline" onClick={() => setModel(true)}>
                    配置模型
                  </Button>
                </EmptyContent>
              </Empty>
            ) : (
              snapshot.models.map((m) => (
                <article className="settings-row" key={m.id}>
                  <div>
                    <h3>
                      {m.name}
                      <small>v{m.version}</small>
                    </h3>
                    <p>
                      {m.model} · {m.protocol === "chat" ? "Chat Completions" : "Responses"}
                    </p>
                    <div className="capabilities mt-3">
                      <Badge variant="secondary">
                        连接 {m.capabilities.connection ? "通过" : "未通过"}
                      </Badge>
                      <Badge variant="secondary">
                        工具调用 {m.capabilities.tools ? "通过" : "未通过"}
                      </Badge>
                      <Badge variant="secondary">
                        结构化输出{" "}
                        {m.capabilities.structured === "none"
                          ? "未通过"
                          : m.capabilities.structured}
                      </Badge>
                      <Badge variant="secondary">
                        图像输入{" "}
                        {m.capabilities.visionTestedAt
                          ? m.capabilities.vision
                            ? "通过"
                            : "未通过"
                          : "未验证"}
                      </Badge>
                    </div>
                    {m.capabilities.error && <ErrorText error={m.capabilities.error} />}
                  </div>
                  <div className="row-actions">
                    <Button variant="outline" disabled={!!busy} onClick={() => setModel(m)}>
                      编辑
                    </Button>
                    <Button
                      variant="outline"
                      disabled={!!busy}
                      onClick={() =>
                        void act(m.id, () =>
                          createApi(transport).api.admin.models[":id"].test.$post({
                            param: { id: m.id },
                          }),
                        )
                      }
                    >
                      {busy === m.id ? <Loader2 className="spin" /> : <CheckCircle2 />}
                      测试能力
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={!!busy || !m.capabilities.connection}
                      onClick={() =>
                        void act(m.id + "vision", () =>
                          createApi(transport).api.admin.models[":id"].vision.$post({
                            param: { id: m.id },
                          }),
                        )
                      }
                    >
                      测试图像（可选）
                    </Button>
                  </div>
                </article>
              ))
            )}
          </>
        ) : tab === "accounts" ? (
          <Accounts snapshot={snapshot} transport={transport} refresh={refresh} />
        ) : tab === "devices" ? (
          <>
            <div className="section-heading">
              <div>
                <h2>已授权的设备</h2>
                <p>设备主动领取任务；离线期间不会新增本地调度。</p>
              </div>
            </div>
            {!snapshot.devices.length ? (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>连接 Windows 客户端</EmptyTitle>
                  <EmptyDescription>
                    安装 TaskRelay 执行器，在状态窗口通过系统浏览器完成管理员授权。
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              snapshot.devices.map((d) => (
                <article className="settings-row" key={d.id}>
                  <div>
                    <h3>{d.name}</h3>
                    <p>{d.revoked ? "已吊销" : `最近连接：${formatDate(d.lastSeen)}`}</p>
                  </div>
                  <Button
                    variant="outline"
                    disabled={d.revoked || !!busy}
                    onClick={() =>
                      void act(d.id, () =>
                        createApi(transport).api.admin.devices[":id"].revoke.$post({
                          param: { id: d.id },
                        }),
                      )
                    }
                  >
                    吊销授权
                  </Button>
                </article>
              ))
            )}
          </>
        ) : (
          <>
            <div className="section-heading">
              <div>
                <h2>数据保留</h2>
                <p>普通对话和执行事件按保留时间清理；验证码在完成或过期后清除。</p>
              </div>
            </div>
            <form
              className="retention-form"
              onSubmit={(e) => {
                e.preventDefault();
                void act("retention", async () => {
                  await createApi(transport).api.admin.settings.$put({
                    json: { retentionDays: days },
                  });
                  daysDirty.current = false;
                  await config.refresh();
                });
              }}
            >
              <Field label="保留天数">
                <Input
                  type="number"
                  min={1}
                  max={365}
                  required
                  value={days}
                  onChange={(e) => {
                    daysDirty.current = true;
                    setDays(Number(e.target.value));
                  }}
                />
              </Field>
              <Button disabled={!!busy}>保存设置</Button>
              {config.error && <ErrorText error={config.error.message} />}
            </form>
            <p className="quiet">未核实的写操作及其账号锁不会随普通日志自动删除。</p>
          </>
        )}
      </TabsContent>
      {model && (
        <ModelDialog
          value={model === true ? null : model}
          transport={transport}
          onClose={() => setModel(null)}
          onSaved={async () => {
            setModel(null);
            await refresh();
          }}
        />
      )}
    </Tabs>
  );
}
