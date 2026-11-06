import { requestUrl } from "./http-fixture";
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DesktopUpdater } from "../apps/desktop/src/main/updater";
import { serveUpdate } from "../apps/cloud/src/updates";
import {
  newerVersion,
  packageName,
  packagePath,
  UPDATE_ORIGIN,
  UPDATE_PATH,
  releaseCatalogSchema,
} from "../packages/contracts/src/updates";

const payload = Buffer.from("isolated update package");
const release = {
  version: "0.4.8",
  sha256: createHash("sha256").update(payload).digest("hex"),
  sha1: createHash("sha1").update(payload).digest("hex"),
  bytes: payload.length,
  notes: "修复与改进",
  publishedAt: "2026-11-04T00:00:00.000Z",
};
class Native extends EventEmitter {
  feed = "";
  checks = 0;
  setFeedURL({ url }: { url: string }) {
    this.feed = url;
  }
  checkForUpdates() {
    this.checks++;
  }
}
async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), "relay-update-"));
  const native = new Native();
  let busy = false,
    restarted = 0,
    reminders = 0;
  const calls: { url: string; options?: RequestInit }[] = [];
  let response = () =>
    new Response(payload, { headers: { "Content-Length": String(payload.length) } });
  const updater = new DesktopUpdater({
    version: "0.4.7",
    supported: true,
    directory,
    native,
    busy: () => busy,
    changed: () => {},
    available: () => reminders++,
    restart: () => restarted++,
    fetcher: async (url, options) => {
      calls.push({ url: requestUrl(url), options });
      return requestUrl(url).endsWith("latest.json") ? Response.json({ release }) : response();
    },
  });
  t.after(async () => {
    updater.stop();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    updater,
    native,
    calls,
    directory,
    setBusy: (value: boolean) => {
      busy = value;
    },
    setResponse: (value: typeof response) => {
      response = value;
    },
    get restarted() {
      return restarted;
    },
    get reminders() {
      return reminders;
    },
  };
}
test("仅检查不下载，通知去重；确认绑定版本，CF 下载校验后只给安装器本地路径", async (t) => {
  const s = await fixture(t);
  await s.updater.check();
  await s.updater.check();
  assert.equal(s.reminders, 1);
  assert.equal(s.native.checks, 0);
  assert.equal(s.calls.length, 2);
  await assert.rejects(s.updater.download("0.4.9"), /UPDATE_SELECTION_EXPIRED/);
  s.setBusy(true);
  await s.updater.download(release.version);
  assert.equal(s.updater.status.phase, "waiting");
  assert.equal(s.updater.blocksClaims, true);
  assert.equal(s.native.checks, 0);
  s.updater.tryInstall();
  assert.equal(s.native.checks, 0);
  s.setBusy(false);
  s.updater.tryInstall();
  s.updater.tryInstall();
  assert.equal(s.native.checks, 1);
  assert.ok(path.isAbsolute(s.native.feed));
  assert.equal(
    await readFile(path.join(s.native.feed, "RELEASES"), "utf8"),
    `${release.sha1} ${packageName(release)} ${release.bytes}\n`,
  );
  assert.deepEqual(await readFile(path.join(s.native.feed, packageName(release))), payload);
  for (const call of s.calls) {
    assert.equal(new URL(call.url).origin, UPDATE_ORIGIN);
    assert.equal(call.options?.redirect, "error");
    assert.equal(call.options?.credentials, "omit");
  }
  s.native.emit("update-downloaded", {}, "", release.version);
  assert.equal(s.restarted, 1);
});
for (const failure of ["checksum", "size", "redirect", "truncated", "offline"] as const)
  test(`下载 ${failure} 失败不触发安装且可重试`, async (t) => {
    const s = await fixture(t);
    await s.updater.check();
    s.setResponse(() => {
      if (failure === "offline") throw Error("private network error");
      return new Response(
        failure === "checksum"
          ? Buffer.alloc(payload.length)
          : failure === "truncated"
            ? payload.subarray(0, 3)
            : payload,
        {
          status: failure === "redirect" ? 302 : 200,
          headers: {
            "Content-Length": String(failure === "size" ? 999 : payload.length),
            Location: "https://github.com/forbidden",
          },
        },
      );
    });
    await s.updater.download(release.version);
    assert.equal(s.updater.status.phase, "error");
    assert.equal(s.updater.blocksClaims, false);
    assert.equal(s.native.checks, 0);
    assert.deepEqual(await readdir(s.directory), []);
    assert.ok(!s.updater.status.error?.includes("private"));
    s.setResponse(
      () => new Response(payload, { headers: { "Content-Length": String(payload.length) } }),
    );
    await s.updater.download(release.version);
    assert.equal(s.native.checks, 1);
  });
test("本地安装错误恢复领取；已停止、错误版本或重新忙碌均不重启", async (t) => {
  const s = await fixture(t);
  await s.updater.check();
  await s.updater.download(release.version);
  s.native.emit("error", Error("private path"));
  assert.equal(s.updater.blocksClaims, false);
  assert.equal(s.updater.status.phase, "error");
  await s.updater.download(release.version);
  s.native.emit("update-downloaded", {}, "", "0.4.9");
  assert.equal(s.restarted, 0);
  await s.updater.download(release.version);
  s.setBusy(true);
  s.native.emit("update-downloaded", {}, "", release.version);
  assert.equal(s.restarted, 0);
  s.updater.stop();
  await s.updater.check();
  s.native.emit("update-downloaded", {}, "", release.version);
  assert.equal(s.restarted, 0);
});
test("语义版本比较拒绝降级、字符串排序及不合法路径", () => {
  assert.equal(newerVersion("0.4.10", "0.4.9"), true);
  assert.equal(newerVersion("0.4.7", "0.4.8"), false);
  assert.equal(newerVersion("0.4.7", "0.4.7"), false);
  assert.throws(() => newerVersion("../8", "0.4.7"));
  assert.equal(
    releaseCatalogSchema.safeParse({ latest: "0.4.9", releases: [release] }).success,
    false,
  );
});
test("CF 更新路由只代理固定文件，内部消化 GitHub 重定向，不透传凭据或 Location", async () => {
  const catalog = { latest: release.version, releases: [release] };
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    calls.push({ url: requestUrl(url), init });
    return calls.length === 1
      ? new Response(null, {
          status: 302,
          headers: {
            Location: "https://release-assets.githubusercontent.com/fixed?signature=private",
          },
        })
      : new Response(payload, {
          headers: { "Content-Length": String(payload.length), "Set-Cookie": "secret=1" },
        });
  };
  const response = await serveUpdate(
    new Request(UPDATE_ORIGIN + packagePath(release), {
      headers: { Authorization: "Bearer private", Cookie: "secret=1" },
    }),
    catalog,
    fetcher,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), payload);
  assert.equal(response.headers.has("location"), false);
  assert.equal(response.headers.has("set-cookie"), false);
  assert.equal(calls.length, 2);
  for (const c of calls) {
    const h = new Headers(c.init?.headers);
    assert.equal(h.has("Authorization"), false);
    assert.equal(h.has("Cookie"), false);
    assert.equal(c.init?.redirect, "manual");
  }
  assert.equal(
    (await serveUpdate(new Request(UPDATE_ORIGIN + UPDATE_PATH + "/latest.json"), catalog)).status,
    200,
  );
  assert.equal(
    (
      await serveUpdate(
        new Request(UPDATE_ORIGIN + packagePath(release) + "?url=https://evil.test"),
        catalog,
        fetcher,
      )
    ).status,
    400,
  );
  assert.equal(
    (await serveUpdate(new Request(UPDATE_ORIGIN + UPDATE_PATH + "/arbitrary"), catalog, fetcher))
      .status,
    404,
  );
  assert.equal(
    (
      await serveUpdate(
        new Request(UPDATE_ORIGIN + packagePath(release), { method: "POST" }),
        catalog,
        fetcher,
      )
    ).status,
    405,
  );
});
test("CF 阻止私网/非白名单重定向及上游错误；空通道不伪造版本", async () => {
  const catalog = { latest: release.version, releases: [release] };
  for (const url of [
    "http://127.0.0.1/file",
    "https://evil.test/file",
    "https://release-assets.githubusercontent.com:444/file",
    "https://x:y@objects.githubusercontent.com/file",
  ]) {
    const response = await serveUpdate(
      new Request(UPDATE_ORIGIN + packagePath(release)),
      catalog,
      async () => new Response(null, { status: 302, headers: { Location: url } }),
    );
    assert.equal(response.status, 502);
  }
  const response = await serveUpdate(new Request(UPDATE_ORIGIN + UPDATE_PATH + "/latest.json"), {
    latest: null,
    releases: [],
  });
  assert.deepEqual(await response.json(), { release: null });
});
