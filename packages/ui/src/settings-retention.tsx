import { useState } from "react";
import type { Transport } from "../../contracts/src/index";
import { useTransportQuery } from "./queries";
import { createApi, rpcData } from "./api";
import { useConfirmation, useSettingsAction, useSettingsDirty } from "./settings-support";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Field, FieldGroup, FieldLabel } from "./components/ui/field";
import { Alert, AlertDescription } from "./components/ui/alert";
import { LoadFeedback } from "./feedback";
export function RetentionSettings({
  transport,
  onCleanup,
}: {
  transport: Transport;
  onCleanup?: () => void;
}) {
  const config = useTransportQuery(
    transport,
    ["admin-settings"],
    (signal) => rpcData(createApi(transport).api.admin.settings.$get({}, { init: { signal } })),
    60000,
  );
  const [draft, setDraft] = useState<string | null>(null),
    action = useSettingsAction(),
    { ask, confirmation } = useConfirmation();
  useSettingsDirty(draft !== null && draft !== String(config.data?.retentionDays));
  return (
    <>
      <div className="section-heading">
        <div>
          <h2>数据保留</h2>
          <p>全局设置，适用于所有用户的聊天与执行事件。</p>
        </div>
      </div>
      {confirmation}
      {action.feedback}
      <LoadFeedback
        loading={config.isPending}
        error={config.error?.message ?? ""}
        label="正在读取保留设置…"
        onRetry={() => void config.refresh().catch(() => {})}
      />
      {config.data && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const days = Number(draft ?? config.data.retentionDays);
            void (async () => {
              if (
                days < config.data.retentionDays &&
                !(await ask(
                  "缩短所有用户的数据保留时间？",
                  `超过 ${days} 天的聊天及其图片、任务偏好快照将按清理规则删除，无法恢复。`,
                  "保存保留期限",
                ))
              )
                return;
              if (
                await action.act(
                  "save",
                  () =>
                    createApi(transport).api.admin.settings.$put({ json: { retentionDays: days } }),
                  config.refresh,
                )
              )
                setDraft(null);
            })().catch(() => {});
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="retention-days">保留天数（1–365 天）</FieldLabel>
              <Input
                id="retention-days"
                disabled={!!action.busy}
                type="number"
                min={1}
                max={365}
                step={1}
                required
                value={draft ?? config.data.retentionDays}
                onChange={(e) => setDraft(e.target.value)}
              />
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button disabled={!!action.busy || draft === null}>保存设置</Button>
              <Button
                type="button"
                variant="outline"
                disabled={!!action.busy || draft === null}
                onClick={() => setDraft(null)}
              >
                撤销修改
              </Button>
            </div>
          </FieldGroup>
        </form>
      )}
      <Alert>
        <AlertDescription>
          清理不会自动移除结果未知的操作及其账号锁。账号凭据、模型配置和你保存的记忆不属于普通聊天保留期。
        </AlertDescription>
      </Alert>
      <div className="section-heading">
        <div>
          <h2>清理我的聊天</h2>
          <p>仅清理当前用户的数据，操作前展示影响范围。</p>
        </div>
        <Button variant="outline" disabled={!onCleanup} onClick={onCleanup}>
          清理我的聊天
        </Button>
      </div>
    </>
  );
}
