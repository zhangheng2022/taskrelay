import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Journal } from "../apps/desktop/src/main/journal";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

test("回执按入队顺序发送：同毫秒、时钟回拨、随机 ID 与重复请求不能倒置结果和关闭确认", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "taskrelay-fifo-"));
  let journal = new Journal(directory);
  t.after(() => {
    journal.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const clock = t.mock.method(Date, "now", () => 1000);
  journal.queue("z_finish", "/api/runner/runs/run/finish", { epoch: 2 });
  journal.queue("a_closed", "/api/runner/runs/run/browser-closed", { epoch: 2 });
  clock.mock.mockImplementation(() => 500);
  journal.queue("b_later", "/api/runner/runs/later/finish", { epoch: 3 });
  journal.queue("z_finish", "/ignored-retry", { epoch: 99 });
  journal.close();
  journal = new Journal(directory);
  assert.deepEqual(
    journal.pending().map((r) => r.id),
    ["z_finish", "a_closed", "b_later"],
  );
  assert.equal(JSON.parse(journal.pending()[0].body).epoch, 2);
  journal.remove("z_finish");
  assert.deepEqual(
    journal.pending().map((r) => r.id),
    ["a_closed", "b_later"],
  );
});

test("正式 Cloud.connect 允许转换后的终态回执等待确认，仍拒绝未收尾检查点和其他旧请求", async (t) => {
  const bundle = await build({
    entryPoints: ["apps/desktop/src/main/cloud.ts"],
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    external: ["ws"],
    plugins: [
      {
        name: "electron",
        setup(b) {
          b.onResolve({ filter: /^electron$/ }, () => ({ path: "electron", namespace: "fixture" }));
          b.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
            contents: 'export const safeStorage={decryptString:()=>"fixture"}',
          }));
        },
      },
    ],
  });
  // ws 的裸导入在 data URL 下不能解析；connect 不涉及 WebSocket，因此由隔离 adapter 替代。
  const code = bundle.outputFiles[0].text.replace(/import (\w+) from "ws";/, "const $1=class{};");
  const { Cloud } = (await import(
    "data:text/javascript;base64," + Buffer.from(code).toString("base64")
  )) as typeof import("../apps/desktop/src/main/cloud");
  const directory = mkdtempSync(path.join(tmpdir(), "taskrelay-connect-")),
    journal = new Journal(directory);
  t.after(() => {
    journal.close();
    rmSync(directory, { recursive: true, force: true });
  });
  journal.set("cloudUrl", "https://fixture.invalid");
  journal.set("token", "ZmFrZQ==");
  journal.queue("receipt", "/api/runner/runs/run/finish", { epoch: 2 });
  let upgraded = false,
    calls = 0;
  t.mock.method(globalThis, "fetch", async (input: string) => {
    calls++;
    if (input.endsWith("/upgrade")) {
      upgraded = true;
      return Response.json({ protocolVersion: 18 });
    }
    return upgraded
      ? Response.json({ maintenance: true })
      : Response.json({ error: "DEVICE_UPGRADE_REQUIRED" }, { status: 409 });
  });
  const cloud = new Cloud(journal);
  assert.equal((await cloud.connect(true)).maintenance, true);
  assert.equal(journal.pending()[0].id, "receipt");
  assert.ok(upgraded);
  upgraded = false;
  calls = 0;
  journal.checkpoint("unknown", "generation", 2, "intent", {});
  await assert.rejects(cloud.connect(true), /LOCAL_HISTORY_UNRESOLVED/);
  assert.equal(calls, 1);
  assert.equal(upgraded, false);
  journal.checkpoint("unknown", "generation", 2, "abandoned", {});
  journal.queue("legacy", "/legacy-action", { epoch: 2 });
  await assert.rejects(cloud.connect(true), /LOCAL_HISTORY_UNRESOLVED/);
  assert.equal(upgraded, false);
});
