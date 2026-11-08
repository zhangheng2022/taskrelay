import test from "node:test";
import assert from "node:assert/strict";
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { compactPageUrls, referencePageContext } from "../apps/desktop/src/executor/page-context";

const currentUrl = "https://example.com/login?state=" + "a%2Fb%3D".repeat(350) + "#原片段";
const snapshot = () =>
  compactPageUrls({
    url: currentUrl,
    title: "页面",
    tabs: [{ index: 0, url: currentUrl }],
    loading: { readyState: "complete", busy: false },
    network: [{ code: "TLS_ERROR" }],
  });

test("标签页网址可无损还原，保留完整参数、片段、全部标签页索引及不同网址", () => {
  const other = currentUrl + "different";
  const source = {
    url: currentUrl,
    title: "页面",
    loading: { busy: false },
    tabs: [
      { index: 0, url: currentUrl },
      { index: 1, url: other },
      { index: 2, url: currentUrl },
      { index: 3, url: other },
      { index: 4, url: currentUrl + "#different" },
    ],
  };
  const before = structuredClone(source),
    compact = compactPageUrls(source);
  const expanded = compact.tabs.map((tab) => {
    if ("url" in tab) return tab;
    if (tab.urlRef === "current") return { index: tab.index, url: compact.url };
    const target = compact.tabs.find((t) => t.index === Number(tab.urlRef.slice(4)));
    assert.ok(target && "url" in target);
    return { index: tab.index, url: target.url };
  });
  assert.deepEqual(expanded, source.tabs);
  assert.deepEqual(source, before);
  assert.equal(compact.url, currentUrl);
  assert.ok(
    Buffer.byteLength(JSON.stringify(source)) - Buffer.byteLength(JSON.stringify(compact)) >
      3 * Buffer.byteLength(currentUrl) - 200,
  );
});

for (const name of ["act", "navigate", "wait", "switchPage"] as const)
  test(`同次 ${name} 完整现场只发送一份，原文、账号和原工具结果不变`, () => {
    const page = snapshot(),
      id = `call-${name}`;
    const payload = {
      userMessages: [{ content: currentUrl }],
      accounts: [{ password: currentUrl }],
      untrustedPage: page,
    };
    const protectedMessages = [new HumanMessage(JSON.stringify(payload))];
    const result =
      name === "act" || name === "navigate"
        ? { feedback: { success: false }, error: "TARGET_NOT_FOUND", observation: page }
        : page;
    const history = [
      new AIMessage({ content: "", tool_calls: [{ id, name, args: {} }] }),
      new ToolMessage({ tool_call_id: id, content: JSON.stringify(result) }),
    ];
    const before = history.map((m) => m.content);
    const view = JSON.parse(referencePageContext(protectedMessages, history)[0].content as string);
    assert.equal(view.untrustedPage.source, "tool-result");
    const target = JSON.parse(
      history.find(
        (m) => m instanceof ToolMessage && m.tool_call_id === view.untrustedPage.toolCallId,
      )!.content as string,
    );
    assert.deepEqual(view.untrustedPage.field === "$" ? target : target.observation, page);
    assert.deepEqual(view.userMessages, payload.userMessages);
    assert.deepEqual(view.accounts, payload.accounts);
    assert.deepEqual(
      history.map((m) => m.content),
      before,
    );
    assert.equal(protectedMessages[0].content, JSON.stringify(payload));
    // 引用目标离开实际待发送消息时，立即恢复完整现场，不复用上一次投影。
    assert.equal(
      referencePageContext(protectedMessages, [new HumanMessage("历史已摘要")])[0].content,
      protectedMessages[0].content,
    );
  });

test("同网址的状态、网络与标题变化完整覆盖，未变化字段引用原结果", () => {
  const base = snapshot();
  for (const changed of [
    { loading: { readyState: "loading", busy: true } },
    { network: [] },
    { title: "新页面" },
    { title: "", loading: null, network: null },
  ]) {
    const page = { ...base, ...changed };
    const payload = {
      userMessages: ["用户原文"],
      accounts: [{ value: "原凭据" }],
      untrustedPage: page,
    };
    const protectedMessages = [
      new HumanMessage({ content: JSON.stringify(payload), id: "current" }),
    ];
    const history = [
      new AIMessage({ content: "", tool_calls: [{ id: "call", name: "act", args: {} }] }),
      new ToolMessage({
        tool_call_id: "call",
        content: JSON.stringify({ observation: base, error: "SENT_RESULT_UNKNOWN" }),
      }),
    ];
    const originalHistory = history.map((m) => m.content);
    const projected = referencePageContext(protectedMessages, history);
    const view = JSON.parse(projected[0].content as string);
    assert.equal(view.untrustedPage.source, "tool-result");
    assert.deepEqual(view.untrustedPage.overrides, changed);
    assert.deepEqual({ ...base, ...view.untrustedPage.overrides }, page);
    assert.deepEqual(view.userMessages, payload.userMessages);
    assert.deepEqual(view.accounts, payload.accounts);
    assert.equal(projected[0].id, "current");
    assert.deepEqual(
      history.map((m) => m.content),
      originalHistory,
    );
    assert.equal(protectedMessages[0].content, JSON.stringify(payload));
    assert.ok(
      Buffer.byteLength(JSON.stringify(projected[0].content)) <
        Buffer.byteLength(JSON.stringify(protectedMessages[0].content)) - 2000,
    );
    assert.equal(referencePageContext(protectedMessages, []), protectedMessages);
  }
});

test("网址或字段集合变化、观察失败及非页面工具保留完整当前现场", () => {
  const page = snapshot(),
    protectedMessages = [new HumanMessage(JSON.stringify({ untrustedPage: page }))];
  const call = new AIMessage({ content: "", tool_calls: [{ id: "call", name: "act", args: {} }] });
  for (const observation of [
    { ...page, url: currentUrl + "&changed=1" },
    { ...page, extra: "旧字段" },
    { url: page.url, title: page.title, tabs: page.tabs, loading: page.loading },
    { error: "OBSERVATION_FAILED", actionResultPending: true },
  ]) {
    const history: BaseMessage[] = [
      call,
      new ToolMessage({ tool_call_id: "call", content: JSON.stringify({ observation }) }),
    ];
    assert.equal(referencePageContext(protectedMessages, history), protectedMessages);
  }
  const extract = new AIMessage({
    content: "",
    tool_calls: [{ id: "call", name: "extract", args: {} }],
  });
  assert.equal(
    referencePageContext(protectedMessages, [
      extract,
      new ToolMessage({ tool_call_id: "call", content: JSON.stringify({ observation: page }) }),
    ]),
    protectedMessages,
  );
});

test("选择实际待发送历史中最省空间的来源，移除后重新选择且不会产生引用链", () => {
  const page = snapshot();
  const protectedMessages = [new HumanMessage(JSON.stringify({ untrustedPage: page }))];
  const pair = (id: string, observation: unknown) => [
    new AIMessage({ content: "", tool_calls: [{ id, name: "act", args: {} }] }),
    new ToolMessage({ tool_call_id: id, content: JSON.stringify({ observation }) }),
  ];
  const recent = pair("recent", { ...page, network: [] });
  const history = [...pair("old", page), ...recent];
  const full = JSON.parse(referencePageContext(protectedMessages, history)[0].content as string);
  assert.equal(full.untrustedPage.toolCallId, "old");
  assert.equal(full.untrustedPage.overrides, undefined);
  const partial = JSON.parse(referencePageContext(protectedMessages, recent)[0].content as string);
  assert.equal(partial.untrustedPage.toolCallId, "recent");
  assert.deepEqual(partial.untrustedPage.overrides, { network: page.network });
  assert.equal(referencePageContext(protectedMessages, []), protectedMessages);
});

test("引用比完整页面更大时保留原消息，避免小页面因引用反而膨胀", () => {
  const page = { url: "https://a.co", title: "", tabs: [], loading: null };
  const protectedMessages = [new HumanMessage(JSON.stringify({ untrustedPage: page }))];
  const history = [
    new AIMessage({
      content: "",
      tool_calls: [{ id: "long".repeat(100), name: "wait", args: {} }],
    }),
    new ToolMessage({ tool_call_id: "long".repeat(100), content: JSON.stringify(page) }),
  ];
  assert.equal(referencePageContext(protectedMessages, history), protectedMessages);
});

test("重复工具调用或结果 ID 不产生指向不明确的页面引用", () => {
  const page = snapshot();
  const protectedMessages = [new HumanMessage(JSON.stringify({ untrustedPage: page }))];
  const call = () =>
    new AIMessage({ content: "", tool_calls: [{ id: "reused", name: "act", args: {} }] });
  const result = () =>
    new ToolMessage({ tool_call_id: "reused", content: JSON.stringify({ observation: page }) });
  for (const history of [
    [call(), result(), call(), result()],
    [call(), result(), result()],
  ]) {
    assert.equal(referencePageContext(protectedMessages, history), protectedMessages);
  }
});
