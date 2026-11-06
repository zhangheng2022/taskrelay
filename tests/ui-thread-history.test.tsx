import "./ui-dom";
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { useThread, type ThreadPage } from "../packages/ui/src/use-thread";
import { transportWith } from "./ui-fixtures";

afterEach(cleanup);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function page(first: number, last: number, nextCursor: number | null): ThreadPage {
  const messages = Array.from({ length: last - first + 1 }, (_, index) => ({
    id: `message_${first + index}`,
    seq: first + index,
    role: "assistant",
    content: `消息 ${first + index}`,
    at: "2026-11-05T00:00:00.000Z",
  }));
  return {
    id: "history",
    modelId: "model",
    taskId: "task",
    version: 1,
    draft: null,
    partial: {},
    activeTurn: null,
    messages,
    nextCursor,
    replies: messages.map((message) => ({
      id: `reply_${message.seq + 200}`,
      cursor: message.seq + 200,
      role: "user",
      content: `协助 ${message.seq + 200}`,
      at: message.at,
      status: "answered",
    })),
    nextReplyCursor: nextCursor === null ? null : nextCursor + 200,
  };
}

for (const operation of ["refresh", "send"] as const) {
  for (const firstResponse of ["history", "latest"] as const) {
    test(`${operation} 与历史分页交错，${firstResponse} 先返回时仍保留两种历史游标`, async () => {
      const history = deferred<ThreadPage>(),
        latest = deferred<ThreadPage>();
      const paths: string[] = [];
      let initial = true;
      const transport = transportWith(async (method, path) => {
        paths.push(`${method} ${path}`);
        if (path === "/api/user/threads")
          return [{ id: "history", model_id: "model", task_id: "task" }];
        if (initial) {
          initial = false;
          return page(101, 150, 101);
        }
        if (path.includes("?before=")) return history.promise;
        return latest.promise;
      });
      const { result } = renderHook(() => useThread(transport, "chat", "model", "task"));
      await waitFor(() => assert.equal(result.current.page?.messages.length, 50));
      let loadHistory!: Promise<void>, loadLatest!: Promise<unknown>;
      await act(async () => {
        loadHistory = result.current.older();
        loadLatest =
          operation === "send" ? result.current.send("补充要求") : result.current.refresh();
      });
      const finishHistory = async () => {
        history.resolve(page(51, 100, 51));
        await loadHistory;
      };
      const finishLatest = async () => {
        latest.resolve({ ...page(102, 151, 102), version: 2, activeTurn: "current-turn" });
        await loadLatest;
      };
      await act(firstResponse === "history" ? finishHistory : finishLatest);
      await act(firstResponse === "history" ? finishLatest : finishHistory);
      assert.equal(result.current.page?.nextCursor, 51);
      assert.equal(result.current.page?.nextReplyCursor, 251);
      assert.equal(result.current.page?.version, 2);
      assert.equal(result.current.page?.activeTurn, "current-turn");
      assert.equal(result.current.page?.messages.length, 101);
      assert.equal(result.current.page?.replies?.length, 101);
      assert.equal(result.current.page?.messages[0].seq, 51);
      assert.equal(result.current.page?.messages.at(-1)?.seq, 151);
      await act(async () => {
        await result.current.older();
      });
      assert.equal(paths.at(-1), "GET /api/user/threads/history?before=51&beforeReply=251");
    });
  }
}

test("历史读到底后，通知和发送均不会重新开放已结束的分页", async () => {
  const paths: string[] = [];
  let initial = true,
    notify = () => {};
  const transport = transportWith(async (method, path) => {
    paths.push(`${method} ${path}`);
    if (path === "/api/user/threads")
      return [{ id: "history", model_id: "model", task_id: "task" }];
    if (initial) {
      initial = false;
      return page(51, 100, 51);
    }
    if (path.includes("?before=")) return page(1, 50, null);
    return { ...page(52, 101, 52), version: 2 };
  });
  transport.subscribe = (listener) => {
    notify = listener;
    return () => {};
  };
  const { result } = renderHook(() => useThread(transport, "chat", "model", "task"));
  await waitFor(() => assert.equal(result.current.page?.nextCursor, 51));
  await act(async () => {
    await result.current.older();
  });
  await act(async () => {
    notify();
  });
  await act(async () => {
    await result.current.send("继续");
  });
  assert.equal(result.current.page?.nextCursor, null);
  assert.equal(result.current.page?.nextReplyCursor, null);
  const count = paths.length;
  await act(async () => {
    await result.current.older();
  });
  assert.equal(paths.length, count);
  assert.equal(result.current.page?.messages.length, 101);
});

test("空消息流首次收到有分页的数据时采用该流的起始游标", async () => {
  let initial = true;
  const transport = transportWith(async (_method, path) => {
    if (path === "/api/user/threads")
      return [{ id: "history", model_id: "model", task_id: "task" }];
    if (initial) {
      initial = false;
      return { ...page(1, 0, null), nextReplyCursor: null };
    }
    return page(51, 100, 51);
  });
  const { result } = renderHook(() => useThread(transport, "chat", "model", "task"));
  await waitFor(() => assert.ok(result.current.page));
  await act(async () => {
    await result.current.refresh();
  });
  assert.equal(result.current.page?.nextCursor, 51);
  assert.equal(result.current.page?.nextReplyCursor, 251);
});

test("两次刷新间新增超过一页时仍可回补中间缺口，不沿用旧的已读到底状态", async () => {
  let initial = true;
  const transport = transportWith(async (_method, path) => {
    if (path === "/api/user/threads")
      return [{ id: "history", model_id: "model", task_id: "task" }];
    if (initial) {
      initial = false;
      return page(1, 10, null);
    }
    if (path.includes("before=61&")) return page(11, 60, 11);
    if (path.includes("before=11&")) return page(1, 10, null);
    return { ...page(61, 110, 61), version: 2 };
  });
  const { result } = renderHook(() => useThread(transport, "chat", "model", "task"));
  await waitFor(() => assert.ok(result.current.page));
  await act(async () => {
    await result.current.refresh();
  });
  assert.equal(result.current.page?.nextCursor, 61);
  assert.equal(result.current.page?.nextReplyCursor, 261);
  await act(async () => {
    await result.current.older();
  });
  await act(async () => {
    await result.current.refresh();
  });
  assert.equal(result.current.page?.nextCursor, 11);
  assert.equal(result.current.page?.nextReplyCursor, 211);
  await act(async () => {
    await result.current.older();
  });
  assert.equal(result.current.page?.messages.length, 110);
  assert.equal(result.current.page?.replies?.length, 110);
  assert.equal(result.current.page?.nextCursor, null);
  assert.equal(result.current.page?.nextReplyCursor, null);
});

for (const gap of ["messages", "replies", "both"] as const) {
  test(`旧历史返回只推进自己的游标，保留最新页发现的 ${gap} 缺口`, async () => {
    const history = deferred<ThreadPage>();
    const paths: string[] = [];
    let initial = true;
    const latest = { ...page(151, 200, 151), version: 2 };
    if (gap === "messages") {
      latest.replies = page(52, 101, 52).replies;
      latest.nextReplyCursor = 252;
    } else if (gap === "replies") {
      latest.messages = page(52, 101, 52).messages;
      latest.nextCursor = 52;
    }
    const transport = transportWith(async (_method, path) => {
      paths.push(path);
      if (path === "/api/user/threads")
        return [{ id: "history", model_id: "model", task_id: "task" }];
      if (initial) {
        initial = false;
        return page(51, 100, 51);
      }
      if (path.includes("before=51&beforeReply=251")) return history.promise;
      if (path.includes("?before="))
        return {
          ...page(101, 150, 101),
          ...(gap === "messages" ? { replies: [], nextReplyCursor: null } : {}),
          ...(gap === "replies" ? { messages: [], nextCursor: null } : {}),
        };
      return latest;
    });
    const { result } = renderHook(() => useThread(transport, "chat", "model", "task"));
    await waitFor(() => assert.ok(result.current.page));
    let older!: Promise<void>;
    await act(async () => {
      older = result.current.older();
    });
    await act(async () => {
      await result.current.refresh();
    });
    await act(async () => {
      history.resolve(page(1, 50, null));
      await older;
    });
    const messageCursor = gap === "replies" ? null : 151;
    const replyCursor = gap === "messages" ? null : 351;
    assert.equal(result.current.page?.nextCursor, messageCursor);
    assert.equal(result.current.page?.nextReplyCursor, replyCursor);
    assert.equal(result.current.page?.messages[0].seq, 1);
    assert.equal(result.current.page?.replies?.[0].cursor, 201);
    await act(async () => {
      await result.current.older();
    });
    assert.equal(
      paths.at(-1),
      `/api/user/threads/history?before=${messageCursor ?? 1}&beforeReply=${replyCursor ?? 1}`,
    );
    assert.equal(result.current.page?.messages.length, gap === "replies" ? 101 : 200);
    assert.equal(result.current.page?.replies?.length, gap === "messages" ? 101 : 200);
  });
}

test("只有旧协助仍有下一页时继续翻页，不重新请求已读完的普通消息", async () => {
  const paths: string[] = [];
  const transport = transportWith(async (_method, path) => {
    paths.push(path);
    if (path === "/api/user/threads")
      return [{ id: "history", model_id: "model", task_id: "task" }];
    if (path.includes("?before=")) return { ...page(1, 50, null), messages: [] };
    return { ...page(51, 100, 51), nextCursor: null };
  });
  const { result } = renderHook(() => useThread(transport, "chat", "model", "task"));
  await waitFor(() => assert.ok(result.current.page));
  await act(async () => {
    await result.current.older();
  });
  await act(async () => {
    await result.current.refresh();
  });
  assert.ok(paths.includes("/api/user/threads/history?before=1&beforeReply=251"));
  assert.equal(result.current.page?.nextCursor, null);
  assert.equal(result.current.page?.nextReplyCursor, null);
  assert.equal(result.current.page?.messages.length, 50);
  assert.equal(result.current.page?.replies?.length, 100);
});

test("刷新、发送和历史同时进行时忽略旧快照，重复历史点击只发送一次请求", async () => {
  const history = deferred<ThreadPage>(),
    oldSnapshot = deferred<ThreadPage>(),
    sent = deferred<ThreadPage>();
  let initial = true,
    historyReads = 0;
  const transport = transportWith(async (method, path) => {
    if (path === "/api/user/threads")
      return [{ id: "history", model_id: "model", task_id: "task" }];
    if (initial) {
      initial = false;
      return page(101, 150, 101);
    }
    if (path.includes("?before=")) {
      historyReads++;
      return history.promise;
    }
    return method === "POST" ? sent.promise : oldSnapshot.promise;
  });
  const { result } = renderHook(() => useThread(transport, "chat", "model", "task"));
  await waitFor(() => assert.ok(result.current.page));
  let refresh!: Promise<void>, send!: Promise<unknown>, older!: Promise<void>;
  await act(async () => {
    refresh = result.current.refresh();
    send = result.current.send("新增要求");
    older = result.current.older();
    await result.current.older();
  });
  assert.equal(historyReads, 1);
  await act(async () => {
    history.resolve(page(51, 100, 51));
    await older;
  });
  await act(async () => {
    sent.resolve({ ...page(102, 151, 102), version: 2 });
    await send;
  });
  await act(async () => {
    oldSnapshot.resolve(page(101, 150, 101));
    await refresh;
  });
  assert.equal(result.current.page?.version, 2);
  assert.equal(result.current.page?.nextCursor, 51);
  assert.equal(result.current.page?.nextReplyCursor, 251);
  assert.equal(result.current.page?.messages.at(-1)?.seq, 151);
});
