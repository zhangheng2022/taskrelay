/** 模型服务管理保留配置版本与独立能力结果；停用立即停止关联运行，配置编辑仍按版本保存。 */
import { useState } from "react";
import { Plus, CheckCircle2 } from "lucide-react";
import type { ModelProfile, Snapshot, Transport } from "../../contracts/src/index";
import { createApi } from "./api";
import { ModelConnections } from "./model-connections";
import { ModelDialog } from "./model-dialog";
import { Item, ItemContent, ItemActions } from "./components/ui/item";
import { Spinner } from "./components/ui/spinner";
import { Button } from "./components/ui/button";
import { Badge } from "./components/ui/badge";
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
  EmptyContent,
} from "./components/ui/empty";
import { ErrorText, formatDate } from "./feedback";
import { SettingsSearch, useConfirmation, useSettingsAction } from "./settings-support";
export function SettingsModels({
  snapshot,
  transport,
  refresh,
}: {
  snapshot: Snapshot;
  transport: Transport;
  refresh: () => Promise<void>;
}) {
  const [savedNotice, setSavedNotice] = useState("");
  const [model, setModel] = useState<ModelProfile | true | null>(null);
  const [search, setSearch] = useState(""),
    [state, setState] = useState("all");
  const action = useSettingsAction(),
    { ask, confirmation } = useConfirmation();
  const busy = action.busy;
  const act = (id: string, fn: () => Promise<unknown>) => action.act(id, fn, refresh);
  const models = snapshot.models.filter(
    (m) =>
      m.scope !== "personal" &&
      (!search || `${m.name} ${m.model}`.toLowerCase().includes(search.toLowerCase())) &&
      (state === "all" || (m.enabled !== false) === (state === "enabled")),
  );
  async function manage(m: ModelProfile, remove: boolean) {
    if (
      !(await ask(
        `${remove ? "删除" : m.enabled === false ? "启用" : "停用"}“${m.name}”`,
        remove
          ? "模型配置将永久删除。历史聊天、运行和用量记录会保留。"
          : m.enabled === false
            ? "启用后可用于新的交办；已失败的旧任务不会自动重试。"
            : "停用后立即停止相关任务，排队及执行中的任务标记为失败；恢复后不会自动重试。",
        remove ? "永久删除模型" : m.enabled === false ? "启用模型" : "停用模型",
      ))
    )
      return;
    await act(m.id, () =>
      remove
        ? createApi(transport).api.admin.models[":id"].$delete({
            param: { id: m.id },
            json: { expectedVersion: m.managementVersion ?? 1 },
          })
        : createApi(transport).api.admin.models[":id"].state.$put({
            param: { id: m.id },
            json: { expectedVersion: m.managementVersion ?? 1, enabled: m.enabled === false },
          }),
    );
  }
  return (
    <>
      <ModelConnections
        connections={snapshot.modelConnections ?? []}
        transport={transport}
        refresh={refresh}
      />
      {action.feedback}
      {savedNotice && <p role="status">{savedNotice}</p>}
      {confirmation}
      <SettingsSearch
        value={search}
        onChange={setSearch}
        state={state}
        onState={setState}
        label="搜索名称或模型"
      />
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
      {!models.length ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>
              {snapshot.models.length ? "没有匹配的模型" : "先连接一个模型服务"}
            </EmptyTitle>
            <EmptyDescription>
              模型服务须支持 Responses API。供应商密钥由 Cloudflare 托管。
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button variant="outline" onClick={() => setModel(true)}>
              配置模型
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        models.map((m) => (
          <Item key={m.id} asChild>
            <article>
              <ItemContent>
                <h3>
                  {m.name}
                  <small>v{m.version}</small>{" "}
                  <Badge variant="outline">{m.enabled === false ? "已停用" : "已启用"}</Badge>
                </h3>
                <p>{m.model} · Responses</p>
                <div className="capabilities mt-3">
                  <Badge variant="secondary">
                    连接 {m.capabilities.connection ? "通过" : "未通过"}
                  </Badge>
                  <Badge variant="secondary">
                    工具调用 {m.capabilities.tools ? "通过" : "未通过"}
                  </Badge>
                  <Badge variant="secondary">
                    结构化输出{" "}
                    {m.capabilities.structured === "none" ? "未通过" : m.capabilities.structured}
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
                <p>
                  能力测试：
                  {m.capabilities.testedAt ? formatDate(m.capabilities.testedAt) : "尚未测试"}
                </p>
                <p>
                  图像测试：
                  {m.capabilities.visionTestedAt
                    ? formatDate(m.capabilities.visionTestedAt)
                    : "尚未测试"}
                </p>
                {m.capabilities.error && <ErrorText error={m.capabilities.error} />}
              </ItemContent>
              <ItemActions className="flex-wrap">
                <Button variant="outline" disabled={!!busy} onClick={() => void manage(m, false)}>
                  {m.enabled === false ? "启用" : "停用"}
                </Button>
                <Button variant="ghost" disabled={!!busy} onClick={() => void manage(m, true)}>
                  删除
                </Button>
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
                  {busy === m.id ? (
                    <Spinner aria-hidden="true" data-icon="inline-start" />
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
                      createApi(transport).api.admin.models[":id"].vision.$post({
                        param: { id: m.id },
                      }),
                    )
                  }
                >
                  测试图像（可选）
                </Button>
              </ItemActions>
            </article>
          </Item>
        ))
      )}

      {model && (
        <ModelDialog
          connections={snapshot.modelConnections ?? []}
          value={model === true ? null : model}
          transport={transport}
          onClose={() => setModel(null)}
          onSaved={async () => {
            setModel(null);
            setSavedNotice("模型配置已保存");
            try {
              await refresh();
            } catch {
              setSavedNotice("模型配置已保存，但列表刷新失败，请刷新后核对。");
            }
          }}
        />
      )}
    </>
  );
}
