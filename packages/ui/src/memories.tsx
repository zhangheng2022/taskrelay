/** 手动记忆编辑与启用；版本冲突保留草稿，任务始终使用交办时的加密快照。 */
import { useState } from "react";
import type { Transport } from "../../contracts/src/index";
import type { MemoryPreference } from "../../contracts/src/preferences";
import { createApi, rpcData } from "./api";
import { QueryBoundary, useTransportQuery } from "./queries";
import { Button } from "./components/ui/button";
import { Textarea } from "./components/ui/textarea";
import { Input } from "./components/ui/input";
import { Badge } from "./components/ui/badge";
import { Field, FieldGroup, FieldLabel } from "./components/ui/field";
import { LoadFeedback, formatDate } from "./feedback";
import {
  SettingsSearch,
  SettingsEmpty,
  useConfirmation,
  useSettingsAction,
  useSettingsDirty,
} from "./settings-support";
export function Memories({ transport }: { transport: Transport }) {
  return (
    <QueryBoundary owner={transport}>
      <MemoryEditor transport={transport} />
    </QueryBoundary>
  );
}
function MemoryEditor({ transport }: { transport: Transport }) {
  const query = useTransportQuery(
    transport,
    ["memory-page"],
    async (signal) => {
      const items: MemoryPreference[] = [];
      let before: string | undefined;
      do {
        const page = await rpcData(
          createApi(transport).api.user["memory-page"].$get(
            { query: { before, state: "all" } },
            { init: { signal } },
          ),
        );
        items.push(...page.items);
        before = page.nextCursor ?? undefined;
      } while (before);
      return items;
    },
    60000,
  );
  const [editing, setEditing] = useState<MemoryPreference | null>(null),
    [text, setText] = useState(""),
    [enabled, setEnabled] = useState(false);
  const [search, setSearch] = useState(""),
    [state, setState] = useState("all"),
    [count, setCount] = useState(30);
  const action = useSettingsAction(),
    { ask, confirmation } = useConfirmation();
  const latest = query.data?.find((m) => m.id === editing?.id);
  const conflict = !!editing && !!query.data && (!latest || latest.version !== editing.version);
  const dirty = text !== (editing?.text ?? "") || enabled !== (editing?.enabled ?? false);
  useSettingsDirty(dirty);
  const items = (query.data ?? []).filter(
    (m) =>
      m.text.toLowerCase().includes(search.toLowerCase()) &&
      (state === "all" || m.enabled === (state === "enabled")),
  );
  async function reset(m: MemoryPreference | null) {
    if (dirty && !(await ask("放弃当前记忆的修改？", "未保存的内容会丢失。", "放弃修改"))) return;
    setEditing(m);
    setText(m?.text ?? "");
    setEnabled(m?.enabled ?? false);
  }
  const put = (id: string, text: string, enabled: boolean, expectedVersion: number) =>
    createApi(transport).api.user.memories[":id"].$put({
      param: { id },
      json: { text, enabled, expectedVersion, confirmed: true },
    });
  return (
    <>
      {confirmation}
      {action.feedback}
      <div className="section-heading">
        <div>
          <h2>任务记忆</h2>
          <p>只将你明确启用的偏好用于后续交办；当前聊天要求始终优先。</p>
        </div>
      </div>
      <p className="text-sm text-muted-foreground">
        修改、停用或删除不影响已交办任务。任务中保存的快照随聊天清理。旧记忆默认停用；请勿在此填写密码或验证码。
      </p>
      {conflict && (
        <div role="status" className="flex flex-col gap-3 rounded-md border p-4">
          <p>
            {latest
              ? "这条记忆已有新版本。核对已保存内容后，可保留当前草稿继续编辑。"
              : "这条记忆已被删除。可以将当前草稿保存为一条新记忆。"}
          </p>
          {latest && (
            <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">
              已保存：{latest.text}（{latest.enabled ? "已启用" : "已停用"}）
            </p>
          )}
          <Button
            type="button"
            variant="outline"
            disabled={!!action.busy}
            onClick={() => setEditing(latest ?? null)}
          >
            {latest ? "已核对，保留草稿继续编辑" : "将草稿另存为新记忆"}
          </Button>
        </div>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void action
            .act(
              "save",
              () => put(editing?.id ?? crypto.randomUUID(), text, enabled, editing?.version ?? 0),
              query.refresh,
            )
            .then((ok) => {
              if (ok) {
                setEditing(null);
                setText("");
                setEnabled(false);
              }
            })
            .catch(() => {});
        }}
      >
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="memory-text">{editing ? "修改记忆" : "新增记忆"}</FieldLabel>
            <Textarea
              id="memory-text"
              value={text}
              maxLength={1000}
              required
              disabled={!!action.busy}
              onChange={(e) => setText(e.target.value)}
            />
            <p className="text-sm text-muted-foreground">{text.length} / 1000 字</p>
          </Field>
          <Field orientation="horizontal">
            <Input
              id="memory-enabled"
              disabled={!!action.busy}
              className="size-4"
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            <FieldLabel htmlFor="memory-enabled">用于后续任务</FieldLabel>
          </Field>
          <div className="flex gap-2">
            <Button disabled={!!action.busy || !text.trim() || !dirty || conflict}>保存记忆</Button>
            {(editing || dirty) && (
              <Button
                type="button"
                variant="outline"
                disabled={!!action.busy}
                onClick={() => void reset(null)}
              >
                取消修改
              </Button>
            )}
          </div>
        </FieldGroup>
      </form>
      <SettingsSearch
        value={search}
        onChange={(v) => {
          setSearch(v);
          setCount(30);
        }}
        state={state}
        onState={(v) => {
          setState(v);
          setCount(30);
        }}
        label="搜索记忆内容"
      />
      <Button
        variant="outline"
        disabled={query.isFetching || !!action.busy}
        onClick={() => void query.refresh().catch(() => {})}
      >
        刷新记忆列表
      </Button>
      <LoadFeedback
        loading={query.isPending}
        error={query.error?.message ?? ""}
        label="正在读取任务记忆…"
        onRetry={() => void query.refresh().catch(() => {})}
      />
      {!query.isPending && !query.error && !items.length && (
        <SettingsEmpty
          title={query.data?.length ? "没有匹配的记忆" : "还没有任务记忆"}
          description="可以保存语言、表达方式等偏好，并选择是否用于后续任务。"
        />
      )}
      {items.slice(0, count).map((m) => (
        <article className="settings-row" key={m.id}>
          <div>
            <Badge variant="outline">{m.enabled ? "已启用" : "已停用"}</Badge>
            <p className="whitespace-pre-wrap break-words">{m.text}</p>
            <p>
              {m.text.length} 字 · 更新于 {formatDate(m.updatedAt)}
            </p>
          </div>
          <div className="row-actions">
            <Button variant="outline" disabled={!!action.busy} onClick={() => void reset(m)}>
              编辑
            </Button>
            <Button
              variant="outline"
              disabled={!!action.busy || editing?.id === m.id}
              onClick={() =>
                void action.act(m.id, () => put(m.id, m.text, !m.enabled, m.version), query.refresh)
              }
            >
              {m.enabled ? "停用" : "启用"}
            </Button>
            <Button
              variant="ghost"
              disabled={!!action.busy}
              onClick={() =>
                void (async () => {
                  if (
                    !(await ask(
                      "删除这条记忆？",
                      "后续任务不再使用这条偏好；已经交办的任务快照不会改变。",
                      "删除记忆",
                    ))
                  )
                    return;
                  if (
                    await action.act(
                      m.id,
                      () =>
                        createApi(transport).api.user.memories[":id"].$delete({
                          param: { id: m.id },
                          json: { expectedVersion: m.version },
                        }),
                      query.refresh,
                      "记忆已删除",
                    )
                  ) {
                    if (editing?.id === m.id) {
                      setEditing(null);
                      setText("");
                      setEnabled(false);
                    }
                  }
                })()
              }
            >
              删除
            </Button>
          </div>
        </article>
      ))}
      {count < items.length && (
        <Button variant="outline" onClick={() => setCount((n) => n + 30)}>
          加载更多记忆
        </Button>
      )}
    </>
  );
}
