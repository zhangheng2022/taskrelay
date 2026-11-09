/** 登录安全使用 Better Auth 的当前会话及撤销接口；凭据草稿不进入查询缓存。 */
import { useContext, useState } from "react";
import { useQuery, QueryClientContext } from "@tanstack/react-query";
import { authClient, authResult } from "./auth-client";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Field, FieldGroup, FieldLabel } from "./components/ui/field";
import { Badge } from "./components/ui/badge";
import { ErrorText, LoadFeedback, formatDate } from "./feedback";
import {
  useConfirmation,
  useSettingsAction,
  useSettingsDirty,
  SettingsEmpty,
} from "./settings-support";
export function AccountSecurity() {
  const cache = useContext(QueryClientContext);
  const [current, setCurrent] = useState(""),
    [next, setNext] = useState(""),
    [confirm, setConfirm] = useState(""),
    [error, setError] = useState(""),
    [passwordNotice, setPasswordNotice] = useState("");
  const action = useSettingsAction(),
    { ask, confirmation } = useConfirmation();
  useSettingsDirty(!!current || !!next || !!confirm);
  const sessions = useQuery({
    queryKey: ["login-sessions"],
    retry: false,
    queryFn: async () => {
      const [list, me] = await Promise.all([
        authResult(authClient.listSessions()),
        authResult(authClient.getSession()),
      ]);
      return { list: list.data ?? [], current: me.data?.session.id };
    },
  });
  async function reload() {
    await sessions.refetch({ throwOnError: true });
  }
  function reset() {
    void cache?.cancelQueries().catch(() => {});
    cache?.clear();
    location.reload();
  }
  return (
    <>
      {confirmation}
      {action.feedback}
      {passwordNotice && <p role="status">{passwordNotice}</p>}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setError("");
          setPasswordNotice("");
          if (next !== confirm) {
            setError("两次输入的新密码不一致");
            return;
          }
          void action
            .act(
              "password",
              async () => {
                await authResult(
                  authClient.changePassword({
                    currentPassword: current,
                    newPassword: next,
                    revokeOtherSessions: true,
                  }),
                );
                setCurrent("");
                setNext("");
                setConfirm("");
                try {
                  await authResult(authClient.signOut());
                  reset();
                } catch {
                  setPasswordNotice(
                    "密码已修改，其他会话已撤销；退出当前会话的结果未确认。请使用下方退出登录，再用新密码重新登录。",
                  );
                }
              },
              undefined,
              "密码已修改，请重新登录",
            )
            .catch(() => {});
        }}
      >
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="current-password">当前密码</FieldLabel>
            <Input
              disabled={!!action.busy}
              id="current-password"
              type="password"
              autoComplete="current-password"
              required
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="next-password">新密码（12–128 位）</FieldLabel>
            <Input
              disabled={!!action.busy}
              id="next-password"
              type="password"
              autoComplete="new-password"
              minLength={12}
              maxLength={128}
              required
              value={next}
              onChange={(e) => setNext(e.target.value)}
            />
          </Field>
          <Field data-invalid={!!error}>
            <FieldLabel htmlFor="confirm-password">确认新密码</FieldLabel>
            <Input
              disabled={!!action.busy}
              id="confirm-password"
              type="password"
              autoComplete="new-password"
              minLength={12}
              maxLength={128}
              required
              aria-invalid={!!error}
              value={confirm}
              onChange={(e) => {
                setConfirm(e.target.value);
                setError("");
              }}
            />
          </Field>
          {error && <ErrorText error={error} />}
          <Button disabled={!!action.busy}>修改密码并重新登录</Button>
        </FieldGroup>
      </form>
      <div className="section-heading">
        <div>
          <h2>登录会话</h2>
          <p>退出其他会话不会停止已经交办的任务。</p>
        </div>
        <Button
          variant="outline"
          disabled={sessions.isFetching}
          onClick={() => void reload().catch(() => {})}
        >
          刷新会话
        </Button>
      </div>
      <LoadFeedback
        loading={sessions.isPending}
        error={sessions.error?.message ?? ""}
        label="正在读取登录会话…"
        onRetry={() => void reload().catch(() => {})}
      />
      {sessions.data && !sessions.data.list.length && (
        <SettingsEmpty
          title="暂无可显示的登录会话"
          description="本地开发模式可能没有真实登录会话。"
        />
      )}
      {sessions.data?.list.map((s) => (
        <article className="settings-row" key={s.id}>
          <div>
            <h3>{s.id === sessions.data.current ? "当前会话" : "其他登录会话"}</h3>
            <p className="break-words">{s.userAgent || "未知设备"}</p>
            <p>最近更新：{formatDate(String(s.updatedAt))}</p>
            <p>到期：{formatDate(String(s.expiresAt))}</p>
          </div>
          {s.id === sessions.data.current ? (
            <Badge variant="secondary">当前登录</Badge>
          ) : (
            <Button
              variant="outline"
              disabled={!!action.busy}
              onClick={() =>
                void (async () => {
                  if (await ask("退出这个登录会话？", "该设备下次访问时需要重新登录。", "退出会话"))
                    await action.act(
                      s.id,
                      () => authResult(authClient.revokeSession({ token: s.token })),
                      reload,
                      "已退出该会话",
                    );
                })()
              }
            >
              退出会话
            </Button>
          )}
        </article>
      ))}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          disabled={
            !!action.busy || !sessions.data?.list.some((s) => s.id !== sessions.data?.current)
          }
          onClick={() =>
            void (async () => {
              if (
                await ask(
                  "退出全部其他会话？",
                  "保留当前登录，其他设备需要重新登录。",
                  "退出其他会话",
                )
              )
                await action.act(
                  "sessions",
                  () => authResult(authClient.revokeOtherSessions()),
                  reload,
                  "已退出其他会话",
                );
            })()
          }
        >
          退出全部其他会话
        </Button>
        <Button
          variant="outline"
          disabled={!!action.busy}
          onClick={() =>
            void (async () => {
              if (await ask("退出当前登录？", "当前未保存的表单将被丢弃。", "退出登录"))
                await action.act("logout", async () => {
                  await authResult(authClient.signOut());
                  reset();
                });
            })()
          }
        >
          退出登录
        </Button>
      </div>
    </>
  );
}
