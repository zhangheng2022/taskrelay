import "./ui-dom";
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  render,
  fireEvent,
  cleanup,
  waitFor,
  act,
} from "@testing-library/react";
import { Conversation } from "../packages/ui/src/conversation";
import { RunReport } from "../packages/ui/src/run-report";
import { task, run, challenge, transportWith } from "./ui-fixtures";
import type { HumanChallenge } from "../packages/contracts/src/index";

afterEach(cleanup);
test("run trace expands actual events, keeps unknown usage, and renders results as inert text", () => {
  const view = render(
    <RunReport
      run={{
        ...run,
        status: "unknown",
        result: {
          summary: "结果待确认",
          outcome: "unconfirmed",
          data: "<script>alert(1)</script>",
          evidence: [
            {
              url: "javascript:alert(1)",
              quote: "页面证据",
              capturedAt: run.createdAt,
            },
          ],
        },
      }}
      events={[
        {
          id: "event",
          runId: run.id,
          sequence: 2,
          kind: "error",
          message: "真实脱敏错误摘要",
          at: run.createdAt,
        },
      ]}
      usage={[{ input: null, output: null, cost: null }]}
      disabled={false}
      onCancel={() => {}}
      onReconcile={() => {}}
    />,
  );
  assert.ok(view.getByText("真实脱敏错误摘要"));
  assert.equal(view.container.querySelector("script"), null);
  assert.ok(view.getByRole("button", { name: "只读核查结果" }));
  fireEvent.click(view.getByRole("button", { name: "模型用量" }));
  assert.ok(view.getByText("实际用量：未知 · 费用：未知"));
  fireEvent.click(view.getByRole("button", { name: "证据 1" }));
  assert.ok(view.getByText("页面证据"));
  assert.equal(view.queryByRole("link"), null);
});
function setup(current: HumanChallenge = challenge) {
  const writes: { path: string; body: any }[] = [];
  const transport = transportWith(async (method, path, body) => {
    if (method === "POST") {
      writes.push({ path, body });
      return { ok: true };
    }
    return path.endsWith("/chat") ? [] : { events: [], usage: [] };
  });
  const props = {
    transport,
    task,
    run,
    challenges: [current],
    refresh: async () => {},
    onEdit: () => {},
    offline: false,
  };
  return { writes, props, view: render(<Conversation {...props} />) };
}

test("approval sends exact explicit consent and complete current binding; repeat click is blocked", async () => {
  const { view, writes } = setup({
    ...challenge,
    kind: "approval",
    instruction: "删除本人测试草稿",
  });
  const button = view.getByRole("button", { name: "确认执行" });
  fireEvent.click(button);
  fireEvent.click(button);
  await view.findByText("已回复，等待执行器核查网站实际状态。");
  assert.deepEqual(writes, [
    {
      path: `/api/user/challenges/${challenge.id}/reply`,
      body: {
        runId: run.id,
        stepId: challenge.stepId,
        version: 3,
        leaseEpoch: 2,
        text: "确认执行",
      },
    },
  ]);
  assert.equal(view.queryByRole("button", { name: "确认执行" }), null);
});

test("deny cancels the current run and never submits an approval or claims the run stopped", async () => {
  const { view, writes } = setup({ ...challenge, kind: "approval" });
  fireEvent.click(view.getByRole("button", { name: "拒绝并取消本次运行" }));
  await view.findByText("已请求取消，等待执行器停止");
  assert.deepEqual(
    writes.map((w) => w.path),
    [`/api/user/runs/${run.id}/cancel`],
  );
  assert.equal(view.queryByRole("button", { name: "确认执行" }), null);
});

test("code preserves leading zeros/case and never enters the conversation history", async () => {
  const { view, writes } = setup();
  fireEvent.change(view.getByRole("textbox"), {
    target: { value: "0012aB-0" },
  });
  fireEvent.keyDown(view.getByRole("textbox"), { key: "Enter" });
  await waitFor(() =>
    assert.equal((view.getByRole("textbox") as HTMLTextAreaElement).value, ""),
  );
  assert.equal(writes[0].body.text, "0012aB-0");
  assert.equal(
    writes.some((w) => w.path.endsWith("/chat")),
    false,
  );
  assert.equal(view.container.textContent?.includes("0012aB-0"), false);
});

test("a new challenge step/lease clears the old reply and targets only the new binding", async () => {
  const { view, writes, props } = setup();
  fireEvent.change(view.getByRole("textbox"), {
    target: { value: "old-secret" },
  });
  view.rerender(
    <Conversation
      {...props}
      challenges={[
        { ...challenge, stepId: "second-step", version: 4, leaseEpoch: 3 },
      ]}
    />,
  );
  assert.equal((view.getByRole("textbox") as HTMLTextAreaElement).value, "");
  fireEvent.change(view.getByRole("textbox"), { target: { value: "0009" } });
  fireEvent.click(view.getByRole("button", { name: "发送消息" }));
  await waitFor(() => assert.equal(writes.length, 1));
  assert.equal(writes[0].body.stepId, "second-step");
  assert.equal(writes[0].body.leaseEpoch, 3);
});

test("expiry clears a typed reply without waiting for polling and prevents transmission", async () => {
  const { view, writes } = setup({
    ...challenge,
    expiresAt: new Date(Date.now() + 120).toISOString(),
  });
  fireEvent.change(view.getByRole("textbox"), { target: { value: "0012" } });
  await view.findByText("此协助请求已过期，请等待执行状态更新。");
  assert.equal((view.getByRole("textbox") as HTMLTextAreaElement).value, "");
  assert.ok(
    view.getByRole("button", { name: "发送消息" }).hasAttribute("disabled"),
  );
  assert.equal(writes.length, 0);
});

test("scan acknowledges external completion but keeps waiting for actual site verification", async () => {
  const { view, writes } = setup({ ...challenge, kind: "scan" });
  fireEvent.click(view.getByRole("button", { name: "已扫码，检查状态" }));
  await view.findByText("已回复，等待执行器核查网站实际状态。");
  assert.match(writes[0].body.text, /检查网站状态/);
  assert.equal(view.queryByText("已完成"), null);
});

test("unsupported, answered, expired and offline challenges cannot submit", async () => {
  const { view, props, writes } = setup({ ...challenge, kind: "unsupported" });
  for (const c of [
    { ...challenge, kind: "unsupported" as const },
    { ...challenge, status: "answered" as const },
    { ...challenge, expiresAt: new Date(0).toISOString() },
  ]) {
    view.rerender(<Conversation {...props} challenges={[c]} />);
    assert.ok(view.getByRole("textbox").hasAttribute("disabled"));
  }
  view.rerender(<Conversation {...props} offline />);
  assert.ok(view.getByRole("textbox").hasAttribute("disabled"));
  assert.equal(writes.length, 0);
  await act(async () => {});
});

test("a late polling response cannot replace a just-sent chat response", async () => {
  let resolveOld!: (value: unknown) => void,
    reads = 0;
  const fresh = [
    {
      id: "answer",
      role: "assistant",
      content: "新的回复",
      at: new Date().toISOString(),
    },
  ];
  const transport = transportWith(async (method, path) => {
    if (method === "POST") return { ok: true };
    if (!path.endsWith("/chat")) return { events: [], usage: [] };
    if (reads++ === 0)
      return new Promise((r) => {
        resolveOld = r;
      });
    return fresh;
  });
  const view = render(
    <Conversation
      transport={transport}
      task={task}
      run={null}
      challenges={[]}
      refresh={async () => {}}
      onEdit={() => {}}
      offline={false}
    />,
  );
  fireEvent.change(view.getByRole("textbox"), {
    target: { value: "状态如何" },
  });
  fireEvent.click(view.getByRole("button", { name: "发送消息" }));
  await view.findByText("新的回复");
  await act(async () => {
    resolveOld([]);
  });
  assert.ok(view.getByText("新的回复"));
});
