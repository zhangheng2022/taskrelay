import test from "node:test";
import assert from "node:assert/strict";
import { execute, type RuntimePort } from "../apps/desktop/src/executor/runtime";
import { run } from "./ui-fixtures";
import { infer, type ModelResponse } from "../packages/model/src/index";
import type { ClientLLM } from "@browserbasehq/stagehand";
import sharp from "sharp";
import { executionTimingSchema } from "../apps/desktop/src/shared/execution-timing";
const answer = (text: string): ModelResponse => ({
  text,
  calls: [],
  usage: { input: null, output: null },
});
const tool = (name: string, args: Record<string, unknown> = {}): ModelResponse => ({
  ...answer(""),
  calls: [{ id: crypto.randomUUID(), name, arguments: JSON.stringify(args) }],
});

test("正式 execute 等待流式工具参数完整再执行，并关联最终正文调用", async () => {
  let observedPartial = false;
  const enc = new TextEncoder();
  const result = await scenario([], {
    firstModel: async (clicks) => {
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const frame = (delta: unknown, finish: string | null = null) =>
        enc.encode(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
        );
      return infer(
        { baseUrl: "https://provider.example/v1", protocol: "chat", model: "fixture" },
        "key",
        { messages: [], stream: true },
        async () =>
          new Response(
            new ReadableStream({
              start(c) {
                controller = c;
                c.enqueue(
                  frame({
                    tool_calls: [
                      {
                        index: 0,
                        id: "partial",
                        function: { name: "act", arguments: '{"instruction":"' },
                      },
                    ],
                  }),
                );
                c.enqueue(frame({ content: "正在处理" }));
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
        async () => {
          assert.equal(clicks(), 0);
          observedPartial = true;
          controller.enqueue(
            frame(
              { tool_calls: [{ index: 0, function: { arguments: '点击按钮"}' } }] },
              "tool_calls",
            ),
          );
          controller.enqueue(enc.encode("data: [DONE]\n\n"));
          controller.close();
        },
      );
    },
  });
  assert.equal(observedPartial, true);
  assert.equal(result.clicks, 1);
  assert.equal(result.finish.status, "succeeded");
  const last = result.calls
    .filter((c) => c.path.endsWith("/model") && c.body.purpose === "decision")
    .at(-1)!;
  assert.equal(last.body.supportsDrafts, true);
  assert.equal(result.finish.sourceCallId, `execute_${run.id}_${last.body.requestId}`);
});

test("正式 execute 在短摘要仍无法容纳近期工具结果时保留大小诊断，不额外决策或重试", async () => {
  const result = await scenario([tool("extract", { instruction: "读取当前页面" })], {
    extraction: "private-diagnostic-content".repeat(1200),
  });
  assert.equal(result.finish.status, "failed");
  assert.match(result.finish.result.summary, /CONTEXT_SUMMARY_NOT_REDUCED/);
  const checkpoint = result.checkpoints.at(-1);
  assert.equal(checkpoint.state, "finished");
  const timing = executionTimingSchema.parse(checkpoint.payload.timing);
  const report = timing.contextSizes!.at(-1)!.report;
  assert.equal(report.failure, "CONTEXT_SUMMARY_NOT_REDUCED");
  assert.ok(report.summaryMessage!.estimatedTokens < report.budget.historyAllowanceTokens);
  assert.ok(report.preserved!.estimatedTokens > report.budget.historyAllowanceTokens);
  const largest = report.preserved!.largest[0];
  assert.equal(largest.tool, "extract");
  assert.ok(largest.sections.find((s) => s.section === "data")!.bytes > 20000);
  assert.doesNotMatch(JSON.stringify(timing), /private-diagnostic-content/);
  assert.equal(timing.phases.extract?.calls, 1);
  assert.equal(
    result.calls.filter((c) => c.path.endsWith("/model") && c.body.purpose === "summary").length,
    1,
  );
  assert.equal(
    result.calls.filter((c) => c.path.endsWith("/model") && c.body.purpose === "decision").length,
    1,
  );
  assert.equal(result.sessionCloses, 1);
  assert.equal(result.closed, true);
});

for (const changingNetworkFacts of [false, true])
  test(`正式 execute 保留完整网址及最新网络状态，并使用可解析引用：${changingNetworkFacts}`, async () => {
    const longUrl = "https://example.com/login?state=" + "a%2Fb".repeat(510) + "#fragment";
    const original = "用户补充要求".repeat(100);
    const result = await scenario(
      [
        tool("extract", { instruction: "读取页面" }),
        tool("act", { instruction: "打开登录页" }),
        tool("extract", { instruction: "核对当前页面" }),
        tool("act", { instruction: "处理当前页面" }),
      ],
      {
        afterActionUrl: longUrl,
        original,
        extraction: "页面事实".repeat(150),
        networkFacts: true,
        changingNetworkFacts,
        actionFeedback: "页面已返回实际观察结果。".repeat(15),
        summaryText: "事实摘要".repeat(80),
      },
    );
    assert.equal(result.finish.status, "succeeded");
    assert.equal(result.clicks, 2);
    assert.equal(result.navigations, 1);
    assert.equal(result.networkSamples, 1);
    assert.ok(result.browserUrls.includes(longUrl));
    const decisions = result.calls.filter(
      (c) => c.path.endsWith("/model") && c.body.purpose === "decision",
    );
    assert.equal(decisions.length, 5);
    const messages: import("../packages/model/src/index").Message[] =
      decisions.at(-1)!.body.messages;
    const payload = JSON.parse(messages[1].content);
    assert.equal(payload.untrustedPage.source, "tool-result");
    const full = JSON.parse(
      messages.find((m) => m.tool_call_id === payload.untrustedPage.toolCallId)!.content,
    ).observation;
    assert.equal(full.url, longUrl);
    assert.deepEqual(full.tabs, [{ index: 0, urlRef: "current" }]);
    assert.equal(full.network.length, 8);
    const restored = { ...full, ...payload.untrustedPage.overrides };
    assert.deepEqual(restored.network, result.networkSnapshots.at(-1));
    if (changingNetworkFacts) {
      assert.ok(payload.untrustedPage.overrides.network);
      assert.equal(payload.untrustedPage.overrides.url, undefined);
    }
    assert.equal(payload.userMessages[0].content, original);
    assert.equal(JSON.stringify(messages).split(longUrl).length - 1, 1);
    const timing = executionTimingSchema.parse(result.checkpoints.at(-1).payload.timing);
    assert.ok(timing.contextSizes!.every((x) => x.report.phase !== "error"));
    assert.equal(result.sessionCloses, 1);
    assert.equal(result.closed, true);
  });

test("navigate 仍把全部查询参数和片段原样交给实际 page.goto", async () => {
  const url = "https://example.com/next?token=" + "x%2Fy".repeat(520) + "#完整片段";
  const result = await scenario([tool("navigate", { url })]);
  assert.equal(result.finish.status, "succeeded");
  assert.deepEqual(result.navigatedUrls, ["https://example.com/", url]);
  assert.equal(result.clicks, 0);
});

// 固定决策和页面反馈，只比较生产 execute 编排成本。每个样本先核对结果，再纳入分位数。
test("跨任务执行基线", async (t) => {
  const samples = Number(process.env.TASKRELAY_BASELINE_SAMPLES ?? 1);
  assert.ok(Number.isSafeInteger(samples) && samples >= 1 && samples <= 100);
  const read = () => tool("extract", { instruction: "读取当前记录" });
  const submit = () => tool("act", { instruction: "提交当前记录" });
  type Case = {
    name: string;
    turns: ModelResponse[];
    options?: Parameters<typeof scenario>[1];
    writes: number;
    reads: number;
    navigations?: number;
    help?: boolean;
    empty?: boolean;
    unknown?: boolean;
  };
  const cases: Case[] = [
    { name: "只读", turns: [read()], options: { extraction: "0" }, writes: 0, reads: 1 },
    { name: "单次提交", turns: [submit(), read()], writes: 1, reads: 1 },
    {
      name: "跨页",
      turns: [tool("navigate", { url: "https://example.com/details" }), read()],
      writes: 0,
      reads: 1,
      navigations: 2,
    },
    { name: "多项目", turns: [submit(), submit(), read()], writes: 2, reads: 1 },
    {
      name: "协助后继续",
      turns: [tool("ask", { message: "请补充信息" }), read()],
      options: { helpWaits: 1 },
      help: true,
      writes: 0,
      reads: 1,
    },
    {
      name: "空读取",
      turns: [read()],
      options: { extraction: "  " },
      empty: true,
      writes: 0,
      reads: 1,
    },
    {
      name: "提交结果未知",
      turns: [submit(), submit()],
      options: { unknownActionResult: true },
      unknown: true,
      writes: 1,
      reads: 0,
    },
  ];
  for (const item of cases) {
    const durations: number[] = [];
    const decisions: number[] = [];
    const contextCalls: number[] = [];
    const sdkCalls: number[] = [];
    for (let i = 0; i < samples; i++) {
      const result = await scenario(structuredClone(item.turns), item.options);
      assert.equal(
        result.finish.result.outcome,
        item.unknown ? "unconfirmed" : "reported",
        item.name,
      );
      assert.equal(result.clicks, item.writes, item.name);
      assert.equal(result.navigations, item.navigations ?? 1, item.name);
      const checkpoint = result.checkpoints.at(-1);
      assert.equal(checkpoint.state, "finished");
      const report = executionTimingSchema.parse(checkpoint.payload.timing);
      assert.equal(report.phases.extract?.calls ?? 0, item.reads);
      assert.equal(report.emptyExtractions, Number(!!item.empty));
      assert.equal(report.phases.helpWait?.calls ?? 0, Number(!!item.help));
      assert.equal(
        report.phases.decision?.calls,
        result.calls.filter((c) => c.path.endsWith("/model") && c.body.purpose === "decision")
          .length,
      );
      assert.equal(
        report.phases.stagehandModel?.calls ?? 0,
        result.calls.filter((c) => c.path.endsWith("/stagehand")).length,
      );
      if (item.reads) {
        const feedback = result.calls.find(
          (c) =>
            c.path.endsWith("/messages") &&
            c.body.parts.some((p: { name?: string }) => p.name === "extract"),
        )!.body;
        assert.equal(
          feedback.content,
          item.empty ? "本次未读到页面内容。" : "已读取当前页面信息。",
        );
        if (item.empty) {
          const last = result.calls.filter((c) => c.path.endsWith("/model")).at(-1)!.body;
          assert.equal(
            JSON.parse(last.messages.find((m: { role: string }) => m.role === "tool").content)
              .readFeedback.empty,
            true,
          );
        }
      }
      durations.push(report.elapsedMs);
      contextCalls.push(report.phases.context!.calls);
      decisions.push(report.phases.decision!.calls);
      sdkCalls.push(report.phases.stagehandModel?.calls ?? 0);
    }
    durations.sort((a, b) => a - b);
    const percentile = (p: number) => durations[Math.ceil(samples * p) - 1];
    if (samples > 1)
      t.diagnostic(
        JSON.stringify({
          scenario: item.name,
          samples,
          p50Ms: percentile(0.5),
          p95Ms: percentile(0.95),
          decisionCalls: [Math.min(...decisions), Math.max(...decisions)],
          contextCalls: [Math.min(...contextCalls), Math.max(...contextCalls)],
          stagehandCalls: [Math.min(...sdkCalls), Math.max(...sdkCalls)],
        }),
      );
  }
});

test("正式 execute 保存账号工具只发布私有卡片请求，不把凭据写入恢复记录或普通消息", async () => {
  const s = await scenario(
    [
      tool("offerAccountSave", {
        name: "测试账号",
        username: "private-user",
        password: "private-password",
        loginOrigins: ["https://example.com"],
        evidence: "本次提交后看到账号主页",
      }),
    ],
    { browserState: true, unbound: true },
  );
  const card = s.calls.find((c) => c.path.endsWith("/account-card"))!.body;
  assert.equal(card.kind, "save");
  assert.equal(card.observedOrigin, "https://example.com");
  assert.equal(card.password, "private-password");
  assert.equal(s.clicks, 0);
  assert.equal(s.finish.stateCandidateKey, "candidate_1");
  assert.doesNotMatch(JSON.stringify(s.checkpoints), /private-password|private-user/);
  assert.doesNotMatch(
    JSON.stringify(s.calls.filter((c) => c.path.endsWith("/messages"))),
    /private-password|private-user/,
  );
});

test("正式 execute 上传跨域登录落点，不把它添加到密码投递来源", async () => {
  const s = await scenario(
    [
      tool("act", { instruction: "提交当前登录表单" }),
      tool("offerAccountSave", {
        name: "跨域测试账号",
        username: "private-user",
        password: "private-password",
        loginOrigins: ["https://example.com"],
        evidence: "登录后跳转到会员页面",
      }),
    ],
    { afterActionUrl: "https://member.example.net/home?session=private-url-token" },
  );
  const card = s.calls.find((call) => call.path.endsWith("/account-card"))!.body;
  assert.equal(card.origin, "https://example.com");
  assert.equal(card.observedOrigin, "https://member.example.net");
  assert.ok(card.observedOrigins.includes(card.observedOrigin));
  assert.deepEqual(card.loginOrigins, ["https://example.com"]);
  assert.doesNotMatch(
    JSON.stringify(s.checkpoints),
    /private-password|private-user|private-url-token/,
  );
  assert.equal(s.finish.status, "succeeded");
});

test("保存卡片失败在原聊天明确提示，诊断仅含固定分类和脱敏 origin，仍可结束任务", async () => {
  for (const error of [
    "ACCOUNT_ORIGIN_MISMATCH",
    "upstream failure private-password private-user",
  ]) {
    const s = await scenario(
      [
        tool("act", { instruction: "提交登录表单" }),
        tool("offerAccountSave", {
          name: "测试账号",
          username: "private-user",
          password: "private-password",
          loginOrigins: ["https://example.com"],
          evidence: "登录成功",
        }),
      ],
      {
        afterActionUrl: "https://private-user.example.net/home?token=private-password",
        accountCardError: error,
      },
    );
    const message = s.calls.find(
      (call) =>
        call.path.endsWith("/messages") &&
        call.body.parts?.some((part: { name: string }) => part.name === "offerAccountSave"),
    )!.body;
    assert.match(message.content, /账号保存卡片未能生成，本次保存尚未确认/);
    const diagnostic = JSON.parse(message.parts[0].result);
    assert.equal(diagnostic.code, error === "ACCOUNT_ORIGIN_MISMATCH" ? error : "OTHER");
    assert.equal(diagnostic.entryOrigin, "https://example.com");
    assert.match(diagnostic.observedOrigin, /已隐藏/);
    const timing = executionTimingSchema.parse(s.checkpoints.at(-1)!.payload.timing);
    assert.deepEqual(timing.accountSaveFailures, [diagnostic]);
    assert.doesNotMatch(
      JSON.stringify([message, timing]),
      /private-password|private-user|upstream failure|\/home|\?token/,
    );
    assert.equal(s.finish.status, "succeeded");
  }
});
test("正式执行图修改账号卡片 interrupt 同代恢复，重新取本次版本凭据后才继续操作", async () => {
  const s = await scenario(
    [
      tool("requestAccountUpdate", { evidence: "实际提交后网站提示密码错误" }),
      tool("act", { instruction: "使用更新后的凭据重新登录" }),
      tool("confirmAccountLogin", { evidence: "已使用更新后的密码登录成功" }),
    ],
    { browserState: true, fill: "updated-secret" },
  );
  assert.equal(s.calls.filter((c) => c.path.endsWith("/account-card")).length, 1);
  assert.equal(s.calls.filter((c) => c.path.endsWith("/account-card-status")).length, 2);
  assert.equal(s.calls.find((c) => c.path.endsWith("/account-status"))?.body.credentialVersion, 2);
  assert.equal(s.clicks, 1);
  assert.equal(s.finish.status, "succeeded");
  assert.doesNotMatch(JSON.stringify(s.checkpoints), /updated-secret/);
});
test("修改账号卡片等待中停止，不执行原批次剩余操作", async () => {
  const s = await scenario(
    [
      tool("requestAccountUpdate", { evidence: "网站拒绝密码" }),
      tool("act", { instruction: "不能执行" }),
    ],
    { browserState: true, cancelCard: true },
  );
  assert.equal(s.clicks, 0);
  assert.equal(s.finish.status, "cancelled");
  assert.equal(s.sessionCloses, 1);
});
test("同域不同账号的历史私密凭据不能填入当前账号环境，原文仍完整传递", async () => {
  const original = "上一个账号密码是 other-account-secret";
  const s = await scenario([tool("act", { instruction: "填写密码" })], {
    browserState: true,
    original,
    originalAccountId: "account_other",
    fill: "other-account-secret",
  });
  assert.equal(s.clicks, 0);
  assert.match(
    JSON.stringify(s.calls.filter((c) => c.path.endsWith("/model"))),
    /CREDENTIAL_ACCOUNT_MISMATCH/,
  );
  assert.ok(
    JSON.stringify(s.calls.find((c) => c.path.endsWith("/stagehand"))?.body).includes(original),
  );
});
test("收尾前新指令使旧候选失效，再次完成时重新捕获状态", async () => {
  const s = await scenario([], { browserState: true, finalRpcInstruction: true });
  const finishes = s.calls.filter((c) => c.path.endsWith("/finish"));
  assert.equal(finishes.length, 2);
  assert.equal(finishes[0].body.stateCandidateKey, "candidate_1");
  assert.equal(finishes[1].body.stateCandidateKey, "candidate_2");
});

test("八次读取保留八份反馈但只在首尾拍照，相同图片复用；相同提供方调用标识不吞真实调用", async () => {
  const repeated = tool("extract", { instruction: "读取当前结果" });
  const s = await scenario(Array.from({ length: 8 }, () => structuredClone(repeated)));
  let contextChecks = 0;
  for (const request of s.calls) {
    if (request.path.endsWith("/model")) contextChecks = 0;
    if (request.path.endsWith("/context")) contextChecks++;
    if (request.path.endsWith("/stagehand")) assert.equal(contextChecks, 1);
  }
  assert.equal(s.captures, 2);
  assert.equal(s.calls.filter((c) => c.path.endsWith("/snapshots")).length, 1);
  const messages = s.calls.filter(
    (c) => c.path.endsWith("/messages") && c.body.parts.some((p: any) => p.type === "tool"),
  );
  assert.equal(messages.length, 8);
  assert.equal(new Set(messages.map((c) => c.body.id)).size, 8);
  const history = s.calls
    .filter((c) => c.path.endsWith("/model"))
    .at(-1)!
    .body.messages.filter((m: any) => m.role === "tool");
  assert.deepEqual(JSON.parse(history.at(-1).content).readFeedback, {
    unchangedFromPreviousRead: true,
    consecutiveSameRead: 8,
  });
});

test("普通点击和填写不截图，明确请求截图仍可用", async () => {
  const s = await scenario([
    tool("act", { instruction: "填写账号" }),
    tool("act", { instruction: "点击下一步" }),
    tool("screenshot"),
  ]);
  assert.equal(s.captures, 3);
  assert.equal(s.clicks, 2);
  assert.equal(s.calls.filter((c) => c.path.endsWith("/snapshots")).length, 1);
  assert.equal(
    s.calls.some((c) => c.path.endsWith("/messages") && c.body.content.includes("沿用此前截图")),
    true,
  );
});

test("相同页面重复报错只拍一次，新页面报错再拍，不阻止模型重新操作", async () => {
  const s = await scenario(
    [
      tool("act", { instruction: "尝试按钮" }),
      tool("act", { instruction: "换个按钮" }),
      tool("navigate", { url: "https://example.com/other" }),
      tool("act", { instruction: "新页面按钮" }),
    ],
    { actionRejected: true },
  );
  assert.equal(s.clicks, 3);
  assert.equal(s.captures, 4);
});

test("模型附带的求助文字不提前回显，内部协助立即解决不拍照", async () => {
  const request = tool("ask", { message: "请提供账号" });
  request.text = "请提供账号";
  const s = await scenario([request]);
  assert.equal(s.captures, 2);
  assert.equal(
    s.calls.some((c) => c.path.endsWith("/messages") && c.body.content === "请提供账号"),
    false,
  );
});
async function scenario(
  turns: ModelResponse[],
  options: {
    firstModel?: (clicks: () => number) => Promise<ModelResponse>;
    actionError?: boolean;
    actionRejected?: boolean;
    emptyObserve?: boolean;
    extraction?: string;
    afterActionUrl?: string;
    networkFacts?: boolean;
    changingNetworkFacts?: boolean;
    actionFeedback?: string;
    summaryText?: string;
    navigationError?: boolean;
    cancelConnect?: boolean;
    createError?: boolean;
    closeError?: boolean;
    preferences?: import("../packages/contracts/src/preferences").TaskPreference[];
    original?: string;
    origin?: string;
    fill?: string;
    fills?: string[];
    account?: { account: Record<string, string>; origin: string };
    method?: string;
    helpMessage?: string;
    cancel?: boolean;
    cancelStagehand?: boolean;
    newInstruction?: boolean;
    correctionAfterDecision?: boolean;
    navigationObservationFailure?: boolean;
    unknownActionResult?: boolean;
    helpWaits?: number;
    cancelHelp?: boolean;
    executionOutline?: string[];
    finalShotInstruction?: boolean;
    finalMessageInstruction?: boolean;
    finalRpcInstruction?: boolean;
    browserState?: boolean;
    unbound?: boolean;
    cardWait?: boolean;
    cancelCard?: boolean;
    accountCardError?: string;
    originalAccountId?: string;
  } = {},
) {
  let attached = false,
    clicks = 0,
    cancelled = false,
    closed = false,
    sessionCloses = 0,
    navigations = 0,
    snapshotFailures = 0,
    changed = false,
    helpRequests = 0,
    finalReply = false,
    captures = 0;
  const networkSnapshots: Array<Array<{ host: string; code: string; at: string }>> = [];
  const metadata = {
    actionId: "sdk_action_test",
    cache: { status: "DISABLED" },
    usage: { inputTokens: 1, outputTokens: 1 },
  };
  let llm: ClientLLM,
    currentUrl = "https://example.com/",
    stagehandCalls = 0;
  const browserUrls: string[] = [],
    navigatedUrls: string[] = [];
  const calls: Array<{ path: string; body: any }> = [],
    checkpoints: any[] = [];
  let cardPolls = 0,
    stateCaptures = 0;
  const original = options.original ?? "请处理当前页面";
  const chat: any[] = [
    {
      seq: 1,
      role: "user",
      source: "user",
      content: original,
      private: !!options.original,
      origin: options.origin ?? "https://example.com",
      accountId: options.originalAccountId,
    },
  ];
  const changeInstructions = () => {
    if (!changed) {
      changed = true;
      chat.push({ seq: 2, role: "user", source: "user", content: "请先核对新补充要求，再结束。" });
    }
  };
  const screenshot = await sharp({
    create: { width: 1, height: 1, channels: 4, background: "#fff" },
  })
    .png()
    .toBuffer();
  const page = {
    title: async () => "测试页面",
    url: async () => {
      browserUrls.push(currentUrl);
      return currentUrl;
    },
    goto: async (url: string) => {
      navigations++;
      navigatedUrls.push(url);
      if (options.navigationError) throw Error("NAVIGATION_FAILED");
      currentUrl = url;
    },
    screenshot: async () => {
      captures++;
      if (options.finalShotInstruction && finalReply) changeInstructions();
      return screenshot;
    },
    snapshot: async () => {
      if (snapshotFailures > 0) {
        snapshotFailures--;
        throw Error("Execution context destroyed during navigation");
      }
      return { formattedTree: "[1] button 继续登录\n[2] textbox 密码", xpathMap: {}, urlMap: {} };
    },
    evaluate: async () => ({ readyState: "complete", width: 1, height: 1, text: [] }),
    locator: () => {
      throw Error("RAW_SELECTOR_PATH_MUST_NOT_BE_USED");
    },
  };
  let networkSamples = 0;
  const port: RuntimePort = {
    ...(options.networkFacts
      ? {
          networkEvent: () => {
            networkSamples++;
          },
        }
      : {}),
    cancelled: () => cancelled,
    checkpoint: async (state, payload) => {
      checkpoints.push({ state, payload });
    },
    rpc: async <T>(path: string, body?: any) => {
      calls.push({ path, body });
      if (path === "local:browser")
        return {
          cdpUrl: "test",
          ...(options.browserState
            ? {
                state: {
                  accountId: options.unbound ? null : "account_test",
                  credentialVersion: 1,
                  stateEpoch: 1,
                  revision: 0,
                  origins: ["https://example.com"],
                  state: null,
                },
              }
            : {}),
        } as T;
      if (path === "local:state-capture") return { key: "candidate_" + ++stateCaptures } as T;
      if (path.endsWith("/account-card")) {
        if (options.accountCardError) throw Error(options.accountCardError);
        return { cardId: "card_test" } as T;
      }
      if (path.endsWith("/account-card-status")) {
        cardPolls++;
        if (options.cancelCard) cancelled = true;
        return {
          status: cardPolls === 1 ? "pending" : "saved",
          resumed: cardPolls > 1,
          accountId: "account_test",
          credentialVersion: 2,
          stateEpoch: 2,
        } as T;
      }
      if (path.endsWith("/context"))
        return {
          messages: chat.filter((m) => m.seq > body.after),
          ...(body.after === 0 ? { preferenceSnapshot: options.preferences ?? [] } : {}),
        } as T;
      if (path.endsWith("/model")) {
        if (body.purpose === "summary")
          return {
            response: answer(options.summaryText ?? "已读取页面并尝试操作，保留最近工具反馈继续。"),
          } as T;
        if (options.cancel) cancelled = true;
        const firstModel = options.firstModel;
        options.firstModel = undefined;
        const response = firstModel
          ? await firstModel(() => clicks)
          : (turns.shift() ?? answer("已处理当前页面，结果如上。"));
        if (options.correctionAfterDecision && response.calls.length) changeInstructions();
        finalReply = !response.calls.length;
        return { response } as T;
      }
      if (
        path.endsWith("/messages") &&
        ["当前页面。", "当前页面未变化，沿用此前截图。"].includes(body.content) &&
        options.finalMessageInstruction
      )
        changeInstructions();
      if (path.endsWith("/finish") && options.finalRpcInstruction && !changed) {
        changeInstructions();
        throw Error("INSTRUCTIONS_CHANGED");
      }
      if (path.endsWith("/stagehand")) {
        if (options.cancelStagehand) cancelled = true;
        if (options.newInstruction && !changed) {
          changed = true;
          chat.push({ seq: 2, role: "user", source: "user", content: "先不要提交，改为只读查看" });
        }
        const fill = options.fills?.[stagehandCalls++] ?? options.fill;
        const value = {
          action: {
            method: options.method ?? (fill ? "fill" : "click"),
            arguments: fill ? [fill] : [],
          },
        };
        return { text: JSON.stringify(value), structured: value } as T;
      }
      if (path.endsWith("/tool")) return { execute: true } as T;
      if (path.endsWith("/snapshots")) return { id: "snapshot_test" } as T;
      if (path.endsWith("/help")) {
        helpRequests++;
        if (options.cancelHelp) cancelled = true;
        return {
          ready: helpRequests > (options.helpWaits ?? 0),
          questionRound: 0,
          message: options.helpMessage ?? "请结合用户原文继续",
          accountId: options.account ? "account_test" : undefined,
        } as T;
      }
      if (path.endsWith("/credentials"))
        return (
          options.browserState
            ? {
                account: options.account?.account ?? {
                  username: "fixture-user",
                  password: cardPolls > 1 ? "updated-secret" : "fixture-secret",
                },
                origin: "https://example.com",
                accountId: "account_test",
                credentialVersion: cardPolls > 1 ? 2 : 1,
                stateEpoch: cardPolls > 1 ? 2 : 1,
              }
            : options.account
        ) as T;
      return {} as T;
    },
  };
  const infer = async (instruction: string) =>
    llm.generate({
      messages: [{ role: "user", content: { type: "text", text: instruction } }],
      systemPrompt: "Stagehand actual callback",
      responseFormat: {
        type: "json_schema",
        name: "action",
        schema: { type: "object", properties: { action: { type: "object" } } },
      },
    });
  const session = {
    close: async () => {
      sessionCloses++;
      if (options.closeError) throw Error("CLOSE_FAILED");
    },
    act: async (instruction: string) => {
      await infer(instruction);
      clicks++;
      if (options.afterActionUrl) currentUrl = options.afterActionUrl;
      if (options.navigationObservationFailure) snapshotFailures = 1;
      if (options.unknownActionResult) snapshotFailures = Infinity;
      if (options.actionError && clicks === 1) throw Error("TARGET_NOT_FOUND");
      return {
        data: {
          success: !options.actionRejected,
          message: options.actionRejected
            ? "TARGET_NOT_FOUND"
            : (options.actionFeedback ?? "已执行"),
          actions: [],
        },
        metadata,
      };
    },
    observe: async (instruction: string) => {
      await infer(instruction);
      return { data: options.emptyObserve ? [] : [{ description: "继续登录" }], metadata };
    },
    extract: async (instruction: string) => {
      await infer(instruction);
      return {
        data:
          options.extraction === undefined
            ? { text: "实际页面信息" }
            : { extraction: options.extraction },
        metadata,
      };
    },
  };
  await execute(
    {
      ...run,
      task: {
        ...run.task,
        entryUrl: "https://example.com/",
        executionOutline: options.executionOutline,
      },
    },
    port,
    {
      loadSdk: async () =>
        ({
          Stagehand: {
            create: async (opts: any) => {
              if (options.createError) throw Error("CREATE_FAILED");
              attached = true;
              llm = opts.model;
              if (options.cancelConnect) cancelled = true;
              return session;
            },
          },
          localBrowser: {
            connect: async () => ({
              get context() {
                if (!attached) throw Error("Browser context is unavailable");
                return { setDomainPolicy: async () => {}, pages: async () => [page] };
              },
            }),
          },
        }) as any,
      startProxy: async (logging) => {
        if (logging) {
          assert.equal(logging.entryHost, "example.com");
          logging.event({
            at: new Date().toISOString(),
            phase: "dns",
            query: "A",
            connection: 1,
            result: "ok",
            elapsedMs: 1,
          });
        }
        return {
          port: 1,
          ...(options.networkFacts
            ? {
                diagnostics: () => {
                  const facts = Array.from({ length: 8 }, () => ({
                    host: "example.com",
                    code: "ERR_CONNECTION_RESET",
                    at: new Date(
                      Date.UTC(2026, 10, 8) +
                        (options.changingNetworkFacts ? networkSnapshots.length * 1000 : 0),
                    ).toISOString(),
                  }));
                  networkSnapshots.push(facts);
                  return facts;
                },
              }
            : {}),
          close: async () => {
            closed = true;
          },
        };
      },
      delay: async () => {},
    },
  );
  return {
    networkSamples,
    networkSnapshots,
    calls,
    checkpoints,
    clicks,
    closed,
    sessionCloses,
    navigations,
    captures,
    browserUrls,
    navigatedUrls,
    finish: calls.filter((c) => c.path.endsWith("/finish")).at(-1)?.body,
  };
}

test("只读工具执行前收到更正时跳过过期调用", async () => {
  for (const name of ["observe", "extract"]) {
    const result = await scenario([tool(name, { instruction: "读取旧目标" })], {
      correctionAfterDecision: true,
    });
    assert.ok(!result.calls.some((c) => c.path.endsWith("/stagehand")));
    const last = result.calls.filter((c) => c.path.endsWith("/model")).at(-1)!.body;
    assert.match(JSON.stringify(last.messages), /INSTRUCTIONS_CHANGED/);
    assert.match(JSON.stringify(last.messages), /请先核对新补充要求/);
  }
});

test("初始化期间停止不再导航，关闭 Stagehand 失败仍释放代理", async () => {
  const s = await scenario([], { cancelConnect: true, closeError: true });
  assert.equal(s.navigations, 0);
  assert.equal(s.finish.status, "cancelled");
  assert.equal(s.sessionCloses, 1);
  assert.equal(s.closed, true);
});

test("Stagehand 初始化失败保留失败事实并释放代理，由 Host 收回浏览器", async () => {
  const s = await scenario([], { createError: true });
  assert.equal(s.navigations, 0);
  assert.equal(s.finish.status, "failed");
  assert.match(s.finish.result.summary, /CREATE_FAILED/);
  assert.equal(s.sessionCloses, 0);
  assert.equal(s.closed, true);
});

test("空观察候选如实反馈并保留 Stagehand 元数据，不登记动作", async () => {
  const s = await scenario(
    [
      tool("observe", { instruction: "查看登录入口" }),
      tool("extract", { instruction: "读取状态" }),
    ],
    { emptyObserve: true },
  );
  const messages = s.calls.filter((c) => c.path.endsWith("/messages"));
  assert.ok(messages.some((c) => c.body.content.includes("未找到符合指令的可操作内容")));
  assert.equal(s.clicks, 0);
  assert.equal(
    s.calls.some((c) => c.path.endsWith("/tool")),
    false,
  );
  const history = s.calls
    .filter((c) => c.path.endsWith("/model"))
    .at(-1)!
    .body.messages.filter((m: { role: string }) => m.role === "tool")
    .map((m: { content: string }) => ({ result: JSON.parse(m.content) }));
  assert.deepEqual(history[0].result.data, []);
  for (const item of history) assert.equal(item.result.metadata.actionId, "sdk_action_test");
});

test("导航异常不展示已打开，错误交回模型继续处理", async () => {
  const s = await scenario([tool("navigate", { url: "https://example.com/next" })], {
    navigationError: true,
  });
  const messages = s.calls.filter((c) => c.path.endsWith("/messages"));
  assert.equal(
    messages.some((c) => /已打开/.test(c.body.content)),
    false,
  );
  assert.match(
    JSON.stringify(s.calls.filter((c) => c.path.endsWith("/model"))),
    /NAVIGATION_FAILED/,
  );
});

test("act 返回失败而未抛异常时保留错误和元数据，不自动重放", async () => {
  const s = await scenario([tool("act", { instruction: "点击登录" })], { actionRejected: true });
  const history = s.calls
    .filter((c) => c.path.endsWith("/model"))
    .at(-1)!
    .body.messages.filter((m: { role: string }) => m.role === "tool")
    .map((m: { content: string }) => ({ result: JSON.parse(m.content) }));
  assert.equal(s.clicks, 1);
  assert.equal(history[0].result.error, "TARGET_NOT_FOUND");
  assert.equal(history[0].result.metadata.actionId, "sdk_action_test");
  assert.equal(s.sessionCloses, 1);
});
test("真实 execute 使用原生工具调用和普通文字结束，不再解析业务动作计划", async () => {
  const s = await scenario([
    tool("observe", { instruction: "查看登录入口" }),
    tool("act", { instruction: "点击继续登录" }),
    tool("extract", { instruction: "读取登录状态" }),
  ]);
  assert.equal(s.clicks, 1);
  assert.equal(s.finish.status, "succeeded");
  assert.equal(s.finish.result.outcome, "reported");
  assert.equal(s.closed, true);
  assert.equal(s.calls.filter((c) => c.path.endsWith("/stagehand")).length, 3);
  const sent = s.calls.findIndex(
    (c) => c.path.endsWith("/stagehand") && JSON.stringify(c.body).includes("点击继续登录"),
  );
  const intent = s.calls.findIndex((c) => c.path.endsWith("/tool") && c.body.phase === "start");
  assert.ok(intent > sent);
});
test("Stagehand 工具错误回到同一执行上下文，不强制结束或偷偷重放", async () => {
  const s = await scenario(
    [tool("act", { instruction: "点击登录" }), tool("act", { instruction: "重新观察后点击继续" })],
    { actionError: true },
  );
  assert.equal(s.clicks, 2);
  assert.match(
    JSON.stringify(s.calls.filter((c) => c.path.endsWith("/model"))),
    /TARGET_NOT_FOUND/,
  );
});
test("完整原始回复同时到达执行器模型和 Stagehand，摘要不能丢掉密码与补充要求", async () => {
  const original = "密码是 0012Ab!，但是请先确认页面，再填写。";
  const s = await scenario(
    [
      tool("ask", { message: "请确认登录信息" }),
      ...Array.from({ length: 20 }, () => tool("act", { instruction: "根据用户回复填写密码" })),
    ],
    { original, fill: "0012Ab!" },
  );
  assert.equal(s.clicks, 20);
  assert.ok(s.calls.some((c) => c.path.endsWith("/model") && c.body.purpose === "summary"));
  for (const call of s.calls.filter(
    (c) =>
      (c.path.endsWith("/model") && c.body.purpose !== "summary") || c.path.endsWith("/stagehand"),
  ))
    assert.ok(JSON.stringify(call.body).includes(original));
  assert.doesNotMatch(JSON.stringify(s.checkpoints), /0012Ab!/);
  assert.doesNotMatch(
    JSON.stringify(s.calls.filter((c) => c.path.endsWith("/messages"))),
    /0012Ab!/,
  );
});
test("用户改变登录方式的原文交给 Stagehand，无字段提取和强制填写", async () => {
  const original = "不要填密码了，改用邮箱验证码。";
  const s = await scenario([tool("act", { instruction: "按用户新要求更换登录方式" })], {
    original,
  });
  assert.equal(s.clicks, 1);
  assert.ok(
    JSON.stringify(s.calls.find((c) => c.path.endsWith("/stagehand"))?.body).includes(original),
  );
});
test("模型在完整上下文中生成的实际填写值仍校验所属站点", async () => {
  const s = await scenario([tool("act", { instruction: "根据原文填写" })], {
    original: "密码是 0012Ab!",
    origin: "https://login.example.com",
    fill: "0012Ab!",
  });
  assert.equal(s.clicks, 0);
  assert.equal(
    s.calls.some((c) => c.path.endsWith("/tool") && c.body.phase === "start"),
    false,
  );
  assert.match(
    JSON.stringify(s.calls.filter((c) => c.path.endsWith("/model"))),
    /CREDENTIAL_ORIGIN_MISMATCH/,
  );
});

for (const fill of ["prefix:0012Ab!", "0012Ab!:suffix", "prefix:0012Ab!:suffix"])
  test("完整已知凭据加前后缀仍拒绝跨站填写：" + fill, async () => {
    const s = await scenario([tool("act", { instruction: "根据原文填写" })], {
      original: "0012Ab!",
      origin: "https://login.example.com",
      fill,
    });
    assert.equal(s.clicks, 0);
    assert.equal(
      s.calls.some((c) => c.path.endsWith("/tool") && c.body.phase === "start"),
      false,
    );
    assert.match(
      JSON.stringify(s.calls.filter((c) => c.path.endsWith("/model"))),
      /CREDENTIAL_ORIGIN_MISMATCH/,
    );
  });

test("同站拼接凭据可使用且脱敏，从完整原文填写过的值保留站点来源", async () => {
  const same = await scenario([tool("act", { instruction: "按原文填写" })], {
    original: "0012Ab!",
    fill: "prefix:0012Ab!:suffix",
  });
  assert.equal(same.clicks, 1);
  assert.doesNotMatch(
    JSON.stringify(same.calls.filter((c) => c.path.endsWith("/messages"))),
    /0012Ab!/,
  );
  const s = await scenario(
    [
      tool("act", { instruction: "填写用户密码" }),
      tool("navigate", { url: "https://other.example.com" }),
      tool("act", { instruction: "按页面格式填写" }),
    ],
    {
      original: "密码是 0012Ab!，请先确认页面。",
      fills: ["0012Ab!", "prefix:0012Ab!:suffix"],
    },
  );
  assert.equal(s.clicks, 1);
  assert.match(
    JSON.stringify(s.calls.filter((c) => c.path.endsWith("/model"))),
    /CREDENTIAL_ORIGIN_MISMATCH/,
  );
  assert.equal(
    s.calls.filter((c) => c.path.endsWith("/tool") && c.body.phase === "start").length,
    2,
  );
});

test("拼接多个站点凭据时本网站来源不能为其他站点凭据放行", async () => {
  const s = await scenario(
    [
      tool("navigate", { url: "https://other.example.com" }),
      tool("ask", { message: "读取此站点账号" }),
      tool("navigate", { url: "https://example.com" }),
      tool("act", { instruction: "填写拼接内容" }),
    ],
    {
      original: "current-site-secret",
      fill: "current-site-secret:other-site-secret",
      account: { origin: "https://other.example.com", account: { password: "other-site-secret" } },
    },
  );
  assert.equal(s.clicks, 0);
  assert.match(
    JSON.stringify(s.calls.filter((c) => c.path.endsWith("/model"))),
    /CREDENTIAL_ORIGIN_MISMATCH/,
  );
});
test("原生下拉选项不因数字与其他站点密码重合而被当成凭据填写", async () => {
  const s = await scenario([tool("act", { instruction: "将数量选择为 1" })], {
    original: "登录密码 001234",
    origin: "https://login.example.com",
    fill: "1",
    method: "selectOptionFromDropdown",
  });
  assert.equal(s.clicks, 1);
  assert.equal(
    s.calls.filter((c) => c.path.endsWith("/tool") && c.body.phase === "start").length,
    1,
  );
});
test("超过四十步可如实给出受阻答复，不做独立成功审核", async () => {
  const s = await scenario([
    ...Array.from({ length: 41 }, () => tool("act", { instruction: "查看下一页" })),
    answer("已完成部分，其余网站暂不可用。"),
  ]);
  assert.equal(s.clicks, 41);
  assert.equal(s.finish.result.summary, "已完成部分，其余网站暂不可用。");
  assert.equal(s.finish.result.outcome, "reported");
  const sent = s.calls.filter((c) => c.path.endsWith("/model")).at(-1)!.body.messages;
  assert.ok(sent.filter((m: { role: string }) => m.role === "tool").length < 41);
  assert.ok(s.calls.some((c) => c.path.endsWith("/model") && c.body.purpose === "summary"));
  assert.doesNotMatch(
    JSON.stringify(s.calls.filter((c) => c.path.endsWith("/model"))),
    /formattedTree|textbox 密码/,
  );
  assert.equal(JSON.parse(sent[1].content).history, undefined);
});
test("模型等待期间停止，不执行返回的工具调用", async () => {
  const s = await scenario([tool("act", { instruction: "点击提交" })], { cancel: true });
  assert.equal(s.clicks, 0);
  assert.equal(s.finish.status, "cancelled");
});
test("Stagehand 定位推理期间停止不把未点击动作标成 unknown", async () => {
  const s = await scenario([tool("act", { instruction: "点击提交" })], { cancelStagehand: true });
  assert.equal(s.clicks, 0);
  assert.equal(s.finish.status, "cancelled");
  assert.equal(
    s.calls.some((c) => c.path.endsWith("/tool") && c.body.phase === "start"),
    false,
  );
});
test("Stagehand 推理期间收到用户新要求，旧动作作废", async () => {
  const s = await scenario(
    [tool("act", { instruction: "点击提交" }), answer("已按新要求停止提交。")],
    { newInstruction: true },
  );
  assert.equal(s.clicks, 0);
  assert.equal(
    s.calls.some((c) => c.path.endsWith("/tool") && c.body.phase === "start"),
    false,
  );
});
test("导航过渡观察失败只重新观察，不重复提交", async () => {
  const s = await scenario([tool("act", { instruction: "点击提交" })], {
    navigationObservationFailure: true,
  });
  assert.equal(s.clicks, 1);
  assert.equal(
    s.calls.filter((c) => c.path.endsWith("/tool") && c.body.phase === "start").length,
    1,
  );
  assert.equal(
    s.calls.filter((c) => c.path.endsWith("/tool") && c.body.phase === "result").length,
    1,
  );
});

test("真实 execute 协助中断以相同请求恢复，不重复登记或重放之前动作", async () => {
  const s = await scenario(
    [
      tool("act", { instruction: "检查页面" }),
      tool("ask", { message: "请提供验证码" }),
      tool("act", { instruction: "按回复继续" }),
    ],
    { helpWaits: 2 },
  );
  const requests = s.calls.filter((c) => c.path.endsWith("/help"));
  assert.equal(requests.length, 3);
  assert.equal(new Set(requests.map((c) => c.body.id)).size, 1);
  assert.equal(s.clicks, 2);
  assert.equal(
    s.calls.filter((c) => c.path.endsWith("/messages") && c.body.content === "请提供验证码").length,
    0,
  );
  assert.equal(s.captures, 3); // 首次、同一协助轮次一次、最终；轮询不重复拍。
  assert.equal(s.calls.filter((c) => c.path.endsWith("/snapshots")).length, 1); // 相同脱敏图片仅上传一次。
  assert.equal(
    s.calls.filter((c) => c.path.includes("/help/") && c.path.endsWith("/ack")).length,
    1,
  );
  assert.equal(s.finish.status, "succeeded");
});

test("等待协助时停止清理同代图，不执行后续动作", async () => {
  const s = await scenario(
    [tool("ask", { message: "请提供验证码" }), tool("act", { instruction: "提交" })],
    { helpWaits: 1, cancelHelp: true },
  );
  assert.equal(s.clicks, 0);
  assert.equal(s.finish.status, "cancelled");
  assert.equal(s.sessionCloses, 1);
  assert.equal(s.closed, true);
});

test("观察始终不可用时新图保留 unknown，禁止重复提交", async () => {
  const s = await scenario(
    [
      tool("act", { instruction: "提交" }),
      tool("act", { instruction: "再次提交" }),
      answer("当前提交结果无法确认。"),
    ],
    { unknownActionResult: true },
  );
  assert.equal(s.clicks, 1);
  assert.equal(s.finish.status, "unknown");
  assert.equal(s.finish.result.outcome, "unconfirmed");
  assert.equal(
    s.calls.filter((c) => c.path.endsWith("/tool") && c.body.phase === "start").length,
    1,
  );
  assert.match(
    JSON.stringify(s.calls.filter((c) => c.path.endsWith("/model"))),
    /ACTION_RESULT_PENDING/,
  );
});

test("可调整粗步骤传给两层模型，摘要后仍由任务快照提供", async () => {
  const executionOutline = ["按现场需要登录", "查询库存", "整理查询结果"];
  const s = await scenario(
    [
      ...Array.from({ length: 20 }, () => tool("observe", { instruction: "查看页面" })),
      tool("act", { instruction: "查询库存" }),
    ],
    { executionOutline },
  );
  assert.ok(s.calls.some((c) => c.path.endsWith("/model") && c.body.purpose === "summary"));
  for (const request of s.calls.filter(
    (c) =>
      (c.path.endsWith("/model") && c.body.purpose !== "summary") || c.path.endsWith("/stagehand"),
  )) {
    for (const step of executionOutline) assert.ok(JSON.stringify(request.body).includes(step));
  }
  assert.equal(s.finish.status, "succeeded");
});

for (const arrival of [
  "finalShotInstruction",
  "finalMessageInstruction",
  "finalRpcInstruction",
] as const) {
  test(`真实 execute 收尾期间收到新要求时重读上下文，不提交旧结果：${arrival}`, async () => {
    const s = await scenario([answer("旧目标已完成"), answer("已核对新补充要求。")], {
      [arrival]: true,
    });
    const requests = s.calls.filter((c) => c.path.endsWith("/model"));
    assert.equal(requests.length, 2);
    assert.match(JSON.stringify(requests[1].body), /请先核对新补充要求/);
    assert.equal(s.finish.status, "succeeded");
    assert.equal(s.finish.result.summary, "已核对新补充要求。");
    assert.equal(s.finish.expectedUserSeq, 2);
    const finishes = s.calls.filter((c) => c.path.endsWith("/finish"));
    assert.equal(finishes.length, arrival === "finalRpcInstruction" ? 2 : 1);
    assert.equal(s.checkpoints.filter((c) => c.state === "finished").length, 1);
    assert.equal(
      s.calls.some((c) => c.path.endsWith("/tool") && c.body.phase === "start"),
      false,
    );
  });
}

test("正式 execute 单独传递固定偏好，保留用户纠正且不把偏好注入页面工具或日志", async () => {
  const preference = "我的独有偏好：优先使用中文";
  const result = await scenario(
    [tool("act", { instruction: "打开当前页面的公告" }), answer("完成")],
    { preferences: [{ id: "style", text: preference, version: 1 }], original: "这次使用英文" },
  );
  const decisions = result.calls.filter(
    (c) => c.path.endsWith("/model") && c.body.purpose === "decision",
  );
  assert.ok(decisions.length > 0);
  assert.ok(JSON.stringify(decisions).includes(preference));
  assert.ok(JSON.stringify(decisions).includes("这次使用英文"));
  assert.ok(!JSON.stringify(result.checkpoints).includes(preference));
  assert.ok(
    !JSON.stringify(result.calls.filter((c) => c.path.endsWith("/stagehand"))).includes(preference),
  );
});

test("正式 execute 明确需求后发布卡片，继续首次执行并回传操作记录", async () => {
  const result = await scenario([
    tool("confirmRequirements", { summary: "读取当前订单", changed: false }),
    tool("act", { instruction: "点击查询" }),
    answer("已读取"),
  ]);
  const confirmation = result.calls.find((c) => c.path.endsWith("/requirements"));
  assert.equal(confirmation?.body.summary, "读取当前订单");
  assert.equal(typeof confirmation?.body.userSeq, "number");
  assert.equal(result.clicks, 1);
  assert.equal(result.finish.result.executionRecordCount, 2);
  assert.equal(result.calls.filter((c) => c.path.endsWith("/execution-record")).length, 2);
});
