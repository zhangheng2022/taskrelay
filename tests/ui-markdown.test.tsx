import "./ui-dom";
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { ChatMarkdown } from "../packages/ui/src/chat-markdown";
import { Conversation } from "../packages/ui/src/conversation";
import { TaskCompose } from "../packages/ui/src/task-compose";
import { snapshot, task, threadPage, transportWith } from "./ui-fixtures";
import type { ThreadPage } from "../packages/contracts/src/conversation";
import type { ChatDraft, DraftEvent } from "../packages/contracts/src/streaming";

afterEach(cleanup);

test("Markdown 常用格式、中文与可复制代码使用语义元素", async () => {
  const code = 'console.log("中文");\n\n// 下一行\n';
  const content =
    "# 标题\n\n中文 **加粗**、*强调*、~~删除~~ 与 `变量`。\n\n> 引用\n\n- 项目\n\n1. 顺序\n\n- [x] 完成\n- [ ] 待办\n\n| 名称 | 状态 |\n| --- | --- |\n| 测试 | 通过 |\n\n---\n\n```ts\n" +
    code +
    "```";
  const view = render(<ChatMarkdown content={content} />);
  assert.ok(view.getByRole("heading", { name: "标题" }));
  for (const selector of [
    "strong",
    "em",
    "del",
    "blockquote",
    "ul",
    "ol",
    "table",
    "hr",
    '[data-slot="code-block"]',
  ]) {
    assert.ok(view.container.querySelector(selector), selector);
  }
  const checks = view.getAllByRole("checkbox") as HTMLInputElement[];
  assert.deepEqual(
    checks.map((input) => [input.checked, input.disabled]),
    [
      [true, true],
      [false, true],
    ],
  );
  assert.equal(view.container.querySelectorAll('[data-slot="code-block-line"]').length, 3);
  const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  let copied = "";
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (value: string) => {
        copied = value;
      },
    },
  });
  try {
    fireEvent.click(view.getByRole("button", { name: "复制代码" }));
    await view.findByRole("button", { name: "已复制" });
    assert.equal(copied, code, "复制原始代码，不夹入行号或丢失空行");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          throw Error("denied");
        },
      },
    });
    fireEvent.click(view.getByRole("button", { name: "已复制" }));
    await view.findByText("复制失败，请重试");
  } finally {
    if (original) Object.defineProperty(navigator, "clipboard", original);
    else Reflect.deleteProperty(navigator, "clipboard");
  }
});

test("正文不执行 HTML、不请求图片，只将完整网页地址渲染为链接", () => {
  const content =
    '<script>alert(1)</script>\n\n<img src="https://tracker.test/pixel" onerror="alert(1)">\n\n![截图替代文本](https://tracker.test/pixel)\n\n[正常](https://example.com/path?q=1) [不安全](javascript:alert%281%29) [相对](/api/user) [数据](data:text/html,hello) [邮件](mailto:a@example.com) [凭据](https://user:pass@example.com) [本地](file:///C:/secret)';
  const view = render(<ChatMarkdown content={content} />);
  assert.equal(view.container.querySelector("script,img,iframe,object"), null);
  assert.ok(view.getByText("截图替代文本"));
  const links = view.getAllByRole("link");
  assert.equal(links.length, 1);
  assert.equal(links[0].getAttribute("href"), "https://example.com/path?q=1");
  assert.equal(links[0].getAttribute("target"), "_blank");
  assert.equal(links[0].getAttribute("rel"), "noopener noreferrer");
  for (const text of ["不安全", "相对", "数据", "邮件", "凭据", "本地"])
    assert.ok(view.getByText(text));
});

test("未闭合格式只在草稿补全；未完成链接始终不可点击", () => {
  const view = render(<ChatMarkdown content="**正在生成" status="streaming" />);
  assert.equal(view.container.querySelector("strong")?.textContent, "正在生成");
  view.rerender(<ChatMarkdown content="[继续](https://example.com" status="streaming" />);
  assert.equal(view.queryByRole("link"), null);
  assert.ok(view.getByText("继续"));
  view.rerender(<ChatMarkdown content={"```ts\nconst x = 1;"} status="pending" />);
  assert.ok(view.container.querySelector('[data-slot="code-block"]'));
  view.rerender(<ChatMarkdown content="**正在生成" status="interrupted" />);
  assert.ok(view.container.querySelector("strong"));
  view.rerender(<ChatMarkdown content="**正在生成" />);
  assert.equal(view.container.querySelector("strong"), null);
  assert.ok(view.getByText("**正在生成"));
});

for (const host of ["compose", "conversation"] as const) {
  test(`${host} 真实入口区分用户原文、助手正文与附件，流式终态只保留一条回复`, async () => {
    let page: ThreadPage = {
      ...threadPage,
      messages: [
        { id: "user", seq: 1, role: "user", content: "**用户原文**", at: new Date().toISOString() },
        {
          id: "assistant",
          seq: 2,
          role: "assistant",
          source: "executor",
          content: "**助手回复**",
          at: new Date().toISOString(),
          parts: [{ type: "tool", name: "test", result: "**附件原文**" }],
        },
      ],
    };
    let emit!: (event: DraftEvent) => void;
    let changed!: () => void;
    const transport = transportWith(async (_method, path) =>
      path.split("?")[0] === "/api/user/threads"
        ? {
            items: [
              { id: page.id, model_id: task.modelId, task_id: host === "compose" ? null : task.id },
            ],
          }
        : structuredClone(page),
    );
    transport.subscribeDrafts = (callback) => {
      emit = callback;
      return () => {};
    };
    transport.subscribe = (callback) => {
      changed = callback;
      return () => {};
    };
    const view = render(
      host === "compose" ? (
        <TaskCompose
          transport={transport}
          snapshot={snapshot}
          offline={false}
          onSaved={async () => {}}
          onSettings={() => {}}
        />
      ) : (
        <Conversation
          transport={transport}
          task={task}
          run={null}
          offline={false}
          refresh={async () => {}}
        />
      ),
    );
    assert.equal((await view.findByText("助手回复")).tagName, "STRONG");
    assert.ok(view.getByText("**用户原文**"));
    assert.ok(view.getByText("**附件原文**"));
    let draft: ChatDraft = {
      id: "draft",
      threadId: page.id,
      callId: "call",
      version: 0,
      seq: 0,
      content: "**流式",
      at: new Date().toISOString(),
      source: "cloud",
      status: "streaming",
    };
    const send = async (updates: Partial<ChatDraft>) => {
      draft = { ...draft, seq: draft.seq + 1, ...updates };
      await act(async () => emit({ protocol: 2, type: "draft.update", draft }));
    };
    await send({});
    assert.equal((await view.findByText("流式")).tagName, "STRONG");
    await send({ content: "**流式回复**", status: "pending" });
    assert.ok(await view.findByText(/正在确认回复/));
    await send({ status: "interrupted" });
    assert.ok(await view.findByText(/生成中断/));
    page = {
      ...page,
      version: 1,
      drafts: [],
      messages: [
        ...page.messages,
        {
          id: "final",
          seq: 3,
          role: "assistant",
          content: draft.content,
          source_call_id: draft.callId,
          at: draft.at,
        },
      ],
    };
    await act(async () => changed());
    await waitFor(() => assert.equal(view.queryByText(/生成中断/), null));
    await send({ status: "streaming" });
    assert.equal(view.getAllByText("流式回复").length, 1);
    assert.equal(view.container.querySelectorAll('[data-slot="message-scroller-item"]').length, 3);
  });
}
