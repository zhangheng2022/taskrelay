import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Journal } from "../apps/desktop/src/main/journal";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

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
