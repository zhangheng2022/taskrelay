/** 隔离 Chromium 验收设置页：真实组件/Transport，合成数据，不连接业务服务。 */
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

const output = path.resolve(".impeccable/review/settings"),
  profile = await mkdtemp(path.join(tmpdir(), "taskrelay-settings-"));
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
  const select = async (selector, value) =>
    callPage(
      "function(selector,value){const e=document.querySelector(selector);e.value=value;e.dispatchEvent(new Event('change',{bubbles:true}))}",
      [selector, value],
    );
  const shot = async (name) => {
    await delay(200);
    const r = await client.Page.captureScreenshot({ format: "png" });
    await writeFile(path.join(output, name + ".png"), Buffer.from(r.data, "base64"));
  };
  const navigate = async (hash, admin = true) => {
    await client.Page.navigate({
      url: origin + "ui-fixture.html?settings&long" + (admin ? "&admin" : "") + hash,
    });
    await wait('document.querySelector(".settings-layout")');
  };
  for (const width of [1280, 390]) {
    await client.Emulation.setDeviceMetricsOverride({
      width,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await navigate("#settings/general");
    for (const theme of ["light", "dark", "system"]) {
      await select("#settings-theme", theme);
      if (theme === "system")
        await client.Emulation.setEmulatedMedia({
          features: [{ name: "prefers-color-scheme", value: "dark" }],
        });
      await wait(`document.documentElement.classList.contains('dark')===${theme !== "light"}`);
      await shot(`${width}-general-${theme}`);
      assert.equal(await evaluate("document.documentElement.scrollWidth>innerWidth"), false);
    }
    await select("#settings-theme", "light");
    if (width === 390) {
      await click("全部设置");
      await wait("location.hash==='#settings/index'");
      await shot("mobile-index");
      await client.Page.navigate({ url: origin + "ui-fixture.html?settings&long&admin#runs" });
      await wait('document.querySelector("[data-slot=sidebar-trigger]")');
      await evaluate('document.querySelector("[data-slot=sidebar-trigger]").click()');
      await click("设置");
      await wait("location.hash==='#settings/index'");
      report.cases.push("mobile-main-sidebar-settings-index");
    }
    await click("任务记忆");
    await wait('document.querySelectorAll(".settings-row").length===30');
    await shot(width === 390 ? "mobile" : "desktop");
    await click("加载更多记忆");
    await wait('document.querySelectorAll(".settings-row").length===60');
    assert.equal(await evaluate("document.documentElement.scrollWidth>innerWidth"), false);
    await evaluate("document.querySelector('#memory-text').focus()");
    await client.Input.imeSetComposition({ text: "中文输入", selectionStart: 4, selectionEnd: 4 });
    await client.Input.insertText({ text: "中文草稿" });
    assert.equal(await evaluate("document.querySelector('#memory-text').value"), "中文草稿");
    if (width === 390) await click("全部设置");
    else await click("通用");
    await wait('document.querySelector("[role=alertdialog]")');
    await shot(`${width}-discard-confirm`);
    await click("取消");
    assert.equal(await evaluate("document.querySelector('#memory-text').value"), "中文草稿");
    if (width === 390) await click("全部设置");
    else await click("通用");
    await wait('document.querySelector("[role=alertdialog]")');
    await click("放弃修改");
    await wait("!document.querySelector('#memory-text')");
    if (width === 390) await click("通用");
    await evaluate("history.back()");
    await wait("location.hash!== '#settings/general'");
    await evaluate("history.forward()");
    await wait("location.hash=== '#settings/general'");
    await client.Page.reload();
    await wait('document.querySelector("#settings-theme")');
    report.cases.push(`${width}:themes,overflow,pagination,IME,dirty-confirm,back-forward,reload`);
  }
  for (const section of ["accounts", "models", "devices", "users", "operations", "data"]) {
    await navigate("#settings/" + section);
    await delay(500);
    await shot("mobile-" + section);
    assert.equal(await evaluate("document.documentElement.scrollWidth>innerWidth"), false, section);
  }
  await navigate("#settings/models", false);
  assert.equal(
    await evaluate(
      "document.querySelector('.settings-navigation').textContent.includes('管理员设置')",
    ),
    false,
  );
  assert.ok(
    await evaluate("document.querySelector('.settings-detail').textContent.includes('通用')"),
  );
  report.cases.push("admin-sections-and-user-role");
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
    path.basename(resolved).startsWith("taskrelay-settings-")
  )
    await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}
console.log(JSON.stringify(report));
