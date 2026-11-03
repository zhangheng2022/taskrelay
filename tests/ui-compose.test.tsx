import "./ui-dom";
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { useState } from "react";
import { render, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { Composer } from "../packages/ui/src/chat-parts";
import { TaskCompose } from "../packages/ui/src/task-compose";
import { ModelSelector } from "../packages/ui/src/model-selector";
import { snapshot, task, transportWith } from "./ui-fixtures";

afterEach(() => {
  cleanup();
  localStorage.clear();
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

test("suggestion sends a real compose request, shows pending turn, and requires explicit creation", async () => {
  const calls: { path: string; body: any }[] = [];
  let resolve!: (value: unknown) => void;
  const transport = transportWith(async (_method, path, body) => {
    calls.push({ path, body });
    return new Promise((r) => {
      resolve = r;
    });
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
  fireEvent.click(view.getByRole("button", { name: "监测页面是否发生变化" }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.messages[0].content, "监测页面是否发生变化");
  assert.ok(view.getByRole("status"));
  assert.equal(view.queryByText("今天想交给 TaskRelay 什么任务？"), null);
  resolve({ reply: "请确认范围", task });
  await view.findByRole("button", { name: "创建并试运行" });
  assert.equal(calls.length, 1);
});

test("ambiguous task creation retries exactly the same payload/id and locks editing", async () => {
  const writes: unknown[] = [];
  const transport = transportWith(async (_method, path, body) => {
    if (path.endsWith("compose")) return { reply: "请确认", task };
    writes.push(structuredClone(body));
    throw new Error("NETWORK_ERROR");
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
  fireEvent.change(view.getByRole("textbox"), {
    target: { value: "检查 https://example.com" },
  });
  fireEvent.click(view.getByRole("button", { name: "发送消息" }));
  fireEvent.click(await view.findByRole("button", { name: "创建并试运行" }));
  await waitFor(() =>
    assert.equal(
      view.getByRole("button", { name: "重试确认" }).hasAttribute("disabled"),
      false,
    ),
  );
  assert.ok(
    view.getByRole("button", { name: "编辑配置" }).hasAttribute("disabled"),
  );
  fireEvent.click(view.getByRole("button", { name: "重试确认" }));
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
