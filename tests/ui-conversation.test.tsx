import "./ui-dom";
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { render, fireEvent, cleanup, waitFor, act } from "@testing-library/react";
import { Conversation } from "../packages/ui/src/conversation";
import { task, run, transportWith, threadPage } from "./ui-fixtures";
import type { ThreadPage } from "../packages/ui/src/use-thread";
import { createWebTransport } from "../apps/web/src/transport";
afterEach(cleanup);

test("发送确认沿用同一动画状态行，不把历史消息重新注册为滚动锚点", async () => {
  let resolvePost!: (value: unknown) => void;
  let page: ThreadPage = {
    ...threadPage,
    activeTurn: "turn",
    messages: Array.from({ length: 24 }, (_, i) => ({
      id: `history-${i}`,
      seq: i + 1,
      role: i % 2 ? "assistant" : "user",
      content: `历史 ${i}`,
      at: new Date(1700000000000 + i * 1000).toISOString(),
    })),
  };
  const transport = transportWith(async (method, path) => {
    if (path === "/api/user/threads")
      return [{ id: page.id, model_id: task.modelId, task_id: task.id }];
    if (method === "POST")
      return new Promise((resolve) => {
        resolvePost = resolve;
      });
    return page;
  });
  const v = render(
    <Conversation
      transport={transport}
      task={task}
      run={null}
      offline={false}
      refresh={async () => {}}
    />,
  );
  await waitFor(() => assert.ok(v.getByText("云端助手正在处理…")));
  const status = v.getByRole("status"),
    spinner = status.querySelector(".chat-status-spinner");
  assert.ok(spinner);
  assert.equal(spinner.tagName, "SPAN");
  assert.equal(
    status.closest("[data-message-id]")?.className.includes("content-visibility:auto"),
    false,
  );
  fireEvent.change(v.getByRole("textbox"), { target: { value: "继续查看" } });
  fireEvent.click(v.getByRole("button", { name: "发送消息" }));
  assert.equal(v.getByRole("status"), status);
  assert.ok(v.getByText("正在发送…"));
  page = {
    ...page,
    messages: [
      ...page.messages,
      { id: "confirmed", seq: 25, role: "user", content: "继续查看", at: new Date().toISOString() },
    ],
  };
  await act(async () => resolvePost(page));
  assert.equal(v.getByRole("status"), status);
  assert.equal(status.querySelector(".chat-status-spinner"), spinner);
  assert.ok(v.getByText("云端助手正在处理…"));
  assert.equal(v.getAllByText("继续查看").length, 1);
  assert.equal(v.container.querySelectorAll('[data-scroll-anchor="true"]').length, 0);
});

test("刷新失败和离线不继续显示旧的云端处理中，恢复后以新状态收尾", async () => {
  let notify: (() => void) | undefined,
    failed = false;
  let page: ThreadPage = { ...threadPage, activeTurn: "turn" };
  const transport = transportWith(async (_method, path) => {
    if (path === "/api/user/threads")
      return [{ id: page.id, model_id: task.modelId, task_id: task.id }];
    if (failed) throw Error("OFFLINE");
    return page;
  });
  transport.subscribe = (fn) => {
    notify = fn;
    return () => {};
  };
  const props = { transport, task, run: null, refresh: async () => {} };
  const v = render(<Conversation {...props} offline={false} />);
  await waitFor(() => assert.ok(v.getByText("云端助手正在处理…")));
  // 订阅在 effect 中建立，通知回调本身不返回刷新 Promise；分别等订阅和真实错误状态。
  await waitFor(() => assert.equal(typeof notify, "function"));
  failed = true;
  await act(async () => notify!());
  await waitFor(() => assert.ok(v.getByText("状态更新失败，请重试")));
  assert.equal(v.queryByText("云端助手正在处理…"), null);
  assert.equal(v.getByRole("status").querySelector(".chat-status-spinner"), null);
  v.rerender(<Conversation {...props} offline />);
  assert.ok(v.getByText("连接已中断，等待恢复后更新状态"));
  failed = false;
  page = {
    ...page,
    activeTurn: null,
    messages: [
      {
        id: "answer",
        seq: 1,
        role: "assistant",
        content: "处理完成",
        at: new Date().toISOString(),
      },
    ],
  };
  v.rerender(<Conversation {...props} offline={false} />);
  await act(async () => notify!());
  await waitFor(() => assert.ok(v.getByText("处理完成")));
  assert.equal(v.queryByRole("status"), null);
});

test("发送立即回显及显示发送中，写入期间通知合并并在返回后补读，不等轮询也不重复消息", async () => {
  let notify = () => {},
    resolvePost!: (value: unknown) => void,
    reads = 0;
  const sent = "请查询最新结果";
  const user = {
    id: "accepted",
    seq: 1,
    role: "user",
    content: sent,
    at: new Date().toISOString(),
  };
  const accepted = { ...threadPage, messages: [user], activeTurn: "turn", waiting: null };
  let latest: ThreadPage = { ...threadPage, waiting: { id: "help", request: "{}" } };
  const transport = transportWith(async (method, path) => {
    if (path === "/api/user/threads")
      return [{ id: latest.id, model_id: task.modelId, task_id: task.id }];
    if (method === "POST")
      return new Promise((resolve) => {
        resolvePost = resolve;
      });
    reads++;
    return latest;
  });
  transport.subscribe = (fn) => {
    notify = fn;
    return () => {};
  };
  const v = render(
    <Conversation
      transport={transport}
      task={task}
      run={run}
      offline={false}
      refresh={async () => {}}
    />,
  );
  await waitFor(() => assert.equal(v.getByRole("textbox").hasAttribute("disabled"), false));
  fireEvent.change(v.getByRole("textbox"), { target: { value: sent } });
  fireEvent.click(v.getByRole("button", { name: "发送消息" }));
  assert.equal(v.getAllByText(sent).length, 1);
  assert.ok(v.getByText("正在发送…"));
  assert.equal(v.queryByText("等待你的回复"), null);
  await act(async () => {
    notify();
    notify();
  });
  assert.equal(reads, 1);
  latest = {
    ...accepted,
    activeTurn: null,
    messages: [
      user,
      {
        id: "answer",
        seq: 2,
        role: "assistant",
        content: "已收到最新结果",
        at: new Date().toISOString(),
      },
    ],
  };
  await act(async () => resolvePost(accepted));
  await waitFor(() => assert.ok(v.getByText("已收到最新结果")));
  assert.equal(reads, 2);
  assert.equal(v.getAllByText(sent).length, 1);
  assert.equal(v.queryByText("正在发送…"), null);
});

test("读取期间到达的新通知在读取结束后补读，不能丢失最后一次更新", async () => {
  let notify = () => {},
    resolveRead!: (value: unknown) => void,
    reads = 0;
  const page = { ...threadPage, messages: [] };
  const transport = transportWith(async (_method, path) => {
    if (path === "/api/user/threads")
      return [{ id: page.id, model_id: task.modelId, task_id: task.id }];
    reads++;
    if (reads === 2)
      return new Promise((resolve) => {
        resolveRead = resolve;
      });
    return reads === 1
      ? page
      : {
          ...page,
          messages: [
            {
              id: "new-result",
              seq: 1,
              role: "assistant",
              content: "第二次通知的新结果",
              at: new Date().toISOString(),
            },
          ],
        };
  });
  transport.subscribe = (fn) => {
    notify = fn;
    return () => {};
  };
  const v = render(
    <Conversation
      transport={transport}
      task={task}
      run={run}
      offline={false}
      refresh={async () => {}}
    />,
  );
  await waitFor(() => assert.equal(v.getByRole("textbox").hasAttribute("disabled"), false));
  await act(async () => notify());
  await act(async () => notify());
  assert.equal(reads, 2);
  await act(async () => resolveRead(page));
  await waitFor(() => assert.ok(v.getByText("第二次通知的新结果")));
  assert.equal(reads, 3);
});

test("执行过程稳定合并八次读取，刷新不重复，展开保留全部记录和独立问题及结果", async () => {
  let notify = () => {};
  const events = Array.from({ length: 8 }, (_, i) => ({
    id: `progress_${i}`,
    seq: i + 1,
    role: "assistant",
    source: "executor",
    run_id: run.id,
    content: "已读取当前页面信息。",
    at: `2026-11-05T12:30:0${i}.000Z`,
    parts: [{ type: "tool" as const, name: "extract", result: `第 ${i + 1} 次的真实反馈` }],
  }));
  const page = {
    ...threadPage,
    messages: [
      ...events,
      {
        id: "question",
        seq: 9,
        role: "assistant",
        source: "cloud",
        run_id: run.id,
        content: "请补充验证码",
        at: "2026-11-05T12:31:00.000Z",
      },
      {
        id: `final_${run.id}`,
        seq: 10,
        role: "assistant",
        source: "executor",
        run_id: run.id,
        content: "本次结果已核对",
        at: "2026-11-05T12:32:00.000Z",
      },
    ],
  };
  const transport = transportWith(async (_method, path) =>
    path === "/api/user/threads"
      ? [{ id: page.id, model_id: task.modelId, task_id: task.id }]
      : page,
  );
  transport.subscribe = (fn) => {
    notify = fn;
    return () => {};
  };
  const v = render(
    <Conversation
      transport={transport}
      task={task}
      run={run}
      offline={false}
      refresh={async () => {}}
    />,
  );
  await waitFor(() => assert.ok(v.getByText("读取页面 8 次", { exact: false })));
  assert.equal(v.getAllByText("执行过程").length, 1);
  assert.equal(v.queryAllByText("已读取当前页面信息。").length, 0);
  assert.ok(v.getByText("请补充验证码"));
  assert.ok(v.getByText("本次结果已核对"));
  fireEvent.click(v.getByRole("button", { name: /执行过程\s*8 次调用/ }));
  assert.equal(v.getAllByText("已读取当前页面信息。").length, 8);
  fireEvent.click(v.getAllByRole("button", { name: "已读取当前页面信息。" })[7]);
  assert.ok(v.getByText("第 8 次的真实反馈"));
  await act(async () => notify());
  await waitFor(() => assert.equal(v.getAllByText("已读取当前页面信息。").length, 8));
  assert.equal(v.getAllByText("执行过程").length, 1);
});

test("响应丢失后收到空闲会话通知，重试仍使用原 requestId", async () => {
  const ids: string[] = [];
  let notify = () => {};
  let page: ThreadPage = { ...threadPage, taskId: task.id, activeTurn: null };
  const transport = transportWith(async (method, path, body) => {
    if (path === "/api/user/threads")
      return [{ id: page.id, model_id: task.modelId, task_id: task.id }];
    if (method === "POST" && path.endsWith("/messages")) {
      ids.push(body.requestId);
      page = {
        ...page,
        messages: [
          {
            id: "accepted",
            seq: 1,
            role: "user",
            content: body.content,
            at: new Date().toISOString(),
          },
        ],
      };
      if (ids.length === 1) throw Error("REQUEST_UNCONFIRMED");
    }
    return page;
  });
  transport.subscribe = (fn) => {
    notify = fn;
    return () => {};
  };
  const view = render(
    <Conversation
      transport={transport}
      task={task}
      run={run}
      offline={false}
      refresh={async () => {}}
    />,
  );
  await waitFor(() => assert.equal(view.getByRole("textbox").hasAttribute("disabled"), false));
  fireEvent.change(view.getByRole("textbox"), { target: { value: "继续当前任务" } });
  fireEvent.click(view.getByRole("button", { name: "发送消息" }));
  await waitFor(() =>
    assert.equal((view.getByRole("textbox") as HTMLTextAreaElement).value, "继续当前任务"),
  );
  await act(async () => notify());
  await waitFor(() =>
    assert.ok(view.getByText("继续当前任务", { selector: "div.whitespace-pre-wrap" })),
  );
  fireEvent.click(view.getByRole("button", { name: "发送消息" }));
  await waitFor(() => assert.equal(ids.length, 2));
  assert.equal(ids[0], ids[1]);
});

test("统一聊天：协助和补充都使用同一个输入框与消息入口", async () => {
  const writes: any[] = [];
  let page: any = {
    ...threadPage,
    taskId: task.id,
    waiting: { id: "help", request: "{}" },
    messages: [
      {
        id: "help-message",
        seq: 1,
        role: "assistant",
        source: "cloud",
        content: "请输入验证码",
        parts: [],
      },
    ],
  };
  const transport = transportWith(async (method, path, body) => {
    if (method === "GET" && path === "/api/user/threads")
      return [{ id: page.id, model_id: task.modelId, task_id: task.id }];
    if (method === "POST" && path.endsWith("/messages")) {
      writes.push({ path, body });
      page = {
        ...page,
        waiting: null,
        messages: [
          ...page.messages,
          { id: "reply", seq: 2, role: "user", content: body.content, parts: [] },
        ],
      };
    }
    return page;
  });
  const v = render(
    <Conversation
      transport={transport}
      task={task}
      run={run}
      offline={false}
      refresh={async () => {}}
    />,
  );
  await waitFor(() => assert.ok(v.getByText("请输入验证码")));
  assert.equal(v.getAllByRole("textbox").length, 1);
  assert.equal(v.queryByRole("combobox", { name: "消息用途" }), null);
  fireEvent.change(v.getByRole("textbox"), { target: { value: "0012Ab" } });
  fireEvent.click(v.getByRole("button", { name: "发送消息" }));
  await waitFor(() => assert.equal(writes.length, 1));
  assert.deepEqual(Object.keys(writes[0].body).sort(), ["content", "requestId"]);
  assert.equal(writes[0].body.content, "0012Ab");
});
test("截图直接显示在聊天，不渲染旧运行事件卡；停止不调用模型消息", async () => {
  const writes: any[] = [];
  const page = {
    ...threadPage,
    taskId: task.id,
    messages: [
      {
        id: "image_message",
        seq: 1,
        role: "assistant",
        source: "executor",
        content: "当前页面",
        parts: [{ type: "image", artifactId: "image_one", alt: "执行现场" }],
      },
    ],
  };
  const transport = transportWith(async (method, path, body) => {
    if (method === "GET" && path === "/api/user/threads")
      return [{ id: page.id, model_id: task.modelId, task_id: task.id }];
    assert.ok(!path.includes("/artifacts/"), "图片不得经过 JSON 通道");
    if (method === "POST") writes.push({ path, body });
    return page;
  });
  const webTransport = createWebTransport();
  transport.artifactUrl = webTransport.artifactUrl!.bind(webTransport);
  const v = render(
    <Conversation
      transport={transport}
      task={task}
      run={{ ...run, status: "running" }}
      offline={false}
      refresh={async () => {}}
    />,
  );
  await waitFor(() => assert.ok(v.getByRole("img", { name: "执行现场" })));
  assert.equal(
    v.getByRole("img", { name: "执行现场" }).getAttribute("src"),
    "/api/user/artifacts/image_one",
  );
  assert.equal(v.queryByText(/页面快照 #/), null);
  fireEvent.click(v.getByRole("button", { name: "停止执行" }));
  await waitFor(() => assert.equal(writes.length, 1));
  assert.ok(writes[0].path.endsWith("/cancel"));
});

test("连续运行通知合并读取，不饿死聊天刷新", async () => {
  let notify: (() => void) | undefined,
    pending: ((value: any) => void) | undefined,
    reads = 0;
  const page = { ...threadPage, taskId: task.id, messages: [] };
  const transport = transportWith(async (_method, path) => {
    if (path === "/api/user/threads")
      return [{ id: page.id, model_id: task.modelId, task_id: task.id }];
    reads++;
    if (reads === 1) return page;
    return new Promise((resolve) => {
      pending = resolve;
    });
  });
  transport.subscribe = (fn) => {
    notify = fn;
    return () => {};
  };
  const v = render(
    <Conversation
      transport={transport}
      task={task}
      run={run}
      offline={false}
      refresh={async () => {}}
    />,
  );
  // 输入框启用发生在提交渲染时，通知订阅在后续 effect 中建立；必须等订阅就绪再模拟事件。
  await waitFor(() => assert.equal(typeof notify, "function"));
  await act(async () => {
    notify!();
    notify!();
    notify!();
  });
  assert.equal(reads, 2);
  await act(async () => {
    pending!({
      ...page,
      messages: [
        {
          id: "new",
          seq: 1,
          role: "assistant",
          source: "executor",
          content: "刚刚执行完成",
          parts: [],
        },
      ],
    });
  });
  await waitFor(() => assert.ok(v.getByText("刚刚执行完成")));
});
