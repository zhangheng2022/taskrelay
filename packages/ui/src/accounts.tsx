import {
  SettingsSearch,
  SettingsEmpty,
  useConfirmation,
  useSettingsAction,
  useSettingsDirty,
} from "./settings-support";
import { useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";
import type { SiteAccount, Snapshot, Transport } from "../../contracts/src/index";
import {
  AccountFields,
  accountFieldsBody,
  emptyAccountFields,
  type AccountFieldsValue,
} from "./account-fields";
import { Badge } from "./components/ui/badge";
import { Item, ItemContent, ItemActions } from "./components/ui/item";
import { Spinner } from "./components/ui/spinner";
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
  const [search, setSearch] = useState(""),
    [filter, setFilter] = useState("all");
  const { ask, confirmation } = useConfirmation(),
    management = useSettingsAction();
  const [editing, setEditing] = useState<SiteAccount | true | null>(null);
  const [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const clearing = useRef(false),
    groups = new Map<string, SiteAccount[]>();
  for (const account of snapshot.accounts.filter(
    (a) =>
      `${a.name} ${a.origin} ${a.usernameHint}`.toLowerCase().includes(search.toLowerCase()) &&
      (filter === "all" ||
        (filter === "invalid"
          ? a.credentialStatus === "invalid"
          : (a.enabled !== false) === (filter === "enabled"))),
  )) {
    const domain = account.businessDomains?.[0] ?? new URL(account.origin).hostname;
    const group = groups.get(domain) ?? [];
    group.push(account);
    groups.set(domain, group);
  }
  async function clear(account: SiteAccount) {
    if (clearing.current) return;
    if (
      !(await ask(
        `清除“${account.name}”的登录状态？`,
        "下次使用需要重新登录，账号密码仍保留。",
        "清除登录状态",
      ))
    )
      return;
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
      try {
        await refresh();
      } catch {
        setNotice("登录状态已清除，但列表刷新失败，请刷新后核对。");
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      clearing.current = false;
      setBusy("");
    }
  }
  async function manage(account: SiteAccount, remove: boolean) {
    if (
      !(await ask(
        `${remove ? "删除" : account.enabled === false ? "启用" : "停用"}“${account.name}”`,
        remove
          ? "只有没有任务、历史、账号锁及登录状态引用的账号可以永久删除。存在引用时请停用。"
          : account.enabled === false
            ? "启用后可用于新的交办；已失败的旧任务不会自动重试。"
            : "停用后立即停止相关任务，排队及执行中的任务标记为失败；恢复后不会自动重试。",
        remove ? "永久删除账号" : account.enabled === false ? "启用账号" : "停用账号",
      ))
    )
      return;
    await management.act(
      account.id,
      () =>
        remove
          ? createApi(transport).api.user.accounts[":id"].$delete({
              param: { id: account.id },
              json: { expectedVersion: account.managementVersion ?? 1 },
            })
          : createApi(transport).api.user.accounts[":id"].state.$put({
              param: { id: account.id },
              json: {
                expectedVersion: account.managementVersion ?? 1,
                enabled: account.enabled === false,
              },
            }),
      refresh,
      remove ? "账号已删除" : "账号状态已更新",
    );
  }
  return (
    <>
      {confirmation}
      {management.feedback}
      <SettingsSearch
        value={search}
        onChange={setSearch}
        state={filter}
        onState={setFilter}
        label="搜索名称、域名或账号"
        options={[
          ["all", "全部状态"],
          ["enabled", "已启用"],
          ["disabled", "已停用"],
          ["invalid", "凭据失效"],
        ]}
      />
      {!!snapshot.accounts.length && !groups.size && <SettingsEmpty />}
      <div className="section-heading">
        <div>
          <h2>每个账号，独立浏览器环境</h2>
          <p>按网站保存账号和登录状态，执行时自动选择可用设备。</p>
        </div>
        <Button onClick={() => setEditing(true)} disabled={!!busy || !!management.busy}>
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
                <Item key={account.id} asChild>
                  <article>
                    <ItemContent>
                      <h4>{account.name}</h4>
                      <Badge variant="outline">
                        {account.enabled === false ? "已停用" : "已启用"}
                      </Badge>
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
                    </ItemContent>
                    <ItemActions className="flex-wrap">
                      <Button
                        variant="outline"
                        disabled={!!busy || !!management.busy}
                        onClick={() => void manage(account, false)}
                      >
                        {account.enabled === false ? "启用" : "停用"}
                      </Button>
                      <Button
                        variant="ghost"
                        disabled={!!busy || !!management.busy}
                        onClick={() => void manage(account, true)}
                      >
                        删除
                      </Button>
                      <Button
                        variant="outline"
                        disabled={!!busy || !!management.busy}
                        aria-label={`编辑${account.name}`}
                        onClick={() => setEditing(account)}
                      >
                        编辑
                      </Button>
                      <Button
                        variant="ghost"
                        disabled={!!busy || !!management.busy}
                        aria-label={`清除${account.name}的登录状态`}
                        onClick={() => void clear(account)}
                      >
                        {busy === account.id && (
                          <Spinner aria-hidden="true" data-icon="inline-start" />
                        )}
                        清除登录状态
                      </Button>
                    </ItemActions>
                  </article>
                </Item>
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
            setNotice("账号已保存");
            try {
              await refresh();
            } catch {
              setNotice("账号已保存，但列表刷新失败，请刷新后核对。");
            }
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
  const [dirty, setDirty] = useState(false);
  useSettingsDirty(dirty);
  const { ask, confirmation } = useConfirmation();
  async function close() {
    if (!dirty || (await ask("放弃账号修改？", "未保存的内容会丢失。", "放弃修改"))) onClose();
  }
  const [managementVersion, setManagementVersion] = useState(account?.managementVersion ?? 1);
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
        setManagementVersion(result.account.managementVersion ?? 1);
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
      if (!navigator.onLine) throw Error("NETWORK_OFFLINE");
      const body = accountFieldsBody(value);
      const accounts = createApi(transport).api.user.accounts;
      if (account)
        await accounts[":id"].$patch({
          param: { id: account.id },
          json: {
            ...body,
            password: value.password || undefined,
            expectedCredentialVersion: version,
            expectedManagementVersion: managementVersion,
          },
        });
      else await accounts.$post({ json: body });
      setValue({ ...emptyAccountFields });
      setDirty(false);
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
        if (!open && !busy) void close().catch(() => {});
      }}
    >
      {confirmation}
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
              onChange={(v) => {
                setValue(v);
                setDirty(true);
              }}
              disabled={busy}
              keepPassword={!!account}
            />
            {error && <ErrorText error={error} />}
            <div className="form-footer">
              <Button type="button" variant="ghost" disabled={busy} onClick={() => void close()}>
                取消
              </Button>
              <Button type="submit" disabled={busy}>
                {busy && <Spinner aria-hidden="true" data-icon="inline-start" />}保存账号
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
