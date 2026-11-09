/** 真实 Chromium 图片验收：仅监听回环地址、合成数据；复用生产组件/样式/Transport。
 * 浏览器缺失直接失败；每次生成新报告和截图，关闭浏览器、服务与临时 Profile。 */
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { build, preview } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { launch } from "@puppeteer/browsers";
import CDP from "chrome-remote-interface";
import sharp from "sharp";
import { grantBrowserReadAccess } from "../apps/desktop/src/main/browser-permissions.ts";

const root = process.cwd();
const baseline = process.argv.includes("--baseline");
const output = path.resolve("out", baseline ? "web-images-baseline" : "web-images");
const executablePath = path.resolve("resources/browser/chrome-win64/chrome.exe");
await access(executablePath); // CI 先 prepare:browser，不能静默跳过。
await grantBrowserReadAccess(path.dirname(executablePath));
if (!output.startsWith(path.join(root, "out") + path.sep)) throw Error("REPORT_PATH_INVALID");
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
const profile = await mkdtemp(path.join(tmpdir(), "taskrelay-web-images-"));
const original = await sharp({
  create: { width: 1280, height: 720, channels: 3, background: "#888888" },
})
  .composite([
    {
      input: Buffer.from(
        '<svg width="1280" height="720"><rect x="60" y="60" width="1160" height="600" rx="24" fill="#fafafa"/><text x="100" y="150" font-size="40">TaskRelay image loading</text><rect x="100" y="200" width="650" height="300" fill="#d4d4d4"/></svg>',
      ),
    },
  ])
  .png()
  .toBuffer();
const thumbnail = await sharp(original).resize(640, 360).png().toBuffer();
const requests = [];
let scenario = { status: 200, thumbnailError: false, delay: 700 };
let browser, client, server;
const report = {
  passed: false,
  startedAt: new Date().toISOString(),
  sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  baseline,
  cases: [],
  metrics: {},
};
const oldSource = baseline
  ? execFileSync("git", ["show", "HEAD:packages/ui/src/chat-attachments.tsx"], { encoding: "utf8" })
  : undefined;
try {
  const config = {
    configFile: false,
    root,
    cacheDir: path.join(profile, "vite"),
    logLevel: "error",
    plugins: [
      ...(baseline
        ? [
            {
              name: "baseline-image-component",
              enforce: "pre",
              load(id) {
                if (
                  id.replaceAll("\\", "/") ===
                  path.resolve("packages/ui/src/chat-attachments.tsx").replaceAll("\\", "/")
                )
                  return oldSource;
              },
            },
          ]
        : []),
      react(),
      tailwindcss(),
      {
        name: "isolated-images",
        configurePreviewServer(vite) {
          vite.middlewares.use((req, res, next) => {
            if (!req.url?.startsWith("/api/user/artifacts/")) return next();
            const thumb = req.url.includes("variant=thumbnail");
            const status = thumb && scenario.thumbnailError ? 404 : scenario.status;
            const bytes = thumb ? thumbnail : original;
            const entry = {
              url: req.url,
              thumbnail: thumb,
              status,
              bytes: status === 200 ? bytes.length : 0,
            };
            requests.push(entry);
            const timer = setTimeout(() => {
              res.writeHead(status, {
                "Content-Type": status === 200 ? "image/png" : "text/plain",
                "Cache-Control": "no-store",
              });
              res.end(status === 200 ? bytes : "unavailable");
            }, scenario.delay);
            res.on("close", () => clearTimeout(timer));
          });
        },
      },
    ],
    build: {
      outDir: path.join(profile, "site"),
      rolldownOptions: { input: path.join(root, "tests/browser-fixtures/images.html") },
    },
    preview: { host: "127.0.0.1", port: 0, strictPort: false },
  };
  await build(config);
  server = await preview(config);
  console.log("Browser fixture server ready");
  const origin = server.resolvedUrls.local[0];
  browser = launch({
    executablePath,
    args: [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--disable-background-networking",
    ],
  });
  const endpoint = await browser.waitForLineOutput(/DevTools listening on (ws:\/\/.*)/, 20000);
  console.log("Browser launched");
  const port = Number(new URL(endpoint).port);
  const tab = await CDP.New({ host: "127.0.0.1", port });
  client = await CDP({ host: "127.0.0.1", port, target: tab.id, local: true });
  console.log("Browser connected");
  await client.Page.enable();
  await client.Runtime.enable();
  report.browserErrors = [];
  client.Runtime.exceptionThrown(({ exceptionDetails }) =>
    report.browserErrors.push(exceptionDetails.exception?.description ?? exceptionDetails.text),
  );
  await client.Emulation.setDeviceMetricsOverride({
    width: 1280,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const evaluate = async (expression) => {
    const result = await client.Runtime.evaluate({
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const wait = async (expression, label = expression) => {
    const deadline = Date.now() + 20000;
    while (!(await evaluate(`Boolean(${expression})`))) {
      if (Date.now() > deadline) throw Error(`BROWSER_WAIT:${label}`);
      await delay(40);
    }
  };
  const click = async (selector) => {
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  };
  const screenshot = async (name) => {
    await delay(220);
    const shot = await client.Page.captureScreenshot({ format: "png" });
    await writeFile(path.join(output, name + ".png"), Buffer.from(shot.data, "base64"));
  };
  const loaded =
    'Array.from(document.querySelectorAll("img")).some(i=>i.alt==="执行截图" && i.complete && i.naturalWidth>0)';
  const previewLoaded =
    'Array.from(document.querySelectorAll("[role=dialog] img")).some(i=>i.alt==="执行截图" && i.complete && i.naturalWidth>0)';
  const navigation = await client.Page.navigate({
    url: `${origin}tests/browser-fixtures/images.html`,
  });
  assert.equal(navigation.errorText, undefined, "浏览器成功打开隔离夹具");
  await wait('document.querySelector("[data-slot=attachment]")');
  const before = await evaluate(
    'document.querySelector("[data-slot=attachment]").getBoundingClientRect().height',
  );
  if (!baseline) {
    await wait('document.querySelector("[data-slot=attachment] [data-slot=spinner]")');
    assert.ok(
      await evaluate(
        'getComputedStyle(document.querySelector("[data-slot=spinner]")).animationName !== "none"',
      ),
    );
    await screenshot("thumbnail-loading-desktop");
  }
  await wait(loaded);
  console.log("Thumbnail decoded");
  const after = await evaluate(
    'document.querySelector("[data-slot=attachment]").getBoundingClientRect().height',
  );
  report.metrics.thumbnailHeightChange = Math.abs(after - before);
  report.metrics.firstThumbnailMs = await evaluate(
    'performance.getEntriesByType("resource").find(r=>r.name.includes("variant=thumbnail"))?.duration',
  );
  if (!baseline) assert.ok(Math.abs(after - before) <= 1, "缩略图加载不改变布局高度");
  assert.equal(requests.filter((r) => !r.thumbnail).length, 0);
  const start = Date.now();
  await click('[aria-label="查看完整截图"]');
  await wait('document.querySelector("[role=dialog]")');
  if (!baseline) {
    assert.ok(
      await evaluate(
        'document.querySelector("[role=dialog]").textContent.includes("正在加载原图")',
      ),
    );
    await screenshot("original-loading-desktop");
  }
  await wait(previewLoaded);
  report.metrics.firstPreviewMs = Date.now() - start;
  await screenshot("original-loaded-desktop");
  await client.Input.dispatchKeyEvent({
    type: "keyDown",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
  });
  await client.Input.dispatchKeyEvent({
    type: "keyUp",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
  });
  await wait('!document.querySelector("[role=dialog]")');
  const count = requests.length;
  await click("#refresh");
  await delay(150);
  assert.equal(requests.length, count, "普通消息刷新不重载图片");
  await click('[aria-label="查看完整截图"]');
  const reopen = Date.now();
  await wait(previewLoaded);
  report.metrics.reopenPreviewMs = Date.now() - reopen;
  report.metrics.bytesAfterReopen = requests.reduce((sum, r) => sum + r.bytes, 0);
  report.metrics.originalRequestsAfterReopen = requests.filter((r) => !r.thumbnail).length;
  if (!baseline) assert.equal(report.metrics.originalRequestsAfterReopen, 1);
  await click('[data-slot="dialog-close"]');
  await wait('!document.querySelector("[role=dialog]")');
  report.cases.push("loading, decode, stable layout, escape, refresh and repeated preview");
  if (!baseline) {
    await client.Emulation.setDeviceMetricsOverride({
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await evaluate('document.documentElement.classList.add("dark")');
    await click("#switch");
    await wait('document.querySelector("[data-slot=spinner]")');
    await screenshot("thumbnail-loading-mobile-dark");
    await wait(loaded);
    await evaluate(`document.querySelector('[aria-label="查看完整截图"]').focus()`);
    await client.Input.dispatchKeyEvent({
      type: "keyDown",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      text: "\r",
    });
    await client.Input.dispatchKeyEvent({
      type: "keyUp",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
    });
    await wait('document.querySelector("[role=dialog]")');
    await screenshot("original-loading-mobile-dark");
    assert.ok(
      await evaluate(
        'document.documentElement.scrollWidth <= innerWidth && document.querySelector("[role=dialog]").getBoundingClientRect().width <= innerWidth',
      ),
    );
    await wait(previewLoaded);
    await screenshot("original-loaded-mobile-dark");
    await click('[data-slot="dialog-close"]');
    await wait('!document.querySelector("[role=dialog]")');
    assert.equal(
      await evaluate('document.activeElement?.getAttribute("aria-label")'),
      "查看完整截图",
    );
    scenario.thumbnailError = true;
    await click("#switch");
    await wait(
      'document.querySelector("[data-slot=attachment]").textContent.includes("缩略图不可用")',
    );
    assert.equal(
      await evaluate(
        'document.querySelector("[data-slot=attachment] [data-slot=spinner]") !== null',
      ),
      false,
    );
    await click('[aria-label="查看完整截图"]');
    await wait(previewLoaded);
    await click('[data-slot="dialog-close"]');
    await wait('!document.querySelector("[role=dialog]")');
    scenario.thumbnailError = false;
    await evaluate(
      'Array.from(document.querySelectorAll("button")).find(b=>b.textContent==="重新加载图片").click()',
    );
    await wait(loaded);
    scenario.status = 401;
    await click("#switch");
    await click('[aria-label="查看完整截图"]');
    await wait('document.querySelector("[role=alert]")');
    await screenshot("original-error-mobile-dark");
    scenario.status = 200;
    await evaluate(
      'Array.from(document.querySelectorAll("button")).find(b=>b.textContent==="重新加载原图").click()',
    );
    await wait('document.querySelector("[role=dialog] [data-slot=spinner]")');
    await wait(previewLoaded);
    await click('[data-slot="dialog-close"]');
    await wait('!document.querySelector("[role=dialog]")');
    await click("#remove");
    assert.equal(
      await evaluate('document.querySelector("[data-slot=attachment]") !== null'),
      false,
    );
    await click("#thread");
    await wait(loaded);
    const originalsBefore = requests.filter((r) => !r.thumbnail).length;
    await click('[aria-label="查看完整截图"]');
    await wait(previewLoaded);
    assert.equal(
      requests.filter((r) => !r.thumbnail).length,
      originalsBefore + 1,
      "新会话不复用旧原图",
    );
    await click('[data-slot="dialog-close"]');
    await wait('!document.querySelector("[role=dialog]")');
    await click("#history");
    await delay(1000);
    assert.equal(
      requests.filter((r) => r.url.includes("/old-20?")).length,
      0,
      "远离视口的历史图片不加载",
    );
    await evaluate(`document.querySelector('img[alt="历史截图 20"]').scrollIntoView()`);
    await wait(`document.querySelector('img[alt="历史截图 20"]').naturalWidth > 0`);
    assert.equal(requests.filter((r) => r.url.includes("/old-20?")).length, 1);
    report.cases.push(
      "mobile dark, keyboard, thumbnail failure, original retry, session disposal, history lazy loading",
    );
  }
  report.metrics.bytes = requests.reduce((sum, r) => sum + r.bytes, 0);
  report.requests = requests;
  assert.deepEqual(report.browserErrors, [], "浏览器无未处理异常");
  report.passed = true;
} catch (error) {
  report.error = String(error);
  if (client) {
    const shot = await client.Page.captureScreenshot({ format: "png" }).catch(() => null);
    if (shot) await writeFile(path.join(output, "failure.png"), Buffer.from(shot.data, "base64"));
  }
  throw error;
} finally {
  report.requests = requests;
  await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  await client?.close();
  await browser?.close();
  if (server) {
    server.httpServer.closeAllConnections();
    await new Promise((resolve, reject) =>
      server.httpServer.close((error) => (error ? reject(error) : resolve())),
    );
  }
  const resolved = path.resolve(profile);
  if (
    resolved.startsWith(path.resolve(tmpdir()) + path.sep) &&
    path.basename(resolved).startsWith("taskrelay-web-images-")
  )
    await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}
console.log(
  JSON.stringify({ passed: report.passed, cases: report.cases, metrics: report.metrics }),
);
