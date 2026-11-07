import "./ui-dom";
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { render, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { App } from "../packages/ui/src/app";
import { task, run, snapshot, transportWith, threadPage } from "./ui-fixtures";

Object.defineProperties(globalThis, {
  location: { configurable: true, value: window.location },
  history: { configurable: true, value: window.history },
});
afterEach(() => {
  cleanup();
  history.replaceState(null, "", "/");
});

test("工作空间翻页绑定当前用户，旧请求不能混入新用户或锁住加载更多按钮", async () => {
  let resolveOld!: (value: unknown) => void;
  const oldPage = new Promise((resolve) => {
    resolveOld = resolve;
  });
  const a = transportWith(async (method, path) => {
    if (path === "/api/user/snapshot") return { ...snapshot, nextTasksCursor: "page-a" };
    if (path.startsWith("/api/user/tasks?")) return oldPage;
    if (method === "GET" && path.split("?")[0] === "/api/user/threads")
      return { items: [], nextCursor: null };
    return { ...threadPage, taskId: null };
  });
  const newTask = { ...task, id: "user-b", title: "用户 B 的任务" };
  const b = transportWith(async (method, path) => {
    if (path === "/api/user/snapshot")
      return { ...snapshot, tasks: [newTask], nextTasksCursor: "page-b" };
    if (path.startsWith("/api/user/tasks?"))
      return { items: [{ ...newTask, id: "older-b", title: "用户 B 较早任务" }], nextCursor: null };
    if (method === "GET" && path.split("?")[0] === "/api/user/threads")
      return { items: [], nextCursor: null };
    return { ...threadPage, taskId: null };
  });
  const view = render(<App transport={a} />);
  fireEvent.click(await view.findByRole("button", { name: "加载更多任务" }));
  await waitFor(() =>
    assert.equal(
      (view.getByRole("button", { name: "加载更多任务" }) as HTMLButtonElement).disabled,
      true,
    ),
  );
  view.rerender(<App transport={b} />);
  await view.findByText("用户 B 的任务");
  assert.equal(
    (view.getByRole("button", { name: "加载更多任务" }) as HTMLButtonElement).disabled,
    false,
  );
  resolveOld({
    items: [{ ...task, id: "private-a", title: "用户 A 私有旧任务" }],
    nextCursor: null,
  });
  fireEvent.click(view.getByRole("button", { name: "加载更多任务" }));
  await view.findByText("用户 B 较早任务");
  assert.equal(view.queryByText("用户 A 私有旧任务"), null);
});

test("从历史运行进入聊天仍停止当前运行，待协助来自当前协助记录", async () => {
  const writes: string[] = [];
  const current = { ...run, id: "current", status: "waiting_user" as const };
  const old = {
    ...run,
    id: "old",
    status: "succeeded" as const,
    result: { summary: "部分工作已处理", outcome: "reported" as const, evidence: [] },
  };
  const data = {
    ...snapshot,
    runs: [old, current],
    waitingHelp: [{ id: "help", taskId: task.id, runId: current.id }],
  };
  const page = { ...threadPage, taskId: task.id, messages: [], waiting: { id: "help" } };
  const transport = transportWith(async (method, path) => {
    if (path === "/api/user/snapshot") return data;
    if (path.split("?")[0] === "/api/user/threads")
      return method === "GET"
        ? { items: [{ id: page.id, task_id: task.id, model_id: task.modelId }], nextCursor: null }
        : page;
    if (method === "POST") writes.push(path);
    return page;
  });
  const v = render(<App transport={transport} />);
  await waitFor(() => assert.ok(v.getByText("待协助")));
  fireEvent.click(v.getByText("运行记录"));
  const oldResult = await v.findByText("已回复");
  fireEvent.click(oldResult.closest("button")!);
  const stop = await v.findByRole("button", { name: "停止执行" });
  fireEvent.click(stop);
  await waitFor(() => assert.deepEqual(writes, ["/api/user/runs/current/cancel"]));
});

test("网站工作空间保留执行器配对确认入口", async () => {
  history.replaceState(null, "", "/?pair=link_code#" + task.id);
  const writes: string[] = [];
  const transport = transportWith(async (method, path) => {
    if (path === "/api/user/snapshot") return snapshot;
    if (path === "/api/admin/pairings/link_code")
      return { name: "测试执行器", code: "ABC123", approved: false };
    if (path.split("?")[0] === "/api/user/threads")
      return {
        items: [{ id: threadPage.id, task_id: task.id, model_id: task.modelId }],
        nextCursor: null,
      };
    if (method === "POST") writes.push(path);
    return threadPage;
  });
  const v = render(<App transport={transport} />);
  await waitFor(() => assert.ok(v.getByText(/校验码 ABC123/)));
  assert.deepEqual(writes, []);
});
