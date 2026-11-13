import "./ui-dom";
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { App } from "../packages/ui/src/app";
import { createFixtureTransport } from "../apps/web/src/ui-fixture-transport";
import type { Transport } from "../packages/contracts/src/index";

Object.defineProperties(globalThis, {
  location: { configurable: true, value: window.location },
  history: { configurable: true, value: window.history },
});
afterEach(() => {
  cleanup();
  history.replaceState(null, "", "/");
  localStorage.clear();
});

function fixture(search: string) {
  const adapter = createFixtureTransport(new URLSearchParams(search));
  const creates: unknown[] = [];
  const transport: Transport = {
    async request<T>(method: string, path: string, body?: unknown) {
      if (method === "POST" && path.split("?")[0] === "/api/user/threads") creates.push(body);
      return adapter.request<T>(method, path, body);
    },
  };
  return { transport, creates };
}

for (const state of ["challenge", "failed"]) {
  test(`实际 App 通过当前创建合同显示 ${state} 夹具的历史和正文`, async () => {
    history.replaceState(null, "", "/#demo_task");
    const { transport, creates } = fixture(`state=${state}&history`);
    const view = render(<App transport={transport} />);
    await view.findByText("第 1 条任务询问", {}, { timeout: 2500 });
    assert.ok(view.getByText(/第 24 条演示回复/));
    assert.equal(view.getAllByText(/第 \d+ 条(?:演示回复|任务询问)/).length, 24);
    assert.deepEqual(creates, [{ modelId: "fixture_model", taskId: "demo_task" }]);
    if (state === "challenge") {
      assert.ok(view.getByText("请在同一聊天提供登录所需信息，或说明下一步要求。"));
      assert.ok(view.getByText("等待你的回复"));
    } else {
      assert.ok(view.getByText("演示结果：页面信息已整理。"));
    }
  });
}

test("新建任务从空白开始，刷新明确的会话地址可恢复问答", async () => {
  const { transport, creates } = fixture("state=new&history");
  let view = render(<App transport={transport} />);
  const input = await view.findByRole("textbox", { name: "任务需求" });
  assert.deepEqual(creates, []);
  fireEvent.change(input, { target: { value: "之前的普通问答" } });
  fireEvent.click(view.getByRole("button", { name: "发送消息" }));
  await view.findByText(/这是界面演示回复/);
  assert.deepEqual(creates, [{ modelId: "fixture_model" }]);
  const previous = location.hash;
  assert.match(previous, /^#chat\//);
  view.unmount();
  view = render(<App transport={transport} />);
  await view.findByText("之前的普通问答");
  fireEvent.click(view.getByRole("button", { name: "新建任务" }));
  await waitFor(() => assert.equal(location.hash, ""));
  assert.equal(view.queryByText("之前的普通问答"), null);
  assert.equal(view.queryByText("第 1 条任务询问"), null);
  fireEvent.change(view.getByRole("textbox", { name: "任务需求" }), {
    target: { value: "这次的新问题" },
  });
  fireEvent.click(view.getByRole("button", { name: "发送消息" }));
  await view.findByText(/这是界面演示回复/);
  assert.equal(creates.length, 2);
  assert.notEqual(location.hash, previous);
  assert.equal(view.queryByText("之前的普通问答"), null);
});
