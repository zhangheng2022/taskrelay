import "./ui-dom";
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { useState } from "react";
import { render, fireEvent, cleanup, waitFor, act } from "@testing-library/react";
import { Composer } from "../packages/ui/src/chat-parts";
import { TaskCompose } from "../packages/ui/src/task-compose";
import { ModelSelector } from "../packages/ui/src/model-selector";
import { snapshot, transportWith, threadPage } from "./ui-fixtures";
import type { ThreadPage } from "../packages/ui/src/use-thread";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

test("新交办慢请求立即显示原文和发送状态，失败恢复输入，重试沿用请求且确认后只留一条", async () => {
  let resolvePost!: (value: unknown) => void, rejectPost!: (error: Error) => void;
  const ids: string[] = [];
  let page: ThreadPage = { ...threadPage };
  const transport = transportWith(async (method, path, body) => {
    if (path.split("?")[0] === "/api/user/threads") return page;
    if (method === "GET") return page;
    ids.push(body.requestId);
    return new Promise((resolve, reject) => {
      resolvePost = resolve;
      rejectPost = reject;
    });
  });
  const v = render(
    <TaskCompose
      transport={transport}
      snapshot={snapshot}
      offline={false}
      onSaved={async () => {}}
      onSettings={() => {}}
    />,
  );
  await waitFor(() => assert.equal(v.getByRole("textbox").hasAttribute("disabled"), false));
  const content = "帮我查看公开网页";
  fireEvent.change(v.getByRole("textbox"), { target: { value: content } });
  fireEvent.click(v.getByRole("button", { name: "发送消息" }));
  assert.ok(v.getByText(content));
  assert.ok(v.getByText("正在发送…"));
  await waitFor(() => assert.equal(ids.length, 1));
  await act(async () => rejectPost(Error("REQUEST_UNCONFIRMED")));
  assert.equal(v.queryByText("正在发送…"), null);
  assert.equal((v.getByRole("textbox") as HTMLTextAreaElement).value, content);
  fireEvent.click(v.getByRole("button", { name: "发送消息" }));
  assert.equal(ids.length, 2);
  assert.equal(ids[0], ids[1]);
  page = {
    ...page,
    activeTurn: "running",
    messages: [
      { id: "server-message", seq: 1, role: "user", content, at: new Date().toISOString() },
    ],
  };
  await act(async () => resolvePost(page));
  assert.equal(v.getAllByText(content).length, 1);
  assert.ok(v.getByText("正在处理交办…"));
});
test("交办通过消息启动，异步完成保留会话并允许继续补充", async () => {
  let page: any = { ...threadPage },
    listener: (() => void) | undefined;
  const sent: any[] = [],
    opened: string[] = [];
  const transport = {
    ...transportWith(async (method, path, body) => {
      if (path.split("?")[0] === "/api/user/threads") return page;
      if (method === "GET") return page;
      assert.ok(path.endsWith("/messages"));
      sent.push(body);
      page = { ...page, activeTurn: "working", status: "running" };
      return page;
    }),
    subscribe(fn: () => void) {
      listener = fn;
      return () => {
        listener = undefined;
      };
    },
  };
  const view = render(
    <TaskCompose
      transport={transport}
      snapshot={snapshot}
      offline={false}
      onSaved={async (id) => {
        opened.push(id);
      }}
      onSettings={() => {}}
    />,
  );
  await waitFor(() =>
    assert.equal(view.getByRole("button", { name: "发送消息" }).hasAttribute("disabled"), true),
  );
  fireEvent.change(view.getByRole("textbox"), { target: { value: "查看 https://example.com/" } });
  fireEvent.click(view.getByRole("button", { name: "发送消息" }));
  await waitFor(() => assert.equal(sent.length, 1));
  fireEvent.change(view.getByRole("textbox"), { target: { value: "这次只看今天" } });
  fireEvent.click(view.getByRole("button", { name: "发送消息" }));
  await waitFor(() => assert.equal(sent.length, 2));
  assert.notEqual(sent[0].requestId, sent[1].requestId);
  assert.equal(view.queryByRole("button", { name: "创建并试运行" }), null);
  page = { ...page, taskId: "created-task", activeTurn: null, status: "done" };
  await waitFor(() => assert.ok(listener));
  await act(async () => listener!());
  await waitFor(() => assert.deepEqual(opened, ["created-task"]));
});
test("pending input stays focused and read-only, and accepts another message after completion", () => {
  let sends = 0;
  const props = {
    text: "任务",
    setText: () => {},
    onSend: () => sends++,
    placeholder: "任务",
  };
  const view = render(<Composer {...props} busy={false} />);
  const input = view.getByRole("textbox") as HTMLTextAreaElement;
  input.focus();
  view.rerender(<Composer {...props} busy />);
  assert.equal(document.activeElement, input);
  assert.equal(input.disabled, false);
  assert.equal(input.readOnly, true);
  fireEvent.keyDown(input, { key: "Enter" });
  assert.equal(sends, 0);
  view.rerender(<Composer {...props} busy={false} />);
  assert.equal(document.activeElement, input);
  fireEvent.keyDown(input, { key: "Enter" });
  assert.equal(sends, 1);
});
test("composer sends once on Enter; Shift+Enter and IME composition never send", () => {
  let sends = 0;
  function Input() {
    const [text, setText] = useState("任务");
    return (
      <Composer
        text={text}
        setText={setText}
        onSend={() => sends++}
        busy={false}
        placeholder="任务"
      />
    );
  }
  const view = render(<Input />),
    input = view.getByRole("textbox");
  fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
  fireEvent.keyDown(input, { key: "Enter", isComposing: true });
  fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
  assert.equal(sends, 0);
  fireEvent.keyDown(input, { key: "Enter" });
  assert.equal(sends, 1);
  fireEvent.click(view.getByRole("button", { name: "发送消息" }));
  assert.equal(sends, 2);
});

test("消息响应丢失重试保留相同请求，不另建确认请求", async () => {
  const writes: unknown[] = [];
  const transport = transportWith(async (method, path, body) => {
    if (path.split("?")[0] === "/api/user/threads")
      return method === "GET" ? { items: [], nextCursor: null } : threadPage;
    if (method === "GET") return threadPage;
    assert.ok(path.endsWith("/messages"));
    writes.push(structuredClone(body));
    throw Error("NETWORK_ERROR");
  });
  const view = render(
    <TaskCompose
      transport={transport}
      snapshot={snapshot}
      offline={false}
      onSaved={async () => {}}
      onSettings={() => {}}
    />,
  );
  await waitFor(() => assert.equal(view.getByRole("textbox").hasAttribute("disabled"), false));
  fireEvent.change(view.getByRole("textbox"), { target: { value: "查看 https://example.com/" } });
  fireEvent.click(view.getByRole("button", { name: "发送消息" }));
  await waitFor(() => assert.equal(writes.length, 1));
  await waitFor(() =>
    assert.equal(view.getByRole("button", { name: "发送消息" }).hasAttribute("disabled"), false),
  );
  fireEvent.click(view.getByRole("button", { name: "发送消息" }));
  await waitFor(() => assert.equal(writes.length, 2));
  assert.deepEqual(writes[0], writes[1]);
});
test("model selector keeps arbitrary names and disables profiles without required capabilities", async () => {
  let selected = "";
  const models = [
    snapshot.models[0],
    {
      ...snapshot.models[0],
      id: "bad",
      name: "未测试",
      capabilities: { ...snapshot.models[0].capabilities, tools: false },
    },
  ];
  const view = render(
    <ModelSelector
      models={models}
      value="model-ui"
      onChange={(id) => {
        selected = id;
      }}
    />,
  );
  fireEvent.keyDown(view.getByRole("button"), { key: "ArrowDown" });
  const items = await view.findAllByRole("menuitemradio");
  assert.match(items[0].textContent ?? "", /non-gpt/);
  assert.equal(items[1].getAttribute("aria-disabled"), "true");
  fireEvent.click(items[1]);
  assert.equal(selected, "");
});
