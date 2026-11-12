/** 模型服务管理保留配置版本与独立能力结果；停用立即停止关联运行，配置编辑仍按版本保存。 */
import { useState } from "react";
import { Plus, MoreHorizontal } from "lucide-react";
import type { ModelProfile, Snapshot, Transport } from "../../contracts/src/index";
import { createApi, rpcData } from "./api";
import { ModelConnections } from "./model-connections";
import { ModelDialog } from "./model-dialog";
import { Item, ItemContent, ItemActions } from "./components/ui/item";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "./components/ui/dialog";
import { Button } from "./components/ui/button";
import { Badge } from "./components/ui/badge";
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
  const [services, setServices] = useState<"manage" | "add" | null>(null);
  const [filtering, setFiltering] = useState(false);
  const [detail, setDetail] = useState<string | null>(null);
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
  const connections = snapshot.modelConnections ?? [];
  const configured = connections.filter((c) => c.bindingVerified);
  const selected = snapshot.models.find((m) => m.id === detail);
  const api = createApi(transport).api.admin.models;
  function add() {
    if (configured.length) setModel(true);
    else setServices("add");
  }
  async function testVersion(m: Pick<ModelProfile, "id" | "version">, vision = false) {
    const args = { param: { id: m.id }, query: { version: m.version } };
    const ok = await action.act(
      m.id,
      () => rpcData(vision ? api[":id"].vision.$post(args) : api[":id"].test.$post(args)),
      refresh,
      "测试已结束",
    );
    if (ok) setSavedNotice("");
    else {
      setSavedNotice("配置已保存。可在此版本上重新测试。");
      try {
        await refresh();
      } catch {
        setSavedNotice("配置已保存，请刷新列表核对测试结果。");
      }
    }
  }
  if (services)
    return (
      <>
        <Button variant="ghost" onClick={() => setServices(null)}>
          返回模型列表
        </Button>
        {services === "add" &&
          (configured.length ? (
            <Button
              onClick={() => {
                setServices(null);
                setModel(true);
              }}
            >
              继续添加模型
            </Button>
          ) : (
            <p role="status">先添加一个服务，配置完成后即可继续添加模型。</p>
          ))}
        <ModelConnections connections={connections} transport={transport} refresh={refresh} />
      </>
    );
  return (
    <>
      <div className="section-heading flex-wrap">
        <h2>模型服务</h2>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="ghost"
            aria-expanded={filtering}
            onClick={() => setFiltering(!filtering)}
          >
            筛选
          </Button>
          <Button disabled={!!busy} variant="outline" onClick={() => setServices("manage")}>
            管理服务
          </Button>
          <Button disabled={!!busy} onClick={add}>
            <Plus />
            添加模型
          </Button>
        </div>
      </div>
      {filtering && (
        <SettingsSearch
          value={search}
          onChange={setSearch}
          state={state}
          onState={setState}
          label="搜索名称或模型"
        />
      )}
      {action.feedback}
      {savedNotice && <p role="status">{savedNotice}</p>}
      {confirmation}
      {!models.length && (
        <p>
          {snapshot.models.some((m) => m.scope !== "personal")
            ? "没有匹配的模型"
            : "还没有平台模型"}
        </p>
      )}
      {models.map((m) => {
        const caps = m.capabilities,
          ready =
            caps.questionAnswered && caps.connection && caps.tools && caps.structured !== "none";
        const failed =
          caps.testedAt && (!caps.connection || !caps.tools || caps.structured === "none");
        const status = failed
          ? "测试失败"
          : m.enabled === false
            ? ready
              ? "测试通过，待启用"
              : "已停用"
            : !caps.testedAt
              ? "待测试"
              : "已启用";
        const service = connections.find((c) => c.id === m.connectionId);
        return (
          <Item key={m.id} asChild>
            <article>
              <ItemContent className="min-w-0">
                <h3 className="break-all">{m.name}</h3>
                <p>{service?.name ?? "服务不可用"}</p>
              </ItemContent>
              <ItemActions className="flex-wrap">
                <Badge variant="outline">{status}</Badge>
                {busy === m.id ? (
                  <span role="status">处理中…</span>
                ) : m.enabled === false && ready ? (
                  <Button variant="outline" disabled={!!busy} onClick={() => void manage(m, false)}>
                    启用
                  </Button>
                ) : failed || !caps.testedAt || (m.enabled === false && !ready) ? (
                  <Button variant="outline" disabled={!!busy} onClick={() => void testVersion(m)}>
                    {caps.testedAt ? "重新测试" : "测试模型"}
                  </Button>
                ) : null}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      disabled={!!busy}
                      aria-label={"更多：" + m.name}
                    >
                      <MoreHorizontal />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuGroup>
                      <DropdownMenuItem onSelect={() => setDetail(m.id)}>测试详情</DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => setModel(m)}>编辑</DropdownMenuItem>
                      {m.enabled !== false && (
                        <DropdownMenuItem onSelect={() => void manage(m, false)}>
                          停用
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem variant="destructive" onSelect={() => void manage(m, true)}>
                        删除
                      </DropdownMenuItem>
                    </DropdownMenuGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              </ItemActions>
              {failed && (
                <p className="basis-full text-sm" role="status">
                  未通过：
                  {!caps.connection
                    ? "问答"
                    : [!caps.tools && "工具调用", caps.structured === "none" && "结构化输出"]
                        .filter(Boolean)
                        .join("、")}
                </p>
              )}
            </article>
          </Item>
        );
      })}
      {selected && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setDetail(null);
          }}
        >
          <DialogContent className="max-h-[90dvh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>测试详情</DialogTitle>
              <DialogDescription>
                {selected.name} · {selected.model} · v{selected.version}
              </DialogDescription>
            </DialogHeader>
            <p>
              问答{" "}
              {selected.capabilities.questionAnswered
                ? "通过"
                : selected.capabilities.questionAnswered === false
                  ? "未通过"
                  : "未验证"}
            </p>
            <p>工具调用 {selected.capabilities.tools ? "通过" : "未通过"}</p>
            <p>结构化输出 {selected.capabilities.structured === "none" ? "未通过" : "通过"}</p>
            <p>
              图像输入{" "}
              {selected.capabilities.vision
                ? "通过"
                : selected.capabilities.visionTestedAt
                  ? "未通过"
                  : "未验证"}
            </p>
            {selected.capabilities.testedAt && (
              <p>上次测试：{formatDate(selected.capabilities.testedAt)}</p>
            )}
            {selected.capabilities.error?.split(",").map((code) => (
              <ErrorText key={code} error={code} />
            ))}
            <div className="flex flex-wrap gap-2">
              <Button disabled={!!busy} onClick={() => void testVersion(selected)}>
                重新测试
              </Button>
              <Button
                variant="outline"
                disabled={!!busy || !selected.capabilities.connection}
                onClick={() => void testVersion(selected, true)}
              >
                测试图像
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
      {model && (
        <ModelDialog
          value={model === true ? null : model}
          connections={configured}
          transport={transport}
          onClose={() => setModel(null)}
          onSaved={async (saved) => {
            setModel(null);
            setSavedNotice("模型版本已保存，正在测试…");
            await testVersion(saved);
          }}
        />
      )}
    </>
  );
}
