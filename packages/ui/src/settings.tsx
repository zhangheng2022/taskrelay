import { Memories } from './memories';
import { AdminPanel } from "./admin-panel";
import { AccountSecurity } from "./auth-gate";
import { useEffect, useState } from "react";
import {
  CheckCircle2,
  Loader2,
  Plus,
  ShieldCheck,
} from "lucide-react";
import type {
  ModelInput,
  ModelProfile,
  Snapshot,
  Transport,
} from "../../contracts/src/index";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./components/ui/tabs";
import { NativeSelect } from "./components/ui/native-select";
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
const presets = {
  openai: { name: "OpenAI", baseUrl: "https://api.openai.com/v1" },
  deepseek: { name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1" },
  bailian: {
    name: "百炼",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  },
  custom: { name: "", baseUrl: "" },
};
export function Settings({
  transport,
  snapshot,
  refresh,
}: {
  transport: Transport;
  snapshot: Snapshot;
  refresh: () => Promise<void>;
}) {
  const isAdmin=snapshot.me?.role === "admin";
  const [tab, setTab] = useState(isAdmin ? "models" : "accounts"),
    [model, setModel] = useState<ModelProfile | true | null>(null),
    [account, setAccount] = useState(false),
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
    if(!isAdmin)return;
    void transport
      .request<{ retentionDays: number }>("GET", "/api/admin/settings")
      .then((x) => setDays(x.retentionDays))
      .catch(() => {});
  }, [transport]);
  return (
    <Tabs className="settings" value={tab} onValueChange={setTab}>
      <TabsList className="w-full flex-wrap group-data-[orientation=horizontal]/tabs:h-auto">
        {[
          ["accounts", "站点账号"],
          ["security", "登录安全"],
          ["memories", "我的记忆"],
          ...(isAdmin?[["models", "模型服务"],["devices", "设备"],["data", "数据保留"],["admin","用户与配额"]]:[]),
        ].map(([id, label]) => (
          <TabsTrigger key={id} value={id} className="h-auto min-h-8">
            {label}
          </TabsTrigger>
        ))}
      </TabsList>
      {error && <ErrorText error={error} />}
      <TabsContent value={tab} className="settings-content">
        {tab === "memories" ? <Memories transport={transport}/> : tab === "admin" ? <AdminPanel transport={transport}/> : tab === "security" ? <AccountSecurity/> : tab === "models" ? (
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
                      {m.model} ·{" "}
                      {m.protocol === "chat" ? "Chat Completions" : "Responses"}
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
                    {m.capabilities.error && (
                      <ErrorText error={m.capabilities.error} />
                    )}
                  </div>
                  <div className="row-actions">
                    <Button
                      variant="outline"
                      disabled={!!busy}
                      onClick={() => setModel(m)}
                    >
                      编辑
                    </Button>
                    <Button
                      variant="outline"
                      disabled={!!busy}
                      onClick={() =>
                        void act(m.id, () =>
                          transport.request(
                            "POST",
                            `/api/admin/models/${m.id}/test`,
                          ),
                        )
                      }
                    >
                      {busy === m.id ? (
                        <Loader2 className="spin" />
                      ) : (
                        <CheckCircle2 />
                      )}
                      测试能力
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={!!busy || !m.capabilities.connection}
                      onClick={() =>
                        void act(m.id + "vision", () =>
                          transport.request(
                            "POST",
                            `/api/admin/models/${m.id}/vision`,
                          ),
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
          <>
            <div className="section-heading">
              <div>
                <h2>每个账号，独立浏览器环境</h2>
                <p>登录密码加密保存。验证码始终在任务对话中提交。</p>
              </div>
              <Button onClick={() => setAccount(true)}>
                <Plus />
                添加账号
              </Button>
            </div>
            {!snapshot.accounts.length ? (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>还没有站点账号</EmptyTitle>
                  <EmptyDescription>
                    无需登录的查询任务可以直接运行。
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              snapshot.accounts.map((a) => (
                <article className="settings-row" key={a.id}>
                  <div>
                    <h3>{a.name}</h3>{a.loginReset&&<p>执行设备已迁移，下次任务可能需要重新登录。</p>}
                    <p>
                      {a.origin} · {a.usernameHint}
                    </p>
                  </div>
                  <ShieldCheck size={20} />
                </article>
              ))
            )}
          </>
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
                    <p>
                      {d.revoked
                        ? "已吊销"
                        : `最近连接：${formatDate(d.lastSeen)}`}
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    disabled={d.revoked || !!busy}
                    onClick={() =>
                      void act(d.id, () =>
                        transport.request(
                          "POST",
                          `/api/admin/devices/${d.id}/revoke`,
                        ),
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
                <p>
                  普通对话和执行事件按保留时间清理；验证码在完成或过期后清除。
                </p>
              </div>
            </div>
            <form
              className="retention-form"
              onSubmit={(e) => {
                e.preventDefault();
                void act("retention", () =>
                  transport.request("PUT", "/api/admin/settings", {
                    retentionDays: days,
                  }),
                );
              }}
            >
              <Field label="保留天数">
                <Input
                  type="number"
                  min={1}
                  max={365}
                  required
                  value={days}
                  onChange={(e) => setDays(Number(e.target.value))}
                />
              </Field>
              <Button disabled={!!busy}>保存设置</Button>
            </form>
            <p className="quiet">
              未核实的写操作及其账号锁不会随普通日志自动删除。
            </p>
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
      {account && (
        <AccountDialog
          transport={transport}
          onClose={() => setAccount(false)}
          onSaved={async () => {
            setAccount(false);
            await refresh();
          }}
        />
      )}
    </Tabs>
  );
}
function ModelDialog({
  value,
  transport,
  onClose,
  onSaved,
}: {
  value: ModelProfile | null;
  transport: Transport;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [input, setInput] = useState<ModelInput>({
      name: value?.name ?? "",
      baseUrl: value?.baseUrl ?? "",
      protocol: value?.protocol ?? "chat",
      model: value?.model ?? "",
      apiKey: "",
      contextTokens:value?.contextTokens??16000,
      outputTokens:value?.outputTokens??4096,
      inputPrice: value?.inputPrice ?? null,
      outputPrice: value?.outputPrice ?? null,
    }),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await transport.request(
        value ? "PUT" : "POST",
        value ? `/api/admin/models/${value.id}` : "/api/admin/models",
        input,
      );
      setInput({ ...input, apiKey: "" });
      await onSaved();
    } catch (e) {
      setInput({ ...input, apiKey: "" });
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{value ? "编辑模型服务" : "添加模型服务"}</DialogTitle>
          <DialogDescription>
            保存后请运行能力测试。服务地址必须是公网 HTTPS。
          </DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-5" onSubmit={(e) => void submit(e)}>
          <FieldGroup>
            <Field label="服务商">
              <NativeSelect
                defaultValue="custom"
                onChange={(e) =>
                  setInput({
                    ...input,
                    ...presets[e.target.value as keyof typeof presets],
                  })
                }
              >
                {Object.entries(presets).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v.name || "自定义兼容服务"}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <FieldGroup className="grid grid-cols-1 gap-5 sm:grid-cols-2">
              <Field label="配置名称">
                <Input
                  required
                  value={input.name}
                  onChange={(e) => setInput({ ...input, name: e.target.value })}
                />
              </Field>
              <Field label="API 协议">
                <NativeSelect
                  value={input.protocol}
                  onChange={(e) =>
                    setInput({
                      ...input,
                      protocol: e.target.value as "chat" | "responses",
                    })
                  }
                >
                  <option value="chat">Chat Completions</option>
                  <option value="responses">Responses</option>
                </NativeSelect>
              </Field>
            </FieldGroup>
            <Field
              label="Base URL"
              hint="例如 https://api.openai.com/v1。也可粘贴与协议对应的完整接口地址。"
            >
              <Input
                required
                type="url"
                value={input.baseUrl}
                placeholder="https://api.example.com/v1"
                onChange={(e) =>
                  setInput({ ...input, baseUrl: e.target.value })
                }
              />
            </Field>
            <Field label="上下文预算（token，保守估计）"><Input type="number" min={8192} max={200000} value={input.contextTokens} onChange={e=>setInput({...input,contextTokens:Number(e.target.value)})}/></Field>
            <Field label="输出预留（token）"><Input type="number" min={512} max={8192} value={input.outputTokens} onChange={e=>setInput({...input,outputTokens:Number(e.target.value)})}/></Field>
            <Field label="模型名称">
              <Input
                required
                value={input.model}
                placeholder="填写服务商提供的模型标识"
                onChange={(e) => setInput({ ...input, model: e.target.value })}
              />
            </Field>
            <Field
              label="API Key"
              hint={
                value
                  ? "留空保留现有密钥。更新配置会创建新版本。"
                  : "密钥只会提交到你的 Workers，保存后不会显示明文。"
              }
            >
              <Input
                autoComplete="new-password"
                type="password"
                required={!value}
                value={input.apiKey}
                onChange={(e) => setInput({ ...input, apiKey: e.target.value })}
              />
            </Field>
            <FieldGroup className="grid grid-cols-1 gap-5 sm:grid-cols-2">
              <Field label="输入单价 / 百万 tokens（可选）">
                <Input
                  type="number"
                  min="0"
                  step="any"
                  value={input.inputPrice ?? ""}
                  onChange={(e) =>
                    setInput({
                      ...input,
                      inputPrice:
                        e.target.value === "" ? null : Number(e.target.value),
                    })
                  }
                />
              </Field>
              <Field label="输出单价 / 百万 tokens（可选）">
                <Input
                  type="number"
                  min="0"
                  step="any"
                  value={input.outputPrice ?? ""}
                  onChange={(e) =>
                    setInput({
                      ...input,
                      outputPrice:
                        e.target.value === "" ? null : Number(e.target.value),
                    })
                  }
                />
              </Field>
            </FieldGroup>
            {error && <ErrorText error={error} />}
          </FieldGroup>
          <div className="form-footer">
            <Button
              variant="ghost"
              type="button"
              onClick={onClose}
              disabled={busy}
            >
              取消
            </Button>
            <Button disabled={busy}>
              {busy && <Loader2 className="spin" />}保存配置
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
function AccountDialog({
  transport,
  onClose,
  onSaved,
}: {
  transport: Transport;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>添加站点账号</DialogTitle>
          <DialogDescription>
            每个账号使用独立浏览器 Profile，凭据只在对应站点填写。
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-5"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            setBusy(true);
            void transport
              .request("POST", "/api/user/accounts", Object.fromEntries(f))
              .then(onSaved)
              .catch((e) => setError(e.message))
              .finally(() => setBusy(false));
          }}
        >
          <FieldGroup>
            <Field label="账号名称">
              <Input name="name" required placeholder="例如：我的工作账号" />
            </Field>
            <Field label="登录站点">
              <Input
                type="url"
                name="origin"
                required
                placeholder="https://example.com"
              />
            </Field>
            <Field label="用户名">
              <Input name="username" autoComplete="off" />
            </Field>
            <Field label="密码（可选）">
              <Input
                name="password"
                type="password"
                autoComplete="new-password"
              />
            </Field>
            {error && <ErrorText error={error} />}
          </FieldGroup>
          <div className="form-footer">
            <Button type="button" variant="ghost" onClick={onClose}>
              取消
            </Button>
            <Button disabled={busy}>
              {busy && <Loader2 className="spin" />}保存账号
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
