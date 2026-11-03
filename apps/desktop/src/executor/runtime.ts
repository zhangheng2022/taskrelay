import type { ClientLLM, Page } from "@browserbasehq/stagehand";
import {
  limits,
  browserActionSchema,
  type TaskRun,
  type BrowserAction,
  type HumanChallenge,
} from "../../../../packages/contracts/src/index";
import {
  actionPolicy,
  verifyPage,
  type TargetFacts,
} from "../../../../packages/contracts/src/policy";
import {
  allowedNavigation,
  hash,
} from "../../../../packages/contracts/src/security";
import { startProxy } from "./proxy";
export interface RuntimePort {
  rpc<T>(path: string, body?: unknown, binary?: Uint8Array): Promise<T>;
  checkpoint(state: string, payload: unknown): Promise<void>;
  cancelled(): boolean;
}
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export async function execute(run: TaskRun, port: RuntimePort) {
  const sdk = await import("@browserbasehq/stagehand"); // ESM-only: keep native import() in packaged CJS.
  const proxy = await startProxy();
  let stagehand: Awaited<ReturnType<typeof sdk.Stagehand.create>> | undefined;
  let sequence = 0,
    writePending = false,
    writeOccurred = false,
    waitedMs = 0,
    humanStarted = 0;
  const started = Date.now();
  const api = <T>(
    suffix: string,
    body: Record<string, unknown> = {},
    binary?: Uint8Array,
  ) =>
    port.rpc<T>(
      `/api/runner/runs/${run.id}/${suffix}`,
      { epoch: run.leaseEpoch, ...body },
      binary,
    );
  const event = async (kind: string, message: string) =>
    api("events", {
      events: [
        {
          id: crypto.randomUUID(),
          sequence: ++sequence,
          kind,
          message,
          at: new Date().toISOString(),
        },
      ],
    });
  const guard = () => {
    if (port.cancelled()) throw new Error("CANCEL_REQUESTED");
    if (
      Date.now() -
        started -
        waitedMs -
        (humanStarted ? Date.now() - humanStarted : 0) >
      limits.durationMs
    )
      throw new Error("EXECUTION_TIMEOUT");
  };
  try {
    await port.checkpoint("starting", { run });
    const launch = await port.rpc<{ cdpUrl: string }>("local:browser", {
      proxyPort: proxy.port,
      accountId: run.task.accountId ?? `task_${run.taskId}`,
    });
    const browser = await sdk.localBrowser.connect({ cdpUrl: launch.cdpUrl });
    const model: ClientLLM = {
      generate: async (request) => api("stagehand", { request }),
    };
    stagehand = await sdk.Stagehand.create({
      browser,
      model,
      cache: false,
      selfHeal: false,
      logging: { level: "off" },
    });
    await browser.context.setDomainPolicy({
      allowedDomains: run.task.allowedOrigins.map((x) => new URL(x).hostname),
    });
    const page =
      (await browser.context.pages())[0] ?? (await browser.context.newPage());
    await page.goto(run.task.entryUrl);
    await event("started", "已加载当前任务的独立账号环境");
    const history: string[] = [];
    let extraction: unknown;
    async function observe() {
      guard();
      const url = await page.url();
      allowedNavigation(url, run.task.allowedOrigins);
      const text = await page.locator("body").innerText();
      // Values are excluded, including password and OTP fields.
      const elements = await page.evaluate(() =>
        Array.from(document.querySelectorAll("a,button,input,select,textarea"))
          .filter((e) => (e as HTMLElement).offsetParent !== null)
          .slice(0, 160)
          .map((e) => ({
            tag: e.tagName,
            id: e.id,
            name: e.getAttribute("name"),
            type: e.getAttribute("type"),
            label:
              e.getAttribute("aria-label") ??
              (e instanceof HTMLInputElement
                ? ""
                : e.textContent?.slice(0, 100)),
            href: e instanceof HTMLAnchorElement ? e.href : null,
          })),
      );
      return { url, text: text.slice(0, 30000), elements };
    }
    async function facts(target: string): Promise<TargetFacts> {
      if ((await page.locator(target).count()) !== 1)
        throw new Error("TARGET_NOT_UNIQUE");
      const result = await page.evaluate((selector) => {
        const e = document.querySelector(selector);
        if (!e) throw new Error("TARGET_MISSING");
        return {
          tag: e.tagName,
          type: e.getAttribute("type") ?? "",
          text: (e.getAttribute("aria-label") ?? e.textContent ?? "").slice(
            0,
            2000,
          ),
          href: e instanceof HTMLAnchorElement ? e.href : null,
          form: e.closest("form")
            ? Array.from(
                e.closest("form")!.querySelectorAll("input,textarea,select"),
              ).map((f) => ({
                name: f.getAttribute("name"),
                type: f.getAttribute("type"),
                value: (f as HTMLInputElement).value,
                checked: (f as HTMLInputElement).checked,
              }))
            : [],
        };
      }, target);
      const { form, ...safe } = result;
      return { ...safe, formDigest: await hash(JSON.stringify(form)) };
    }
    async function human(
      action: BrowserAction,
      stepId: string,
      digest?: string,
    ): Promise<string> {
      if (run.reconciliationOf) throw new Error("RECONCILIATION_READ_ONLY");
      if (
        ["code", "information"].includes(
          action.challengeKind ?? "information",
        ) &&
        !run.task.allowedActions.includes("fill")
      )
        throw new Error("FILL_NOT_AUTHORIZED");
      const begin = Date.now();
      humanStarted = begin;
      const challenge = await api<HumanChallenge>("challenges", {
        challenge: {
          kind: action.challengeKind ?? "information",
          instruction: action.instruction,
          stepId,
          version: sequence + 1,
          target: action.target ?? undefined,
          actionDigest: digest,
        },
      });
      await event(
        "waiting",
        challenge.kind === "approval"
          ? "等待高影响操作确认"
          : "等待用户完成当前验证",
      );
      if (challenge.kind === "unsupported")
        throw new Error("CHALLENGE_UNSUPPORTED");
      if (challenge.kind === "scan") {
        if (!action.target) throw new Error("QR_TARGET_REQUIRED");
        await facts(action.target);
        const clip = await page.evaluate((selector) => {
          const r = document.querySelector(selector)!.getBoundingClientRect();
          return {
            x: Math.max(0, r.x),
            y: Math.max(0, r.y),
            width: r.width,
            height: r.height,
          };
        }, action.target);
        if (
          clip.width < 16 ||
          clip.height < 16 ||
          clip.width > 800 ||
          clip.height > 800
        )
          throw new Error("QR_REGION_INVALID");
        const png = await page.screenshot({ type: "png", clip });
        await api(`challenges/${challenge.id}/image`, {}, png);
      }
      const deliveryId = crypto.randomUUID();
      try {
        while (Date.now() - begin < limits.waitMs) {
          guard();
          const reply = await api<{
            ready: boolean;
            value?: string;
            confirmed?: boolean;
          }>(`challenges/${challenge.id}/consume`, {
            deliveryId,
            version: challenge.version,
            stepId: challenge.stepId,
          });
          if (reply.ready) {
            // Persist consumption BEFORE filling. After a crash, never re-fill this response.
            await port.checkpoint("human-delivery", {
              challengeId: challenge.id,
              deliveryId,
              writePending: true,
            });
            if (["code", "information"].includes(challenge.kind)) {
              if (!challenge.target || typeof reply.value !== "string")
                throw new Error("CHALLENGE_TARGET_REQUIRED");
              allowedNavigation(await page.url(), run.task.allowedOrigins);
              await facts(challenge.target);
              writePending = true;
              writeOccurred = true;
              await page.locator(challenge.target).fill(reply.value);
              if (
                (await page.locator(challenge.target).inputValue()) !==
                reply.value
              )
                throw new Error("CHALLENGE_FIELD_UNVERIFIED");
            }
            await observe();
            await api(`challenges/${challenge.id}/ack`, { deliveryId });
            writePending = false;
            await port.checkpoint("observed", {
              mayHaveWritten: writeOccurred,
              run,
            });
            await event(
              "resumed",
              "用户回复已用于当前步骤，将继续检查站点实际状态",
            );
            return challenge.id;
          }
          await delay(1500);
        }
        throw new Error("HUMAN_WAIT_TIMEOUT");
      } finally {
        waitedMs += Date.now() - begin;
        humanStarted = 0;
      }
    }
    for (let index = 0; index < limits.actions; index++) {
      guard();
      const before = await observe();
      if (
        verifyPage(
          run.task.verification.kind,
          run.task.verification.value,
          before,
        )
      ) {
        if (run.task.verification.kind === "extraction") {
          // SDK inference is routed through the Workers callback, never a local API key.
          extraction = (await stagehand.extract(run.task.goal, { page })).data;
        }
        await event("verification", "成功判据已在当前页面核验");
        await port.checkpoint("finishing", { run, status: "succeeded" });
        await api("finish", {
          status: "succeeded",
          result: {
            summary:
              index === 0
                ? "页面已满足任务成功判据。"
                : "任务完成，页面结果已核验。",
            outcome:
              index === 0
                ? "already_done"
                : extraction
                  ? "read_result"
                  : "completed_now",
            ...(extraction ? { data: extraction } : {}),
            evidence: [
              {
                url: before.url,
                quote: before.text.slice(
                  Math.max(
                    0,
                    before.text.indexOf(run.task.verification.value) - 100,
                  ),
                  Math.max(
                    0,
                    before.text.indexOf(run.task.verification.value) - 100,
                  ) + 1800,
                ),
                capturedAt: new Date().toISOString(),
              },
            ],
          },
        });
        await port.checkpoint("finished", { status: "succeeded" });
        return;
      }
      const action = browserActionSchema.parse(
        await api("plan", {
          observation: JSON.stringify(before),
          url: before.url,
          history,
        }),
      );
      if (
        run.reconciliationOf &&
        !["navigate", "observe", "extract", "wait", "finish"].includes(
          action.kind,
        )
      )
        throw new Error("RECONCILIATION_READ_ONLY");
      if (action.kind === "finish")
        throw new Error("SUCCESS_CRITERION_NOT_MET");
      if (action.kind === "human") {
        await human(action, `step_${index}`);
        history.push("已处理验证回复，需检查是否通过");
        continue;
      }
      if (action.kind === "wait") {
        await delay(1500);
        history.push("已等待页面更新");
        continue;
      }
      if (action.kind === "observe" || action.kind === "extract") {
        await event("observed", "已读取页面信息");
        history.push("已观察页面，继续执行或完成核验");
        continue;
      }
      let targetFacts =
        action.target && action.kind === "click"
          ? await facts(action.target)
          : undefined;
      const policy = actionPolicy(run.task, action, before.url, targetFacts);
      if (["fill", "credential"].includes(action.kind) && action.target)
        await facts(action.target);
      const actionId = crypto.randomUUID(),
        digest = await hash(
          JSON.stringify({ action, url: before.url, facts: targetFacts }),
        );
      let approvalId: string | undefined;
      if (policy.approval)
        approvalId = await human(
          {
            ...action,
            kind: "human",
            challengeKind: "approval",
            instruction: `确认在 ${before.url} 执行：${targetFacts?.text ?? action.instruction}\n目标：${action.target}\n${action.instruction}`,
          },
          `approval_${index}`,
          digest,
        );
      guard();
      // A page changed during an approval wait must be inspected and confirmed again.
      if (
        (await page.url()) !== before.url ||
        (action.kind === "click" &&
          JSON.stringify(await facts(action.target!)) !==
            JSON.stringify(targetFacts))
      )
        throw new Error("APPROVAL_TARGET_CHANGED");
      await port.checkpoint("intent", {
        run,
        actionId,
        digest,
        writePending: policy.write,
        mayHaveWritten: writeOccurred || policy.write,
      });
      writePending = policy.write;
      writeOccurred ||= policy.write;
      const intent = await api<{ status: string; digest: string }>("intent", {
        actionId,
        action,
        url: before.url,
        facts: targetFacts,
        approvalId,
      });
      if (intent.status !== "intended" || intent.digest !== digest)
        throw new Error("ACTION_ALREADY_EXECUTED");
      guard();
      try {
        if (action.kind === "navigate") await page.goto(action.target!);
        else if (action.kind === "click")
          await page.locator(action.target!).click();
        else if (action.kind === "fill") {
          await page.locator(action.target!).fill(action.value ?? "");
          if (
            (await page.locator(action.target!).inputValue()) !==
            (action.value ?? "")
          )
            throw new Error("FIELD_UNVERIFIED");
        } else if (action.kind === "credential") {
          if (action.value !== "username" && action.value !== "password")
            throw new Error("CREDENTIAL_FIELD_INVALID");
          const credentials = await api<{ username: string; password: string }>(
            "credentials",
            { url: await page.url() },
          );
          await page.locator(action.target!).fill(credentials[action.value]);
          if (
            (await page.locator(action.target!).inputValue()) !==
            credentials[action.value]
          )
            throw new Error("FIELD_UNVERIFIED");
        }
      } catch (error) {
        if (
          !/navigated or closed|execution context/i.test(
            (error as Error).message,
          )
        )
          throw error;
      }
      // A navigation can retire the old CDP target before click() returns. Retry only reads.
      await delay(400);
      let after: Awaited<ReturnType<typeof observe>> | undefined;
      for (let attempt = 0; attempt < 10; attempt++) {
        try {
          after = await observe();
          break;
        } catch (error) {
          if (
            !/navigated or closed|execution context/i.test(
              (error as Error).message,
            ) ||
            attempt === 9
          )
            throw error;
          await delay(200);
        }
      }
      if (!after) throw new Error("PAGE_OBSERVATION_FAILED");
      // Do not clear a possibly submitted write unless a changed page or a verified field value is observed.
      const observed =
        action.kind === "navigate" ||
        ["fill", "credential"].includes(action.kind) ||
        after.url !== before.url ||
        after.text !== before.text;
      if (!observed && policy.write) throw new Error("WRITE_OUTCOME_UNKNOWN");
      await api("action-complete", {
        actionId,
        digest,
        url: after.url,
        observed: true,
      });
      writePending = false;
      await port.checkpoint("observed", {
        mayHaveWritten: writeOccurred,
        run,
        actionId,
      });
      await event(
        "action",
        `已执行${({ navigate: "页面导航", click: "页面操作", fill: "内容填写", credential: "账号填写" } as Record<string, string>)[action.kind]}并重新观察页面`,
      );
      history.push(`${action.kind}: ${action.instruction.slice(0, 120)}`);
    }
    throw new Error("ACTION_LIMIT");
  } catch (error) {
    const code = /^[A-Z_]+$/.test((error as Error).message)
      ? (error as Error).message
      : "EXECUTOR_ERROR";
    writePending ||= writeOccurred;
    const status = writePending
      ? "unknown"
      : code === "CANCEL_REQUESTED"
        ? "cancelled"
        : "failed";
    const result = {
      summary: writePending
        ? "操作可能已经提交，需要先核查实际结果。"
        : code === "CANCEL_REQUESTED"
          ? "本次运行已停止。"
          : `执行中止：${code}`,
      outcome: writePending
        ? "unconfirmed"
        : code === "CANCEL_REQUESTED"
          ? "stopped"
          : "error",
      evidence: [],
      errorCode: code,
    };
    await port.checkpoint("finishing", { run, status, result });
    try {
      await api("finish", { status, result });
      await port.checkpoint("finished", { status });
    } catch {
      /* Main journal/outbox and server lease expiry own recovery. */
    }
  } finally {
    try {
      await stagehand?.close();
    } finally {
      await proxy.close();
      await port.rpc("local:close-browser").catch(() => {});
    }
  }
}
