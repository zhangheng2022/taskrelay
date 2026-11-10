import "./ui-dom";
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { useThread, type ThreadPage } from "../packages/ui/src/use-thread";
import type { DraftEvent, ChatDraft } from "../packages/contracts/src/streaming";
import { transportWith } from "./ui-fixtures";
afterEach(cleanup);

test("正文事件直接更新聊天；重复、乱序和旧修复版本不覆盖，正式消息接替草稿", async () => {
  let page: ThreadPage = {
    id: "thread",
    modelId: "model",
    taskId: "task",
    version: 1,
    draft: null,
    partial: {},
    activeTurn: "turn",
    messages: [],
    nextCursor: null,
    drafts: [],
  };
  const transport = transportWith(async (_method, path) =>
    path.split("?")[0] === "/api/user/threads"
      ? { items: [{ id: "thread", model_id: "model", task_id: "task" }] }
      : structuredClone(page),
  );
  let emit!: (event: DraftEvent) => void;
  transport.subscribeDrafts = (listener) => {
    emit = listener;
    return () => {};
  };
  const { result } = renderHook(() => useThread(transport, "chat", "model", "task"));
  await waitFor(() => assert.equal(result.current.page?.id, "thread"));
  const draft: ChatDraft = {
    id: "reply",
    threadId: "thread",
    callId: "call",
    version: 0,
    seq: 1,
    content: "首段",
    source: "cloud",
    at: new Date().toISOString(),
    status: "streaming",
  };
  const send = (value: ChatDraft, type: DraftEvent["type"] = "draft.update") =>
    act(async () => {
      emit({ protocol: 2, type, draft: value });
    });
  await send(draft, "draft.start");
  assert.equal(result.current.page?.drafts?.[0].content, "首段");
  await send({ ...draft, seq: 2, content: "首段后续" });
  await send(draft);
  assert.equal(result.current.page?.drafts?.[0].content, "首段后续");
  const repaired = { ...draft, version: 1, callId: "repair", content: "修复后正文" };
  await send(repaired);
  await send({ ...draft, seq: 3 }, "draft.end");
  assert.equal(result.current.page?.drafts?.[0].content, "修复后正文");
  page = {
    ...page,
    activeTurn: null,
    messages: [
      {
        id: "final",
        seq: 1,
        role: "assistant",
        content: "最终正文",
        at: draft.at,
        source_call_id: "repair",
      },
    ],
  };
  await act(async () => {
    await result.current.refresh();
  });
  await send({ ...repaired, seq: 2 });
  assert.deepEqual(result.current.page?.drafts, []);
  assert.equal(result.current.page?.messages[0].content, "最终正文");
});

test("读取旧快照期间到达的正文不倒退，撤下草稿后迟到事件不能复活", async () => {
  const page: ThreadPage = {
    id: "thread",
    modelId: "model",
    taskId: "task",
    version: 1,
    draft: null,
    partial: {},
    activeTurn: "turn",
    messages: [],
    nextCursor: null,
    drafts: [],
  };
  let pending: Promise<ThreadPage> | undefined;
  const transport = transportWith(async (_method, path) =>
    path.split("?")[0] === "/api/user/threads"
      ? { items: [{ id: "thread", model_id: "model", task_id: "task" }] }
      : (pending ?? structuredClone(page)),
  );
  let emit!: (event: DraftEvent) => void;
  transport.subscribeDrafts = (listener) => {
    emit = listener;
    return () => {};
  };
  const { result } = renderHook(() => useThread(transport, "chat", "model", "task"));
  await waitFor(() => assert.equal(result.current.page?.id, "thread"));
  let resolve!: (value: ThreadPage) => void;
  pending = new Promise((r) => {
    resolve = r;
  });
  let reading!: Promise<void>;
  await act(async () => {
    reading = result.current.refresh();
  });
  const draft: ChatDraft = {
    id: "reply",
    threadId: "thread",
    callId: "call",
    version: 0,
    seq: 1,
    content: "新正文",
    source: "cloud",
    at: new Date().toISOString(),
    status: "streaming",
  };
  await act(async () => {
    emit({ protocol: 2, type: "draft.start", draft });
  });
  await act(async () => {
    resolve(structuredClone(page));
    await reading;
  });
  assert.equal(result.current.page?.drafts?.[0].content, "新正文");
  pending = undefined;
  await act(async () => {
    emit({ protocol: 2, type: "draft.end", draft: { ...draft, seq: 2 } });
  });
  await act(async () => {
    emit({ protocol: 2, type: "draft.update", draft });
  });
  assert.deepEqual(result.current.page?.drafts, []);
});
