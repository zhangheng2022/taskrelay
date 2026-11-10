/** 隔离 Chromium 验收定时卡片：真实组件/Transport，合成数据，不连接业务服务。 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { launch } from "@puppeteer/browsers";
import CDP from "chrome-remote-interface";

const output = path.resolve(".impeccable/review/schedule"),
  profile = await mkdtemp(path.join(tmpdir(), "taskrelay-schedule-"));
await mkdir(output, { recursive: true });
const report = { passed: false, startedAt: new Date().toISOString(), cases: [], errors: [] };
let server, browser, client;
try {
  server = await createServer({
    configFile: false,
    root: path.resolve("apps/web"),
    plugins: [react(), tailwindcss()],
    cacheDir: path.join(profile, "vite"),
    server: { host: "127.0.0.1", port: 0 },
    logLevel: "error",
  });
  await server.listen();
  const origin = server.resolvedUrls.local[0];
  browser = launch({
    executablePath: path.resolve("resources/browser/chrome-win64/chrome.exe"),
    args: [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--disable-background-networking",
    ],
  });
  const endpoint = await browser.waitForLineOutput(/DevTools listening on (ws:\/\/.*)/, 20000),
    port = Number(new URL(endpoint).port);
  const tab = await CDP.New({ host: "127.0.0.1", port });
  client = await CDP({ host: "127.0.0.1", port, target: tab.id, local: true });
  await client.Page.enable();
  await client.Runtime.enable();
  client.Runtime.exceptionThrown(({ exceptionDetails: e }) =>
    report.errors.push(e.exception?.description ?? e.text),
  );
  const evaluate = async (expression) => {
    const r = await client.Runtime.evaluate({
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  const wait = async (expression) => {
    const until = Date.now() + 30000;
    while (true) {
      try {
        if (await evaluate(`Boolean(${expression})`)) return;
      } catch (error) {
        if (!/navigated|context|target/i.test(String(error))) throw error;
      }
      if (Date.now() > until) throw Error("BROWSER_WAIT:" + expression);
      await delay(50);
    }
  };
  // 参数独立交给 CDP，文字及选择器不参与拼接页面代码。
  const callPage = async (functionDeclaration, values) => {
    const { result: target } = await client.Runtime.evaluate({ expression: "globalThis" });
    try {
      const result = await client.Runtime.callFunctionOn({
        objectId: target.objectId,
        functionDeclaration,
        arguments: values.map((value) => ({ value })),
        returnByValue: true,
      });
      if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
    } finally {
      await client.Runtime.releaseObject({ objectId: target.objectId });
    }
  };
  const click = async (text) =>
    callPage(
      "function(text){Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===text && b.getBoundingClientRect().width>0).click()}",
      [text],
    );
  const shot = async (name) => {
    await delay(600);
    const r = await client.Page.captureScreenshot({ format: "png" });
    await writeFile(path.join(output, name + ".png"), Buffer.from(r.data, "base64"));
  };
  for (const width of [1280, 390]) {
    await client.Emulation.setDeviceMetricsOverride({
      width,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    for (const theme of ["light", "dark"]) {
      await client.Page.navigate({
        url:
          origin + `ui-fixture.html?state=done&schedule&history&case=${width}-${theme}#demo_task`,
      });
      await wait(`document.querySelector('[aria-label="定时任务：未开启"]')`);
      await evaluate(`document.documentElement.classList.toggle('dark',${theme === "dark"})`);
      await wait(`document.querySelector('[data-slot="message-scroller-viewport"]')`);
      await evaluate(
        `document.querySelector('[data-slot="message-scroller-viewport"]').scrollTop=100`,
      );
      await delay(300);
      const scrollBefore = await evaluate(
        `document.querySelector('[data-slot="message-scroller-viewport"]').scrollTop`,
      );
      await evaluate(`document.querySelector('[aria-label="定时任务：未开启"]').focus()`);
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
        text: "\r",
      });
      await wait(`document.querySelector('[role="dialog"]')`);
      await shot(`${width}-${theme}-card`);
      assert.equal(await evaluate("document.documentElement.scrollWidth>innerWidth"), false);
      await click("预览执行时间");
      await wait(
        'Array.from(document.querySelectorAll("button")).some(b=>b.textContent==="保存并启用"&&!b.disabled)',
      );
      await click("保存并启用");
      await wait('document.body.textContent.includes("已保存并启用")');
      await wait(
        'Array.from(document.querySelectorAll("button")).some(b=>b.textContent==="暂停定时"&&!b.disabled)',
      );
      await click("暂停定时");
      await wait('document.body.textContent.includes("已暂停，当前运行不受影响")');
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
      await wait(`!document.querySelector('[role="dialog"]')`);
      const scrollAfter = await evaluate(
        `document.querySelector('[data-slot="message-scroller-viewport"]').scrollTop`,
      );
      assert.ok(
        Math.abs(scrollBefore - scrollAfter) < 3,
        `history scroll changed: ${scrollBefore} -> ${scrollAfter}`,
      );
      report.cases.push(`${width}-${theme}-preview-save-pause-keyboard-history`);
    }
  }
  assert.deepEqual(report.errors, []);
  report.passed = true;
} finally {
  await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  await client?.close();
  await browser?.close();
  await server?.close();
  const resolved = path.resolve(profile);
  if (
    resolved.startsWith(path.resolve(tmpdir()) + path.sep) &&
    path.basename(resolved).startsWith("taskrelay-schedule-")
  )
    await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}
console.log(JSON.stringify(report));
