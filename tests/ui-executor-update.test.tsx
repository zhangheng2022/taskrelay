import "./ui-dom";
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { render, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { ExecutorApp } from "../packages/ui/src/executor-app";
import type { DesktopStatus, Transport } from "../packages/contracts/src/index";
afterEach(cleanup);
test("执行器展示新版本，自动下载无需确认，失败支持重试，等待时禁用更新入口", async () => {
  const calls: string[] = [];
  let changed = () => {};
  const status: DesktopStatus = {
    paired: true,
    cloudUrl: "https://example.com",
    paused: false,
    online: true,
    activeRunId: "live-run",
    version: "0.4.7",
    autoStart: false,
    error: null,
    update: {
      phase: "downloading",
      release: {
        version: "0.4.8",
        sha1: "a".repeat(40),
        sha256: "a".repeat(64),
        bytes: 10,
        notes: "改进更新体验",
        publishedAt: "2026-11-04T00:00:00.000Z",
      },
      checkedAt: null,
      error: null,
      progress: null,
    },
  };
  const executor: NonNullable<Transport["desktop"]> = {
    status: async () => structuredClone(status),
    configure: async () => ({ url: "", code: "" }),
    pairPoll: async () => true,
    pause: async () => {},
    autoStart: async () => {},
    stop: async () => {},
    diagnostics: async () => "",
    subscribe: (fn) => {
      changed = fn;
      return () => {};
    },
    checkUpdate: async () => {
      calls.push("check");
    },
    downloadUpdate: async (v) => {
      calls.push(v);
      status.update.phase = "waiting";
      changed();
    },
  };
  const view = render(<ExecutorApp executor={executor} />);
  await view.findByText("正在下载更新 0%");
  assert.equal(view.queryByRole("button", { name: "立即重试" }), null);
  status.update.phase = "error";
  changed();
  await view.findByText("更新失败，请重试。");
  assert.deepEqual(calls, []);
  fireEvent.click(view.getByRole("button", { name: "检查更新" }));
  await waitFor(() => assert.deepEqual(calls, ["check"]));
  await waitFor(() =>
    assert.equal(
      (view.getByRole("button", { name: "立即重试" }) as HTMLButtonElement).disabled,
      false,
    ),
  );
  fireEvent.click(view.getByRole("button", { name: "立即重试" }));
  await view.findByText(/下载完成，已暂停领取/);
  assert.deepEqual(calls, ["check", "0.4.8"]);
  assert.equal(status.activeRunId, "live-run");
  assert.equal(view.queryByRole("button", { name: "立即重试" }), null);
  assert.equal(
    (view.getByRole("button", { name: "检查更新" }) as HTMLButtonElement).disabled,
    true,
  );
});

test("开机自启动从执行器直接启用，授权取消不报成已启用", async () => {
  const status: DesktopStatus = {
    paired: true,
    cloudUrl: "https://example.com",
    paused: false,
    online: true,
    activeRunId: null,
    version: "0.27.0",
    boot: "not-installed",
    autoStart: false,
    error: null,
    update: { phase: "current", release: null, checkedAt: null, progress: null, error: null },
  };
  let cancelled = true;
  const changes: boolean[] = [];
  const executor: NonNullable<Transport["desktop"]> = {
    status: async () => structuredClone(status),
    configure: async () => ({ url: "", code: "" }),
    pairPoll: async () => false,
    pause: async () => {},
    autoStart: async (value) => {
      changes.push(value);
      if (cancelled) throw Error("SERVICE_UAC_CANCELLED");
      status.autoStart = value;
      status.boot = value ? "pairing" : "disabled";
    },
    stop: async () => {},
    diagnostics: async () => "",
    subscribe: () => () => {},
    checkUpdate: async () => {},
    downloadUpdate: async () => {},
  };
  const view = render(<ExecutorApp executor={executor} />);
  await view.findByText("首次开启会安装 Windows 服务，并引导你重新配对。");
  const toggle = view.getByRole("switch", { name: "开机自启动" });
  fireEvent.click(toggle);
  await view.findByText("已取消 Windows 管理员授权。");
  assert.equal(toggle.getAttribute("aria-checked"), "false");
  cancelled = false;
  fireEvent.click(toggle);
  await view.findByText("请在上方授权新的执行设备，完成后可在无人登录时接单。");
  assert.equal(toggle.getAttribute("aria-checked"), "true");
  fireEvent.click(toggle);
  await waitFor(() => assert.equal(toggle.getAttribute("aria-checked"), "false"));
  assert.deepEqual(changes, [true, true, false]);
});
