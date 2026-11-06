import { requestUrl, jsonBody } from "./http-fixture";
import "./ui-dom";
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { render, fireEvent, cleanup, waitFor, act } from "@testing-library/react";
import { useQueryClient } from "@tanstack/react-query";
import { QueryBoundary, useTransportQuery } from "../packages/ui/src/queries";
import { ModelDialog } from "../packages/ui/src/model-dialog";
import { AdminPanel } from "../packages/ui/src/admin-panel";
import { AuthGate } from "../packages/ui/src/auth-gate";
import { authClient, authResult, botHeaders } from "../packages/ui/src/auth-client";
import { requestJson } from "../packages/ui/src/request";
import { createApi, rpcData } from "../packages/ui/src/api";
import { snapshot, transportWith } from "./ui-fixtures";
import type { Transport } from "../packages/contracts/src/index";
Object.defineProperty(globalThis, "location", { configurable: true, value: window.location });
afterEach(cleanup);

test("RPC 传递路径、参数和取消信号；HTTP 失败不会变成成功或自动重试", async () => {
  const controller = new AbortController();
  let calls = 0;
  const transport: Transport = {
    request: async (method, path, body, options) => {
      calls++;
      assert.equal(method, "POST");
      assert.equal(path, "/api/user/threads/thread/messages");
      assert.deepEqual(body, { requestId: "request", content: "继续读取" });
      assert.equal(options?.signal, controller.signal);
      throw Error("REQUEST_UNCONFIRMED");
    },
  };
  await assert.rejects(
    rpcData(
      createApi(transport).api.user.threads[":id"].messages.$post(
        { param: { id: "thread" }, json: { requestId: "request", content: "继续读取" } },
        { init: { signal: controller.signal } },
      ),
    ),
    /REQUEST_UNCONFIRMED/,
  );
  assert.equal(calls, 1);
});

test("读取取消与写入结果未知保持区分；取消前没有发出请求", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls++;
    return await new Promise((_resolve, reject) =>
      init?.signal?.addEventListener("abort", () => reject(Error("aborted")), { once: true }),
    );
  });
  const early = new AbortController();
  early.abort();
  await assert.rejects(requestJson("/test", { signal: early.signal }), /REQUEST_CANCELLED/);
  assert.equal(calls, 0);
  for (const method of ["GET", "POST"]) {
    const controller = new AbortController(),
      pending = requestJson("/test", { method, signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, method === "GET" ? /REQUEST_CANCELLED/ : /REQUEST_UNCONFIRMED/);
  }
  assert.equal(calls, 2);
});

test("查询去重、首次读取中通知取消旧请求、用户切换清缓存和拒绝迟到数据", async () => {
  let notify = () => {},
    calls = 0,
    oldSignal: AbortSignal | undefined,
    oldResolve!: (s: string) => void;
  const transport = {
    subscribe: (fn: () => void) => {
      notify = fn;
      return () => {};
    },
  };
  const clients: ReturnType<typeof useQueryClient>[] = [];
  const read = async (signal: AbortSignal) => {
    calls++;
    if (calls === 1) {
      oldSignal = signal;
      return new Promise<string>((r) => {
        oldResolve = r;
      });
    }
    return "已刷新";
  };
  function Data({ owner }: { owner: string }) {
    const client = useQueryClient();
    if (!clients.includes(client)) clients.push(client);
    const q = useTransportQuery(transport, ["state"], read, 60000);
    return (
      <span>
        {owner}:{q.data ?? "加载中"}
      </span>
    );
  }
  const view = render(
    <QueryBoundary key="a" owner="a">
      <Data owner="a" />
      <Data owner="a" />
    </QueryBoundary>,
  );
  await waitFor(() => assert.equal(calls, 1));
  await act(async () => notify());
  await view.findAllByText("a:已刷新");
  assert.equal(oldSignal?.aborted, true);
  assert.equal(calls, 2);
  view.rerender(
    <QueryBoundary key="b" owner="b">
      <Data owner="b" />
    </QueryBoundary>,
  );
  await view.findByText("b:已刷新");
  assert.equal(clients.length, 2);
  assert.equal(clients[0].getQueryCache().getAll().length, 0);
  await act(async () => oldResolve("旧用户数据"));
  assert.equal(view.queryByText(/旧用户数据/), null);
  assert.equal(clients[1].getDefaultOptions().queries?.retry, false);
  assert.equal(clients[1].getDefaultOptions().mutations?.retry, false);
});

test("模型表单保留编辑草稿、Zod 阻止无效预算、请求失败清密钥且不重试", async () => {
  let calls = 0;
  const transport = transportWith(async () => {
    calls++;
    throw Error("REQUEST_UNCONFIRMED");
  });
  const original = { ...snapshot.models[0], contextTokens: 16000, outputTokens: 4096 };
  const props = { transport, onClose: () => {}, onSaved: async () => {} };
  const view = render(<ModelDialog {...props} value={original} />);
  fireEvent.change(view.getByLabelText("配置名称"), { target: { value: "我的编辑" } });
  view.rerender(<ModelDialog {...props} value={{ ...original, name: "后台版本", version: 2 }} />);
  assert.equal((view.getByLabelText("配置名称") as HTMLInputElement).value, "我的编辑");
  fireEvent.change(view.getByLabelText("输出预留（token）"), { target: { value: "8192" } });
  fireEvent.change(view.getByLabelText("上下文预算（token，保守估计）"), {
    target: { value: "8192" },
  });
  fireEvent.submit(view.getByRole("button", { name: "保存配置" }).closest("form")!);
  await waitFor(() =>
    assert.equal(
      view.getByLabelText("上下文预算（token，保守估计）").getAttribute("aria-invalid"),
      "true",
    ),
  );
  assert.equal(calls, 0);
  fireEvent.change(view.getByLabelText("上下文预算（token，保守估计）"), {
    target: { value: "32000" },
  });
  fireEvent.change(view.getByLabelText("API Key"), { target: { value: "test-secret" } });
  fireEvent.submit(view.getByRole("button", { name: "保存配置" }).closest("form")!);
  await waitFor(() => assert.equal(calls, 1));
  await waitFor(() => assert.equal((view.getByLabelText("API Key") as HTMLInputElement).value, ""));
  assert.equal((view.getByLabelText("配置名称") as HTMLInputElement).value, "我的编辑");
  assert.equal(calls, 1);
});

test("管理员表单刷新更新未编辑字段，保留已编辑字段", async () => {
  let notify = () => {};
  let user = {
    id: "member",
    email: "test@example.com",
    role: "user",
    disabled: 0,
    daily_runs: 10,
    scheduled_tasks: 20,
    queued_runs: 30,
    daily_chat: 40,
    daily_models: 50,
  };
  const transport = transportWith(async () => ({
    users: [user],
    devices: [],
    runs: [],
    accounts: [],
    settings: { claimsEnabled: "1" },
  }));
  transport.subscribe = (fn) => {
    notify = fn;
    return () => {};
  };
  const view = render(<AdminPanel transport={transport} />);
  await view.findByLabelText("每日启动");
  fireEvent.change(view.getByLabelText("每日启动"), { target: { value: "11" } });
  user = { ...user, daily_runs: 12, scheduled_tasks: 21 };
  await act(async () => notify());
  await waitFor(() =>
    assert.equal((view.getByLabelText("周期任务") as HTMLInputElement).value, "21"),
  );
  assert.equal((view.getByLabelText("每日启动") as HTMLInputElement).value, "11");
});

test("官方认证方法保留 Turnstile，失败不重试；认证成功仍需通过成员校验", async (t) => {
  t.mock.property(globalThis, "FormData", window.FormData);
  const writes: { url: string; body: unknown; token: string | null }[] = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input);
    if (url.endsWith("/config")) return Response.json({ registrationOpen: true, siteKey: "test" });
    if (url.includes("/get-session")) return Response.json(null);
    if (init?.method === "POST")
      writes.push({
        url,
        body: jsonBody(init.body),
        token: new Headers(init.headers).get("x-turnstile-token"),
      });
    if (url.includes("/sign-up"))
      return Response.json({ code: "EMAIL_ALREADY_EXISTS" }, { status: 400 });
    return Response.json({
      token: "fake-session",
      user: { id: "auth-user", email: "test@example.com" },
    });
  });
  await assert.rejects(
    authResult(
      authClient.signUp.email(
        { email: "test@example.com", password: "not-a-real-password", name: "Test" },
        botHeaders("test-challenge"),
      ),
    ),
    /EMAIL_ALREADY_EXISTS/,
  );
  assert.equal(writes.length, 1);
  assert.equal(writes[0].token, "test-challenge");
  assert.ok(writes[0].url.endsWith("/sign-up/email"));
  let memberReads = 0;
  const view = render(
    <AuthGate
      transport={transportWith(async () => {
        memberReads++;
        throw Error(memberReads === 1 ? "AUTH_REQUIRED" : "MEMBER_DISABLED");
      })}
    >
      <span>私有工作空间</span>
    </AuthGate>,
  );
  await view.findByLabelText("密码");
  fireEvent.change(view.getByLabelText("邮箱"), { target: { value: "test@example.com" } });
  fireEvent.change(view.getByLabelText("密码"), { target: { value: "not-a-real-password" } });
  fireEvent.submit(view.getByRole("button", { name: "登录 TaskRelay" }).closest("form")!);
  await waitFor(() => assert.ok(memberReads >= 2));
  assert.equal(view.queryByText("私有工作空间"), null);
  assert.equal(writes.filter((w) => w.url.endsWith("/sign-in/email")).length, 1);
});

// 类型回归：客户端不能传错参数，服务端实现仅以 type 导入，不进入浏览器依赖图。
async function invalidRpcTypes(transport: Transport) {
  const client = createApi(transport);
  await client.api.user.threads[":id"].messages.$post({
    param: { id: "t" },
    // @ts-expect-error 运行参数必须携带 requestId
    json: { content: "x" },
  });
  // @ts-expect-error 模型 ID 是路径参数
  await client.api.admin.models[":id"].$put({ json: {} });
}
void invalidRpcTypes;
