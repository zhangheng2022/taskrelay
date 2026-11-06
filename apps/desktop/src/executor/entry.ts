import { execute,connectExecutionBrowser } from "./runtime";
import {smokeExecutionGraph} from './graph-smoke';
import { findPackageJSON } from 'node:module';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import type { TaskRun } from "../../../../packages/contracts/src/index";
const parent = process.parentPort;
if (!parent) throw new Error("UTILITY_PROCESS_REQUIRED");
let generation = "",
  cancelled = false,
  started = false;
const pending = new Map<
  string,
  {
    resolve: (data: any) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();
function rpc<T>(path: string, body?: unknown, binary?: Uint8Array): Promise<T> {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("IPC_TIMEOUT"));
    }, 185000);
    pending.set(id, { resolve, reject, timer });
    parent!.postMessage({ generation, id, type: "rpc", path, body, binary });
  });
}
parent.on("message", async ({ data }) => {
  if (data.type === "smoke" && !started) {
    started = true;
    process.env.STAGEHAND_EXTENSION_DIRECTORY_PATH = data.extensionPath;
    let phase = "execution-graph";
    try {
      const graphSmoke=await smokeExecutionGraph();
      phase='connect';
      const sdk = await import("@browserbasehq/stagehand");
      let callbacks = 0;
      const {browser,session:stagehand} = await connectExecutionBrowser(sdk,data.cdpUrl,{
          generate: async (request) => {
            callbacks++;
            if (request.responseFormat?.type !== "json_schema")
              throw new Error("SMOKE_SCHEMA_EXPECTED");
            const schema = request.responseFormat.schema as {
              properties?: Record<string, unknown>;
            };
            const text=request.messages.flatMap(m=>(Array.isArray(m.content)?m.content:[m.content]).filter(p=>p.type==='text').map(p=>p.type==='text'?p.text:'')).join('\n');
            const password=phase==='stagehand-password';
            const elementId=password?text.match(/\[([\d]+-[\d]+)\][^\n]*textbox[^\n]*密码/)?.[1]:text.match(/\[([\d]+-[\d]+)\][^\n]*继续登录/)?.[1];
            const target={elementId,description:password?'密码':'继续登录',method:password?'fill':'click',arguments:password?['synthetic-smoke-secret']:[]};
            const content: Record<string, unknown> = schema.properties&&'elements' in schema.properties
              ? {elements:[target]}
              : schema.properties&&'action' in schema.properties
              ? {action:target,twoStep:false}
              : schema.properties && "progress" in schema.properties
                ? { progress: "Read fixture value", completed: true }
                : { value: "42" };
            return {
              role: "assistant",
              content: [{ type: "text", text: JSON.stringify(content) }],
              outputFormat: "json_schema",
              structuredContent: content as any,
            };
          },
      });
      const smokeResult = await (async () => { try {
      const page = (await browser.context.pages())[0];
      if (!page) throw new Error("SMOKE_PAGE_NOT_FOUND");
      const clickAndVerify = async (target: string, selector: string) => {
        try {
          await page.locator(target).click();
        } catch (error) {
          if (
            !/navigated or closed|execution context/i.test(
              (error as Error).message,
            )
          )
            throw error;
        }
        for (let i = 0; i < 20; i++) {
          try {
            if ((await page.locator(selector).count()) === 1) return;
          } catch {
            /* Only the observation is retried after navigation, never the effect. */
          }
          await new Promise((r) => setTimeout(r, 150));
        }
        throw new Error("FIXTURE_POSTCONDITION_FAILED");
      };
      phase = "query";
      await page.goto(data.url);
      if (!(await page.locator("#query").innerText()).includes("42"))
        throw new Error("QUERY_FAILED");
      phase = "extract";
      const { z } = await import("zod");
      const ValueSchema = z.object({ value: z.string() });
      const extracted = await stagehand.extract(
        "Read the value",
        ValueSchema,
        { page },
      );
      if (extracted.data.value !== "42") throw new Error("STAGEHAND_EXTRACT_FAILED");
      phase = "monitor";
      await page.locator("#monitor").click();
      if (!(await page.locator("#query").innerText()).includes("43"))
        throw new Error("MONITOR_FAILED");
      phase = "wrong-code";
      await page.locator("#username").fill("fixture-user");
      await page.locator("#code").fill("wrong");
      await clickAndVerify("#submit", "#invalid-code");
      phase = "login";
      await page.locator("#username").fill("fixture-user");
      await page.locator("#code").fill("0012aB");
      if ((await page.locator("#code").inputValue()) !== "0012aB")
        throw new Error("LEADING_ZERO_LOST");
      await clickAndVerify("#submit", "#login-success");
      phase = "checkin";
      await clickAndVerify("#checkin", "#checked-in");
      phase = "form";
      await page.goto(data.url + "/form");
      await page.locator("#comment").fill("fixture content");
      await clickAndVerify("#submit", "#result");
      if (!(await page.locator("body").innerText()).includes("提交成功"))
        throw new Error("SUBMIT_FAILED");
      phase='multi-step-login';
      await page.goto(data.url+'/multi-login');
      await page.locator('#email').fill('fixture@example.com');
      await clickAndVerify('#next','#password');
      phase='stagehand-password';
      const filled=await stagehand.act('将 synthetic-smoke-secret 填入密码输入框',{page});
      if(!filled.data.success||await page.locator('#password').inputValue()!=='synthetic-smoke-secret')throw Error('STAGEHAND_PASSWORD_FAILED');
      phase='masked-snapshot';
      const {maskedScreenshot,loadingFacts}=await import('./snapshots');
      await page.locator('#password').fill('synthetic-smoke-secret');
      const masked=await maskedScreenshot(page,['synthetic-smoke-secret']);
      if(!masked.startsWith('iVBORw0KGgo')||await page.locator('[data-taskrelay-mask]').count()!==0||await page.locator('#password').inputValue()!=='synthetic-smoke-secret')throw Error('SNAPSHOT_MASK_FAILED');
      if((await loadingFacts(page)).readyState!=='complete')throw Error('SNAPSHOT_LOADING_FAILED');
      phase='stagehand-ai-actions';
      await page.goto(data.url+'/selectors');
      const discovered=await stagehand.observe('找到“继续登录”按钮',{page});
      if(!discovered.data.length)throw Error('STAGEHAND_OBSERVE_FAILED');
      const acted=await stagehand.act('点击“继续登录”按钮',{page});
      if(!acted.data.success||await page.evaluate(()=>document.body.dataset.clicked)!=='yes')throw Error('STAGEHAND_AI_ACT_FAILED');
      phase = "close";
      return {
          ...graphSmoke,
          // 从与原生 import 相同目录解析安装包，报告不再硬编码 SDK 版本。
          stagehand: JSON.parse(await readFile(findPackageJSON('@browserbasehq/stagehand', pathToFileURL(__filename))!, 'utf8')).version,
          stagehandPackagePath: findPackageJSON('@browserbasehq/stagehand', pathToFileURL(__filename)),
          nativeEsmImport: true,
          query: true,
          monitor: true,
          loginCheckin: true,
          wrongCodeRejected: true,
          formSubmit: true,
          leadingZero: true,
          multiStepLogin:true,
          maskedSnapshot:true,
          stagehandAiObserve:true,
          stagehandAiAct:true,
          stagehandAiPassword:true,
          modelCallback: callbacks > 0,
          extracted,
      };
      } finally {
        await stagehand.close();
      } })();
      parent.postMessage({ type: "smoke-result", result: smokeResult });
    } catch (e) {
      parent.postMessage({
        type: "smoke-result",
        error: phase + ": " + (e as Error).message,
      });
    }
  } else if (data.type === "start" && !started) {
    started = true;
    generation = data.generation;
    process.env.STAGEHAND_EXTENSION_DIRECTORY_PATH = data.extensionPath;
    const timer = setInterval(
      () => parent.postMessage({ generation, type: "alive" }),
      3000,
    );
    try {
      await execute(data.run as TaskRun, {
        rpc,
        checkpoint: (state, payload) =>
          rpc("local:checkpoint", { state, payload }),
        cancelled: () => cancelled,
      });
    } finally {
      clearInterval(timer);
      parent.postMessage({ generation, type: "done" });
    }
  } else if (data.generation === generation && data.type === "cancel") {
    cancelled = true;
  } else if (data.generation === generation && data.type === "reply") {
    const item = pending.get(data.id);
    if (!item) return;
    clearTimeout(item.timer);
    pending.delete(data.id);
    data.error ? item.reject(new Error(data.error)) : item.resolve(data.data);
  }
});
process.on("uncaughtException", () => {
  parent.postMessage({ generation, type: "fatal", error: "EXECUTOR_CRASH" });
  process.exit(1);
});
process.on("unhandledRejection", () => {
  parent.postMessage({ generation, type: "fatal", error: "EXECUTOR_CRASH" });
  process.exit(1);
});
