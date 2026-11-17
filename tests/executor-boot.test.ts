import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { DesktopControl, tryAcquireExecutor } from "../apps/desktop/src/main/desktop-control";
import { Journal } from "../apps/desktop/src/main/journal";
import type { DesktopStatus } from "../packages/contracts/src/index";
import { run } from "./ui-fixtures";

async function profile(t: TestContext) {
  const dir = await mkdtemp(path.join(tmpdir(), "taskrelay-boot-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("后台 Main 领取并启动运行，独立桌面进程控制同一执行器", { timeout: 30_000 }, async (t) => {
  const dir = await profile(t);
  const extension = path.join(dir, "resources", "stagehand-extension");
  await mkdir(extension, { recursive: true });
  await writeFile(path.join(extension, "manifest.json"), "{}");
  await writeFile(path.join(extension, "content-script.js"), "fixture");
  const journal = new Journal(dir);
  journal.set("token", Buffer.from("fixture-token").toString("base64"));
  journal.set("cloudUrl", "https://127.0.0.1:1");
  journal.close();
  const children: ReturnType<typeof fork>[] = [];
  async function cleanup() {
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill();
        await exited;
      }
  }
  function launch(mode: string) {
    const child = fork(path.resolve("tests/desktop-boot-fixture.mjs"), [
      dir,
      path.join(dir, "resources"),
      mode,
    ]);
    children.push(child);
    const messages: { type: string; data: unknown }[] = [];
    child.on("message", (msg) => messages.push(msg as (typeof messages)[number]));
    async function wait(type: string, predicate: (value: unknown) => boolean = () => true) {
      for (let i = 0; i < 500; i++) {
        const found = messages.find((m) => m.type === type && predicate(m.data));
        if (found) return found.data;
        const error = messages.find((m) => m.type === "error");
        if (error) throw Error(String(error.data));
        if (child.exitCode !== null) throw Error(`FIXTURE_EXIT:${child.exitCode}`);
        await delay(30);
      }
      throw Error(`FIXTURE_TIMEOUT:${type}`);
    }
    let sequence = 0;
    return {
      child,
      messages,
      wait,
      send: (method: string) => child.send({ method }),
      async call<T>(method: string, input?: unknown) {
        const id = String(++sequence);
        child.send({ id, method, input });
        const result = (await wait(id)) as { value: T; error?: string };
        if (result.error) throw Error(result.error);
        return result.value;
      },
    };
  }
  try {
    const boot = launch("background");
    await boot.wait("utility", (value) => value === "start");
    assert.equal(tryAcquireExecutor(dir), null);
    const desktop = launch("desktop");
    assert.match(String(await desktop.wait("window")), /后台控制/);
    assert.equal((await desktop.call<DesktopStatus>("status")).activeRunId, run.id);
    await assert.rejects(
      desktop.call("configure", "https://127.0.0.1:1"),
      /STOP_RUN_BEFORE_PAIRING/,
    );
    await desktop.call("pause", true);
    await desktop.call("autoStart", false);
    await desktop.call("checkUpdate");
    await desktop.call("downloadUpdate", "0.26.9");
    await desktop.call("stop");
    const status = await desktop.call<DesktopStatus>("status");
    assert.equal(status.activeRunId, null);
    assert.equal(status.paused, true);
    assert.equal(
      (await desktop.call<{ code: string }>("configure", "https://127.0.0.1:1")).code,
      "123456",
    );
    assert.equal(await desktop.call("pairPoll"), true);
    await desktop.wait("external");
    await desktop.call("diagnostics");
    const diagnostics = JSON.parse(await readFile(path.join(dir, "diagnostics.json"), "utf8"));
    assert.equal(diagnostics.outboxCount.count, 1);
    assert.equal(diagnostics.journal[0].run_id, run.id);
    assert.equal(
      boot.messages.some((m) => m.type === "window"),
      false,
    );
    assert.equal(
      desktop.messages.some((m) => m.type === "claim" || m.type === "utility"),
      false,
    );
    const exits = [once(boot.child, "exit"), once(desktop.child, "exit")];
    desktop.send("quit");
    assert.deepEqual(await Promise.all(exits), [
      [0, null],
      [0, null],
    ]);
    const foreground = launch("desktop");
    assert.equal(await foreground.wait("window"), "TaskRelay 执行器");
    assert.equal((await foreground.call<DesktopStatus>("status")).paused, true);
    foreground.send("trayPause");
    assert.equal((await foreground.call<DesktopStatus>("status")).paused, false);
    foreground.send("resume");
    await foreground.wait("utility", (value) => value === "start");
    foreground.send("holdReadiness");
    await foreground.wait("pendingReadiness");
    const exited = once(foreground.child, "exit");
    foreground.send("quit");
    await foreground.wait("utility", (value) => value === "cancel");
    assert.deepEqual(await exited, [0, null]);

    const reboot = launch("background");
    await reboot.wait("appId");
    const viewer = launch("desktop");
    assert.match(String(await viewer.wait("window")), /后台控制/);
    const crashed = once(reboot.child, "exit");
    reboot.child.kill();
    await crashed;
    const closed = once(viewer.child, "exit");
    viewer.send("quit");
    assert.deepEqual(await closed, [0, null]);
  } finally {
    await cleanup();
  }
});

test("后台更换进程后未开始的命令失效，调用者可使用新进程", async (t) => {
  const dir = await profile(t);
  const lock = tryAcquireExecutor(dir)!;
  const owner = new DesktopControl(dir);
  const client = new DesktopControl(dir);
  const next = new DesktopControl(dir);
  const calls: string[] = [];
  const executed = (method: string) => calls.push(method);
  try {
    await assert.rejects(client.call("status"), /正在启动/);
    owner.serve(executed, assert.fail, () => {});
    const stale = client.call("stop");
    owner.close();
    lock.close();
    const nextLock = tryAcquireExecutor(dir)!;
    try {
      next.serve(executed, assert.fail, () => {});
      await assert.rejects(stale, /未响应/);
      assert.equal(await client.call("status"), 1);
      assert.deepEqual(calls, ["status"]);
    } finally {
      next.close();
      nextLock.close();
    }
  } finally {
    owner.close();
    client.close();
    next.close();
  }
});
