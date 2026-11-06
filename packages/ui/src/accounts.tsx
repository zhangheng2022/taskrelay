import { useEffect, useRef, useState } from "react";
import { Loader2, Plus } from "lucide-react";
import type { SiteAccount, Snapshot, Transport } from "../../contracts/src/index";
import {
  AccountFields,
  accountFieldsBody,
  emptyAccountFields,
  type AccountFieldsValue,
} from "./account-fields";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog";
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from "./components/ui/empty";
import { ErrorText, LoadFeedback } from "./feedback";
import { createApi, rpcData } from "./api";

function syncErrorDescription(reason?: string | null) {
  switch (reason) {
    case "TOO_LARGE":
      return "登录状态超过 2 MB，已跳过同步";
    case "UNSUPPORTED_COOKIE":
      return "部分 Cookie 无法迁移，已跳过同步";
    default:
      return "同步未完成，后续任务将重试";
  }
}

/** 按业务域名展示账号，编辑时才读取本人凭据；保存、清除登录状态均由云端版本校验。 */
export function Accounts({
  snapshot,
  transport,
  refresh,
}: {
  snapshot: Snapshot;
  transport: Transport;
  refresh: () => Promise<void>;
}) {
  const [editing, setEditing] = useState<SiteAccount | true | null>(null);
  const [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const clearing = useRef(false),
    groups = new Map<string, SiteAccount[]>();
  for (const account of snapshot.accounts) {
    const domain = account.businessDomains?.[0] ?? new URL(account.origin).hostname;
    const group = groups.get(domain) ?? [];
    group.push(account);
    groups.set(domain, group);
  }
  async function clear(account: SiteAccount) {
    if (clearing.current) return;
    clearing.current = true;
    setBusy(account.id);
    setError("");
    setNotice("");
    try {
      await rpcData(
        createApi(transport).api.user.accounts[":id"]["clear-state"].$post({
          param: { id: account.id },
          json: { expectedStateEpoch: account.stateEpoch ?? 1 },
        }),
      );
      setNotice(`已清除“${account.name}”的登录状态，下次使用时重新登录。`);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      clearing.current = false;
      setBusy("");
    }
  }
  return (
    <>
      <div className="section-heading">
        <div>
          <h2>每个账号，独立浏览器环境</h2>
          <p>按网站保存账号和登录状态，执行时自动选择可用设备。</p>
        </div>
        <Button onClick={() => setEditing(true)} disabled={!!busy}>
          <Plus data-icon="inline-start" />
          添加账号
        </Button>
      </div>
      {error && <ErrorText error={error} />}
      {notice && <p role="status">{notice}</p>}
      {!snapshot.accounts.length ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>还没有站点账号</EmptyTitle>
            <EmptyDescription>
              可以在聊天登录成功后确认保存；无需登录的任务可直接执行。
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        [...groups]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([domain, accounts]) => (
            <section key={domain} aria-label={`${domain} 的账号`} className="flex flex-col gap-3">
              <h3 className="break-all">{domain}</h3>
              {accounts.map((account) => (
                <article className="settings-row" key={account.id}>
                  <div className="min-w-0">
                    <h4>{account.name}</h4>
                    <p className="break-all">
                      {account.usernameHint || "未设置用户名"} · {account.origin}
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Badge
                        variant={
                          account.credentialStatus === "invalid" ? "destructive" : "secondary"
                        }
                      >
                        {account.credentialStatus === "valid"
                          ? "凭据已验证"
                          : account.credentialStatus === "invalid"
                            ? "需要修改凭据"
                            : "凭据待验证"}
                      </Badge>
                      <Badge variant="outline">
                        {account.syncStatus === "synced"
                          ? "状态已同步"
                          : account.syncStatus === "failed"
                            ? "状态未同步"
                            : account.loginReset
                              ? "需要登录"
                              : "暂无同步状态"}
                      </Badge>
                    </div>
                    {account.syncStatus === "failed" && (
                      <p>{syncErrorDescription(account.syncError)}</p>
                    )}
                    <p>
                      优先使用
                      {snapshot.devices.find((device) => device.id === account.lastDeviceId)
                        ?.name ?? "上次可用设备"}
                      ；登录状态失效时会在聊天中协助登录。
                    </p>
                  </div>
                  <div className="row-actions">
                    <Button
                      variant="outline"
                      disabled={!!busy}
                      aria-label={`编辑${account.name}`}
                      onClick={() => setEditing(account)}
                    >
                      编辑
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={!!busy}
                      aria-label={`清除${account.name}的登录状态`}
                      onClick={() => void clear(account)}
                    >
                      {busy === account.id && (
                        <Loader2 className="animate-spin" data-icon="inline-start" />
                      )}
                      清除登录状态
                    </Button>
                  </div>
                </article>
              ))}
            </section>
          ))
      )}
      {editing && (
        <AccountDialog
          key={editing === true ? "new" : editing.id}
          account={editing === true ? null : editing}
          transport={transport}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await refresh();
          }}
        />
      )}
    </>
  );
}

function AccountDialog({
  account,
  transport,
  onClose,
  onSaved,
}: {
  account: SiteAccount | null;
  transport: Transport;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [value, setValue] = useState<AccountFieldsValue>({ ...emptyAccountFields });
  const [loaded, setLoaded] = useState(!account);
  const [version, setVersion] = useState(account?.credentialVersion ?? 1),
    [loading, setLoading] = useState(!!account),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [retry, setRetry] = useState(0);
  const flight = useRef(false);
  const accountId = account?.id;
  useEffect(() => {
    if (!accountId) return;
    let alive = true;
    setLoading(true);
    setLoaded(false);
    setError("");
    const controller = new AbortController();
    void rpcData(
      createApi(transport).api.user.accounts[":id"].$get(
        { param: { id: accountId } },
        { init: { signal: controller.signal } },
      ),
    )
      .then((result) => {
        if (!alive) return;
        setVersion(result.account.credentialVersion ?? 1);
        setValue({
          name: result.account.name,
          origin: result.account.origin,
          username: result.username,
          password: "",
          businessDomains: (
            result.account.businessDomains ?? [new URL(result.account.origin).hostname]
          ).join("\n"),
          loginOrigins: (result.account.loginOrigins ?? [result.account.origin]).join("\n"),
        });
        setLoaded(true);
      })
      .catch((e) => {
        if (alive) setError(e.message);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
      controller.abort();
    };
  }, [accountId, transport, retry]);
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (flight.current || loading) return;
    flight.current = true;
    setBusy(true);
    setError("");
    try {
      const body = accountFieldsBody(value);
      const accounts = createApi(transport).api.user.accounts;
      if (account)
        await accounts[":id"].$patch({
          param: { id: account.id },
          json: {
            ...body,
            password: value.password || undefined,
            expectedCredentialVersion: version,
          },
        });
      else await accounts.$post({ json: body });
      setValue({ ...emptyAccountFields });
      await onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      flight.current = false;
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{account ? "编辑站点账号" : "添加站点账号"}</DialogTitle>
          <DialogDescription>
            {account
              ? "修改域名、账号或密码后需要重新验证。"
              : "保存后可在任务中使用，每个账号使用独立浏览器环境。"}
          </DialogDescription>
        </DialogHeader>
        {loading || !loaded ? (
          <LoadFeedback
            loading={loading}
            error={error}
            label="正在加载账号…"
            onRetry={() => setRetry((v) => v + 1)}
          />
        ) : (
          /* oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- 表单捕获输入法 Enter 冒泡，避免中文组合输入误提交。 */
          <form
            className="flex flex-col gap-5"
            onSubmit={(event) => void save(event)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && event.nativeEvent.isComposing) event.preventDefault();
            }}
          >
            <AccountFields
              value={value}
              onChange={setValue}
              disabled={busy}
              keepPassword={!!account}
            />
            {error && <ErrorText error={error} />}
            <div className="form-footer">
              <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
                取消
              </Button>
              <Button type="submit" disabled={busy}>
                {busy && <Loader2 data-icon="inline-start" className="animate-spin" />}保存账号
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
