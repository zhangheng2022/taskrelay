import "./ui-dom";
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { render, fireEvent, cleanup, waitFor, within } from "@testing-library/react";
import { Conversation } from "../packages/ui/src/conversation";
import { task, snapshot, run, transportWith, threadPage } from "./ui-fixtures";
import type { ThreadPage } from "../packages/ui/src/use-thread";

afterEach(cleanup);

test("旧会话按任务查找，选择可用模型后保留历史与草稿，刷新仍打开同一会话", async () => {
  let page: ThreadPage = {
    ...threadPage,
    modelId: "disabled-model",
    messages: [{ id: "old", seq: 1, role: "assistant", content: "历史回答", at: "2026-11-12" }],
  };
  const models = [
    { ...snapshot.models[0], id: "disabled-model", name: "旧模型", enabled: false },
    { ...snapshot.models[0], id: "new-model", name: "可用模型", enabled: true },
  ];
  const writes: string[] = [];
  const transport = transportWith(async (method, path, body) => {
    if (path.split("?")[0] === "/api/user/threads") {
      assert.equal(method, "GET", "切换后不得另建会话");
      assert.equal(new URL(path, "https://fixture.invalid").searchParams.has("modelId"), false);
      return {
        items: [{ id: page.id, model_id: page.modelId, task_id: task.id }],
        nextCursor: null,
      };
    }
    if (method === "PUT") {
      writes.push(path);
      assert.deepEqual(body, { modelId: "new-model", expectedVersion: 0 });
      page = { ...page, modelId: body.modelId, version: 1 };
    }
    return page;
  });
  const props = { transport, task, models, run: null, offline: false, refresh: async () => {} };
  const v = render(<Conversation {...props} />);
  await v.findByText("历史回答");
  const trigger = v.getByRole("button", { name: "使用的模型" });
  assert.equal((trigger as HTMLButtonElement).disabled, false);
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  const menu = await within(document.body).findByRole("menu");
  assert.equal(
    within(menu).getByRole("menuitemradio", { name: /旧模型/ }).getAttribute("aria-disabled"),
    "true",
  );
  fireEvent.click(within(menu).getByRole("menuitemradio", { name: /可用模型/ }));
  await waitFor(() => assert.match(trigger.textContent!, /可用模型/));
  assert.equal(writes.length, 1);
  assert.ok(v.getByText("历史回答"));
  fireEvent.change(v.getByRole("textbox"), { target: { value: "继续我的任务" } });
  assert.equal((v.getByRole("textbox") as HTMLTextAreaElement).value, "继续我的任务");
  v.unmount();
  const reopened = render(<Conversation {...props} />);
  await reopened.findByText("历史回答");
  assert.match(reopened.getByRole("button", { name: "使用的模型" }).textContent!, /可用模型/);
  assert.equal(writes.length, 1);
});

test("执行中和离线禁用模型切换；切换失败保留当前模型和输入草稿", async () => {
  const page = { ...threadPage };
  const models = [
    snapshot.models[0],
    { ...snapshot.models[0], id: "new-model", name: "另一模型" },
  ];
  const transport = transportWith(async (method, path) => {
    if (path.split("?")[0] === "/api/user/threads")
      return {
        items: [{ id: page.id, model_id: page.modelId, task_id: task.id }],
        nextCursor: null,
      };
    if (method === "PUT") throw Error("THREAD_MODEL_CONFLICT");
    return page;
  });
  const props = { transport, task, models, refresh: async () => {} };
  const v = render(<Conversation {...props} run={run} offline={false} />);
  await v.findByText("等待你的回复");
  const trigger = () => v.getByRole("button", { name: "使用的模型" }) as HTMLButtonElement;
  assert.equal(trigger().disabled, true);
  v.rerender(<Conversation {...props} run={null} offline />);
  assert.equal(trigger().disabled, true);
  v.rerender(<Conversation {...props} run={null} offline={false} />);
  fireEvent.change(v.getByRole("textbox"), { target: { value: "保留草稿" } });
  fireEvent.keyDown(trigger(), { key: "ArrowDown" });
  const menu = await within(document.body).findByRole("menu");
  fireEvent.click(within(menu).getByRole("menuitemradio", { name: /另一模型/ }));
  await v.findByText(/暂时无法切换模型/);
  assert.match(trigger().textContent!, /自定义/);
  assert.equal((v.getByRole("textbox") as HTMLTextAreaElement).value, "保留草稿");
});
