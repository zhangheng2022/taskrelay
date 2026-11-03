import { app, utilityProcess } from "electron";
import http from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Journal } from "./journal";
import { OwnedBrowser } from "./browser";
export async function packagedSmoke(
  resources: string,
  executorPath: string,
  output: string,
) {
  const directory = path.join(path.dirname(output), "中文 路径 smoke");
  await mkdir(directory, { recursive: true });
  const journal = new Journal(directory),
    browser = new OwnedBrowser(
      path.join(resources, "browser"),
      path.join(directory, "profiles"),
      journal,
    );
  let submissions = 0,
    checkins = 0,
    wrongCodes = 0;
  const loginForm =
    '<form action="/login" method="post"><label>用户名<input name="username" id="username"></label><label>验证码<input name="code" id="code"></label><button id="submit">登录</button></form>';
  const server = http.createServer(async (req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    const route = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (route === "/login") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const fields = new URLSearchParams(body);
      if (
        fields.get("username") === "fixture-user" &&
        fields.get("code") === "0012aB"
      ) {
        res.setHeader(
          "Set-Cookie",
          "fixture_session=authorized; HttpOnly; SameSite=Strict; Path=/",
        );
        res.end(
          '<h1 id="login-success">已登录</h1><form action="/checkin" method="post"><button id="checkin">签到</button></form>',
        );
      } else {
        wrongCodes++;
        res.end('<h1 id="invalid-code">验证失败</h1>' + loginForm);
      }
      return;
    }
    if (route === "/checkin") {
      if (!req.headers.cookie?.includes("fixture_session=authorized")) {
        res.writeHead(403);
        res.end("登录已过期");
        return;
      }
      checkins++;
      res.end('<h1 id="checked-in">签到成功</h1>');
      return;
    }
    if (route === "/form") {
      res.end(
        '<form action="/submitted" method="post"><label>内容<input id="comment" name="comment"></label><button id="submit">提交表单</button></form>',
      );
      return;
    }
    if (route === "/submitted") {
      submissions++;
      res.end('<h1 id="result">提交成功</h1><p>仅提交一次</p>');
      return;
    }
    res.end(
      '<!doctype html><html lang="zh"><meta charset="utf-8"><title>TaskRelay 验收测试站</title><h1>测试信息</h1><p id="query">今日数值 42</p><button id="monitor" onclick="document.getElementById(\'query\').textContent=\'数值变为 43\'">刷新监测</button>' +
        loginForm +
        "</html>",
    );
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const fixturePort = (server.address() as import("node:net").AddressInfo).port;
  // Fixed test server only. This path never accepts tasks, credentials, or a cloud token.
  const launched = await browser.launch("smoke_fixture", fixturePort);
  const child = utilityProcess.fork(executorPath, [], {
    stdio: "pipe",
    serviceName: "TaskRelay Packaging Smoke",
  });
  const report: Record<string, unknown> = {
    packaged: app.isPackaged,
    electron: process.versions.electron,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
  };
  try {
    const result = await new Promise<Record<string, unknown>>(
      (resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("PACKAGED_SMOKE_TIMEOUT")),
          60000,
        );
        child.on("message", (data) => {
          if (data.type === "smoke-result") {
            clearTimeout(timer);
            data.error ? reject(new Error(data.error)) : resolve(data.result);
          }
        });
        child.once("exit", (code) => {
          if (code) reject(new Error(`SMOKE_EXECUTOR_EXIT_${code}`));
        });
        child.postMessage({
          type: "smoke",
          cdpUrl: launched.cdpUrl,
          url: `http://127.0.0.1:${fixturePort}`,
          extensionPath: path.join(resources, "stagehand-extension"),
        });
      },
    );
    Object.assign(report, result, {
      submissions,
      checkins,
      wrongCodes,
      passed: submissions === 1 && checkins === 1 && wrongCodes === 1,
    });
  } catch (e) {
    Object.assign(report, { passed: false, error: (e as Error).message });
  } finally {
    child.kill();
    await browser.close();
    server.close();
    journal.close();
    await writeFile(output, JSON.stringify(report, null, 2));
  }
  return report.passed === true;
}
