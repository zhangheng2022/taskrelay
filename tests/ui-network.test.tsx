import "./ui-dom";
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { render, fireEvent, cleanup, waitFor, act } from "@testing-library/react";
import { AuthGate } from "../packages/ui/src/auth-gate";
import { TaskCompose } from "../packages/ui/src/task-compose";
import { ExecutorApp } from "../packages/ui/src/executor-app";
import { snapshot, transportWith, threadPage } from "./ui-fixtures";
import type { DesktopStatus, Transport } from "../packages/contracts/src/index";
Object.defineProperty(globalThis, "location", { configurable: true, value: window.location });

afterEach(() => {
  cleanup();
  localStorage.clear();
  document.documentElement.classList.remove("dark");
});

test("登录前的加载、错误和登录页均保持用户主题；网络失败可重新加载", async (t) => {
  localStorage.setItem("taskrelay.theme", "dark");
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(JSON.stringify({ registrationOpen: false, siteKey: "" }), {
        headers: { "content-type": "application/json" },
      }),
  );
  let fail = true;
  const transport = transportWith(async () => {
    throw new Error(fail ? "OFFLINE" : "AUTH_REQUIRED");
  });
  const view = render(
    <AuthGate transport={transport}>
      <span>工作空间</span>
    </AuthGate>,
  );
  assert.ok(view.getByRole("status").textContent?.includes("正在加载"));
  assert.ok(document.documentElement.classList.contains("dark"));
  await view.findByRole("button", { name: "重新加载" });
  assert.equal(view.queryByRole("status"), null);
  assert.equal(view.queryByLabelText("密码"), null, "身份未知时不误报退出登录");
  fail = false;
  fireEvent.click(view.getByRole("button", { name: "重新加载" }));
  await view.findByLabelText("密码");
  assert.ok(document.documentElement.classList.contains("dark"));
});

test("会话首次加载失败后可恢复；只重读会话，不自动发送或创建任务", async () => {
  let reads = 0,
    resolveRead: (value: unknown) => void = () => {};
  const requests: string[] = [];
  const transport = transportWith(async (method, path) => {
    requests.push(method + " " + path);
    assert.equal(path.split("?")[0], `/api/user/threads/${threadPage.id}`);
    if (++reads === 1) throw new Error("OFFLINE");
    assert.equal(method, "GET");
    return await new Promise((r) => {
      resolveRead = r;
    });
  });
  const view = render(
    <TaskCompose
      threadId={threadPage.id}
      transport={transport}
      snapshot={snapshot}
      offline={false}
      onSaved={async () => {}}
      onSettings={() => {}}
    />,
  );
  await view.findByRole("button", { name: "重新加载" });
  assert.equal(view.queryByRole("status"), null);
  fireEvent.click(view.getByRole("button", { name: "重新加载" }));
  await waitFor(() => assert.ok(view.getByRole("status").textContent?.includes("正在加载对话")));
  assert.ok(view.getByRole("button", { name: "发送消息" }).hasAttribute("disabled"));
  await act(async () => resolveRead(threadPage));
  await waitFor(() => assert.equal(view.queryByRole("status"), null));
  fireEvent.change(view.getByRole("textbox"), { target: { value: "保留我的输入" } });
  assert.equal(view.getByRole("button", { name: "发送消息" }).hasAttribute("disabled"), false);
  assert.ok(requests.every((x) => x.startsWith("GET ")));
});

test("执行器读取状态前不显示可操作的假开关；断网执行中仍可停止", async () => {
  let finish: (value: DesktopStatus) => void = () => {},
    stops = 0;
  const pending = new Promise<DesktopStatus>((r) => {
    finish = r;
  });
  const executor: NonNullable<Transport["desktop"]> = {
    status: () => pending,
    subscribe: () => () => {},
    pause: async () => {},
    autoStart: async () => {},
    stop: async () => {
      stops++;
    },
    configure: async () => ({ url: "", code: "" }),
    pairPoll: async () => false,
    diagnostics: async () => "",
    checkUpdate: async () => {},
    downloadUpdate: async () => {},
  };
  const view = render(<ExecutorApp executor={executor} />);
  assert.ok(view.getByRole("status").textContent?.includes("正在读取"));
  assert.ok(view.getByRole("switch", { name: "暂停领取新任务" }).hasAttribute("disabled"));
  await act(async () =>
    finish({
      paired: true,
      cloudUrl: "https://example.com",
      online: false,
      paused: false,
      autoStart: false,
      activeRunId: "demo",
      version: "演示",
      error: null,
      update: { phase: "current", release: null, progress: null, error: null, checkedAt: null },
    }),
  );
  await view.findByText("连接中断，本机仍在执行");
  assert.ok(view.getByText(/正在自动重连/));
  fireEvent.click(view.getByRole("button", { name: "停止当前执行" }));
  await waitFor(() => assert.equal(stops, 1));
});

test("执行器状态读取恢复后清除连接错误，保留操作失败", async () => {
  let fail = true,
    notify = () => {};
  const executor: NonNullable<Transport["desktop"]> = {
    status: async () => {
      if (fail) throw new Error("OFFLINE");
      return {
        paired: true,
        cloudUrl: "https://example.com",
        online: true,
        paused: false,
        autoStart: false,
        activeRunId: null,
        version: "演示",
        error: null,
        update: { phase: "current", release: null, progress: null, error: null, checkedAt: null },
      };
    },
    subscribe: (fn) => {
      notify = fn;
      return () => {};
    },
    pause: async () => {},
    autoStart: async () => {},
    stop: async () => {},
    configure: async () => ({ url: "", code: "" }),
    pairPoll: async () => false,
    diagnostics: async () => {
      throw new Error("诊断导出失败");
    },
    checkUpdate: async () => {},
    downloadUpdate: async () => {},
  };
  const view = render(<ExecutorApp executor={executor} />);
  await view.findByText(/暂时无法连接云端/);
  fail = false;
  await act(async () => notify());
  await view.findByText("在线，等待任务");
  assert.equal(view.queryByText(/暂时无法连接云端/), null);
  fireEvent.click(view.getByRole("button", { name: "导出诊断" }));
  await view.findByText(/诊断导出失败/);
  await act(async () => notify());
  assert.ok(view.getByText(/诊断导出失败/));
});
