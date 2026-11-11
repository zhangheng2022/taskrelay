import "./ui-dom";
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { render, fireEvent, cleanup, waitFor, act } from "@testing-library/react";
import { App } from "../packages/ui/src/app";
import { HistoryCleanup } from "../packages/ui/src/history-cleanup";
import { task, snapshot, transportWith, threadPage } from "./ui-fixtures";

Object.defineProperties(globalThis, {
  location: { configurable: true, value: window.location },
  history: { configurable: true, value: window.history },
});
afterEach(() => {
  cleanup();
  history.replaceState(null, "", "/");
});
const job = { id: "job", status: "pending", completed: 0, total: 3, error: null };

test("删除接受后迟到的列表翻页不能重新显示已删除历史", async () => {
  history.replaceState(null, "", "/#" + task.id);
  let deleted = false,
    resolvePage!: (value: unknown) => void;
  const pending = new Promise((resolve) => {
    resolvePage = resolve;
  });
  const transport = transportWith(async (method, path) => {
    if (path === "/api/user/snapshot")
      return {
        ...snapshot,
        tasks: deleted ? [] : [task],
        nextTasksCursor: deleted ? null : "older",
      };
    if (path.startsWith("/api/user/tasks?")) return pending;
    if (path.includes("preview")) return { chats: 1, active: 0 };
    if (path === "/api/user/history-cleanups") {
      if (method === "GET") return [];
      deleted = true;
      return job;
    }
    if (method === "GET" && path.split("?")[0] === "/api/user/threads")
      return {
        items: deleted ? [] : [{ id: threadPage.id, task_id: task.id, model_id: task.modelId }],
        nextCursor: null,
      };
    return { ...threadPage, taskId: deleted ? null : task.id };
  });
  const view = render(<App transport={transport} />);
  fireEvent.click(await view.findByRole("button", { name: "加载更多任务" }));
  fireEvent.keyDown(await view.findByRole("button", { name: "任务操作" }), { key: "Enter" });
  fireEvent.click(await view.findByRole("menuitem", { name: "删除聊天" }));
  const confirm = await view.findByRole("button", { name: "确认删除聊天" });
  await waitFor(() => assert.equal(confirm.hasAttribute("disabled"), false));
  fireEvent.click(confirm);
  await waitFor(() => assert.equal(location.hash, ""));
  await act(async () =>
    resolvePage({
      items: [{ ...task, id: "removed-old", title: "不可复活的旧任务" }],
      nextCursor: null,
    }),
  );
  assert.equal(view.queryByText("不可复活的旧任务"), null);
});

test("清理须确认，失败重试复用请求 ID，重复点击不并发提交", async () => {
  const bodies: unknown[] = [];
  let resolve!: (value: unknown) => void,
    accepted = 0,
    closed = 0;
  const transport = transportWith(async (method, path, body) => {
    if (path.includes("preview")) return { chats: 7, active: 2 };
    if (method === "GET") return [];
    bodies.push(body);
    if (bodies.length === 1) throw Error("网络中断");
    return new Promise((r) => {
      resolve = r;
    });
  });
  const v = render(
    <HistoryCleanup
      transport={transport}
      selection={{ scope: "all", requestId: "same" }}
      onClose={() => {
        closed++;
      }}
      onAccepted={async () => {
        accepted++;
      }}
    />,
  );
  await waitFor(() => assert.ok(v.getByText(/将停止 2 项/)));
  assert.equal(bodies.length, 0);
  assert.equal(document.activeElement, v.getByRole("button", { name: "取消" }));
  fireEvent.click(v.getByRole("button", { name: "确认清理全部聊天" }));
  const retry = await v.findByRole("button", { name: "重试清理" });
  fireEvent.click(retry);
  fireEvent.click(retry);
  await waitFor(() => assert.equal(bodies.length, 2));
  assert.deepEqual(bodies[0], bodies[1]);
  assert.equal(closed, 0);
  await act(async () => resolve(job));
  await waitFor(() => assert.equal(accepted, 1));
  assert.equal(closed, 1);
});

test("删除其他聊天保留当前输入，删除当前聊天才返回新任务", async () => {
  history.replaceState(null, "", "/#" + task.id);
  const other = { ...task, id: "other", title: "另一个聊天" };
  let tasks = [task, other];
  const writes: any[] = [];
  const transport = transportWith(async (method, path, body) => {
    if (path === "/api/user/snapshot") return { ...snapshot, tasks, runs: [] };
    if (path.includes("preview")) return { chats: 1, active: 0 };
    if (path === "/api/user/history-cleanups") {
      if (method === "GET") return [];
      writes.push(body);
      tasks = tasks.filter((t) => t.id !== body.targetId);
      return job;
    }
    if (path.split("?")[0] === "/api/user/threads" && method === "GET")
      return {
        items: [{ id: threadPage.id, model_id: task.modelId, task_id: task.id }],
        nextCursor: null,
      };
    return { ...threadPage, taskId: task.id };
  });
  const v = render(<App transport={transport} />);
  await waitFor(() =>
    assert.equal(v.getByRole("textbox", { name: "消息" }).hasAttribute("disabled"), false),
  );
  fireEvent.change(v.getByRole("textbox", { name: "消息" }), { target: { value: "保留这段草稿" } });
  fireEvent.keyDown(v.getByRole("button", { name: "操作：另一个聊天" }), { key: "Enter" });
  fireEvent.click(await v.findByRole("menuitem", { name: "删除聊天" }));
  fireEvent.click(await v.findByRole("button", { name: "确认删除聊天" }));
  await waitFor(() => assert.equal(writes.length, 1));
  await waitFor(() => assert.ok(!v.queryByRole("alertdialog")));
  assert.equal(
    (v.getByRole("textbox", { name: "消息" }) as HTMLTextAreaElement).value,
    "保留这段草稿",
  );
  assert.equal(location.hash, "#" + task.id);
  fireEvent.keyDown(v.getByRole("button", { name: "任务操作" }), { key: "Enter" });
  fireEvent.click(await v.findByRole("menuitem", { name: "删除聊天" }));
  await waitFor(() =>
    assert.equal(v.getByRole("button", { name: "确认删除聊天" }).hasAttribute("disabled"), false),
  );
  fireEvent.click(v.getByRole("button", { name: "确认删除聊天" }));
  await waitFor(() => assert.equal(location.hash, ""));
  assert.equal(writes.length, 2);
});

test("发送未完成时从顶部清空，旧请求结束后新会话仍可发送", async () => {
  history.replaceState(null, "", "/#" + task.id);
  let finish!: (value: unknown) => void,
    cleared = false;
  const writes: string[] = [];
  const transport = transportWith(async (method, path) => {
    if (path === "/api/user/snapshot") return { ...snapshot, runs: [] };
    if (path.includes("preview")) return { chats: 1, active: 0 };
    if (path === "/api/user/history-cleanups") {
      if (method === "GET") return [];
      cleared = true;
      return job;
    }
    const page = {
      ...threadPage,
      id: cleared ? "new-thread" : threadPage.id,
      taskId: task.id,
      messages: [],
    };
    if (path.split("?")[0] === "/api/user/threads" && method === "GET")
      return {
        items: [{ id: page.id, model_id: task.modelId, task_id: task.id }],
        nextCursor: null,
      };
    if (method === "POST" && path.endsWith("/messages")) {
      writes.push(path);
      if (writes.length === 1)
        return new Promise((r) => {
          finish = r;
        });
    }
    return page;
  });
  const v = render(<App transport={transport} />);
  await waitFor(() =>
    assert.equal(v.getByRole("textbox", { name: "消息" }).hasAttribute("disabled"), false),
  );
  fireEvent.change(v.getByRole("textbox", { name: "消息" }), { target: { value: "旧消息" } });
  fireEvent.click(v.getByRole("button", { name: "发送消息" }));
  await waitFor(() => assert.equal(writes.length, 1));
  fireEvent.keyDown(v.getByRole("button", { name: "任务操作" }), { key: "Enter" });
  fireEvent.click(await v.findByRole("menuitem", { name: "清空当前聊天" }));
  await waitFor(() =>
    assert.equal(
      v.getByRole("button", { name: "确认清空当前聊天" }).hasAttribute("disabled"),
      false,
    ),
  );
  fireEvent.click(v.getByRole("button", { name: "确认清空当前聊天" }));
  await waitFor(() => assert.ok(!v.queryByRole("alertdialog")));
  await act(async () => finish(threadPage));
  fireEvent.change(v.getByRole("textbox", { name: "消息" }), { target: { value: "新消息" } });
  fireEvent.click(v.getByRole("button", { name: "发送消息" }));
  await waitFor(() => assert.equal(writes.length, 2));
  assert.equal(writes[1], "/api/user/threads/new-thread/messages");
});
