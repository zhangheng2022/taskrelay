import "./ui-dom";
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { render, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { ModelConnections } from "../packages/ui/src/model-connections";
import { transportWith } from "./ui-fixtures";
import type { ModelConnection } from "../packages/contracts/src/index";
afterEach(cleanup);

const connection: ModelConnection = {
  id: "conn_delete",
  name: "验收服务",
  kind: "workers-ai",
  gatewayProvider: "workers-ai",
  keyAlias: null,
  bindingVerified: true,
  defaultRegion: "auto",
};

test("删除服务默认取消，明确确认后单次提交并刷新列表", async () => {
  let connections = [connection],
    writes = 0;
  let finish: (() => void) | undefined;
  const transport = transportWith(async (method, path) => {
    if (method === "GET") return { name: connection.name, referenceCount: 0, references: [] };
    assert.equal(path, "/api/admin/model-connections/conn_delete");
    assert.equal(method, "DELETE");
    writes++;
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    connections = [];
    return { ok: true };
  });
  const refresh = async () => {
    view.rerender(
      <ModelConnections connections={connections} transport={transport} refresh={refresh} />,
    );
  };
  const view = render(
    <ModelConnections connections={connections} transport={transport} refresh={refresh} />,
  );
  const open = () => fireEvent.click(view.getByRole("button", { name: "删除服务：验收服务" }));
  open();
  await view.findByText("没有模型版本引用，可以删除。");
  let dialog = view.getByRole("alertdialog");
  assert.ok(
    document.activeElement === within(dialog).getByRole("button", { name: "取消" }),
    "确认框初始焦点应在取消按钮",
  );
  assert.match(dialog.textContent!, /Cloudflare 中的密钥、网关和自定义提供方配置会保留/);
  fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
  assert.equal(writes, 0);
  await waitFor(() =>
    assert.ok(document.activeElement === view.getByRole("button", { name: "删除服务：验收服务" })),
  );
  open();
  await view.findByText("没有模型版本引用，可以删除。");
  dialog = view.getByRole("alertdialog");
  const confirm = within(dialog).getByRole("button", { name: "永久删除服务" });
  fireEvent.click(confirm);
  fireEvent.click(confirm);
  await waitFor(() => assert.equal(writes, 1));
  assert.equal(
    (within(dialog).getByRole("button", { name: "取消" }) as HTMLButtonElement).disabled,
    true,
  );
  fireEvent.keyDown(dialog, { key: "Escape" });
  assert.ok(view.getByRole("alertdialog"));
  finish!();
  await waitFor(() => assert.ok(view.queryByText("验收服务") === null));
  assert.ok(view.queryByRole("alertdialog") === null);
  await waitFor(() =>
    assert.ok(document.activeElement === view.getByRole("button", { name: "添加服务" })),
  );
});

test("引用阻止删除，预览故障与提交冲突须重新检查", async () => {
  let reads = 0,
    writes = 0;
  const transport = transportWith(async (method) => {
    if (method === "DELETE") {
      writes++;
      throw Error("MODEL_CONNECTION_IN_USE");
    }
    reads++;
    if (reads === 1) throw Error("OFFLINE");
    return reads === 2 || reads === 4
      ? {
          name: connection.name,
          referenceCount: 1,
          references: [{ modelId: "model_x", name: "历史模型", version: 2 }],
        }
      : { name: connection.name, referenceCount: 0, references: [] };
  });
  const view = render(
    <ModelConnections connections={[connection]} transport={transport} refresh={async () => {}} />,
  );
  fireEvent.click(view.getByRole("button", { name: "删除服务：验收服务" }));
  await view.findByRole("alert");
  const disabled = () =>
    (view.getByRole("button", { name: "永久删除服务" }) as HTMLButtonElement).disabled;
  assert.equal(disabled(), true);
  fireEvent.click(view.getByRole("button", { name: "重新检查" }));
  await view.findByText("历史模型 · v2");
  assert.equal(disabled(), true);
  fireEvent.click(view.getByRole("button", { name: "重新检查" }));
  await view.findByText("没有模型版本引用，可以删除。");
  fireEvent.click(view.getByRole("button", { name: "永久删除服务" }));
  await view.findByText(/此服务仍被模型版本引用/);
  assert.equal(disabled(), true);
  assert.equal(writes, 1);
  fireEvent.click(view.getByRole("button", { name: "重新检查" }));
  await view.findByText("历史模型 · v2");
  assert.equal(writes, 1);
});

test("取消后迟到的预览不串到另一个服务", async () => {
  let resolveOld: ((value: unknown) => void) | undefined;
  const transport = transportWith(async (_method, path) => {
    if (path.includes("conn_delete/"))
      return new Promise((resolve) => {
        resolveOld = resolve;
      });
    return { name: "另一服务", referenceCount: 0, references: [] };
  });
  const view = render(
    <ModelConnections
      connections={[connection, { ...connection, id: "conn_other", name: "另一服务" }]}
      transport={transport}
      refresh={async () => {}}
    />,
  );
  fireEvent.click(view.getByRole("button", { name: "删除服务：验收服务" }));
  await view.findByText("正在检查关联模型…");
  fireEvent.click(view.getByRole("button", { name: "取消" }));
  fireEvent.click(view.getByRole("button", { name: "删除服务：另一服务" }));
  await view.findByText("没有模型版本引用，可以删除。");
  resolveOld!({
    name: "过期响应",
    referenceCount: 1,
    references: [{ modelId: "old", version: 1, name: "旧引用" }],
  });
  await waitFor(() => assert.match(view.getByRole("alertdialog").textContent!, /另一服务/));
  assert.equal(view.queryByText("旧引用 · v1"), null);
});
