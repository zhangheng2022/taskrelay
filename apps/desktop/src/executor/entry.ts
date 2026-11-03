import { execute } from "./runtime";
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
    let phase = "connect";
    try {
      const sdk = await import("@browserbasehq/stagehand");
      const browser = await sdk.localBrowser.connect({ cdpUrl: data.cdpUrl });
      let callbacks = 0;
      const stagehand = await sdk.Stagehand.create({
        browser,
        cache: false,
        logging: { level: "off" },
        model: {
          generate: async (request) => {
            callbacks++;
            if (request.responseFormat?.type !== "json_schema")
              throw new Error("SMOKE_SCHEMA_EXPECTED");
            const schema = request.responseFormat.schema as {
              properties?: Record<string, unknown>;
            };
            const content: Record<string, string | boolean> =
              schema.properties && "progress" in schema.properties
                ? { progress: "Read fixture value", completed: true }
                : { value: "42" };
            return {
              role: "assistant",
              content: [{ type: "text", text: JSON.stringify(content) }],
              outputFormat: "json_schema",
              structuredContent: content,
            };
          },
        },
      });
      const page = (await browser.context.pages())[0];
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
      const extracted = await stagehand.extract(
        "Read the value",
        z.object({ value: z.string() }),
        { page },
      );
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
      phase = "close";
      await stagehand.close();
      parent.postMessage({
        type: "smoke-result",
        result: {
          stagehand: "4.3.0",
          nativeEsmImport: true,
          query: true,
          monitor: true,
          loginCheckin: true,
          wrongCodeRejected: true,
          formSubmit: true,
          leadingZero: true,
          modelCallback: callbacks > 0,
          extracted,
        },
      });
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
