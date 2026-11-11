import "./ui-dom";
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { render, cleanup, fireEvent, waitFor, act } from "@testing-library/react";
import { Memories } from "../packages/ui/src/memories";
import { AccountSecurity } from "../packages/ui/src/account-security";
import { RetentionSettings } from "../packages/ui/src/settings-retention";
import { QueryBoundary } from "../packages/ui/src/queries";
import { transportWith } from "./ui-fixtures";
import { requestUrl } from "./http-fixture";
afterEach(cleanup);

test("记忆冲突读取新版本时保留草稿，明确核对后用新版本提交，等待中不能改变启用选项", async () => {
  let memory = {
    id: "style",
    text: "旧偏好",
    enabled: false,
    version: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  let release!: () => void;
  const writes: unknown[] = [];
  const transport = transportWith(async (method, path, body) => {
    if (method === "GET") return { items: [memory], nextCursor: null };
    writes.push(body);
    if (body.expectedVersion !== memory.version) throw Error("MEMORY_VERSION_CONFLICT");
    await new Promise<void>((r) => {
      release = r;
    });
    memory = { ...memory, ...body, version: memory.version + 1 };
    return { ok: true };
  });
  const view = render(<Memories transport={transport} />);
  await view.findByText("旧偏好");
  fireEvent.click(view.getByRole("button", { name: "编辑" }));
  fireEvent.change(view.getByLabelText("修改记忆"), { target: { value: "我的草稿" } });
  memory = { ...memory, text: "其他地方的新内容", version: 2 };
  fireEvent.click(view.getByRole("button", { name: "保存记忆" }));
  await view.findByText(/这条记忆已被修改或删除/);
  fireEvent.click(view.getByRole("button", { name: "刷新记忆列表" }));
  await view.findByText(/已保存：其他地方的新内容/);
  assert.equal((view.getByLabelText("修改记忆") as HTMLTextAreaElement).value, "我的草稿");
  assert.equal(
    (view.getByRole("button", { name: "保存记忆" }) as HTMLButtonElement).disabled,
    true,
  );
  fireEvent.click(view.getByRole("button", { name: "已核对，保留草稿继续编辑" }));
  fireEvent.click(view.getByRole("button", { name: "保存记忆" }));
  await waitFor(() => assert.equal(writes.length, 2));
  assert.equal((view.getByLabelText("用于后续任务") as HTMLInputElement).disabled, true);
  await act(async () => release());
  await view.findByRole("status");
  assert.equal(memory.text, "我的草稿");
  assert.equal(memory.version, 3);
});

test("保留期保存禁用字段，成功但刷新失败明确区分且不重发", async () => {
  let release!: () => void,
    saved = false,
    writes = 0;
  const transport = transportWith(async (method) => {
    if (method === "GET") {
      if (saved) throw Error("OFFLINE");
      return { retentionDays: 30 };
    }
    writes++;
    await new Promise<void>((r) => (release = r));
    saved = true;
    return { ok: true };
  });
  const view = render(
    <QueryBoundary owner={transport}>
      <RetentionSettings transport={transport} />
    </QueryBoundary>,
  );
  const input = await view.findByLabelText("保留天数（1–365 天）");
  fireEvent.change(input, { target: { value: "60" } });
  fireEvent.click(view.getByRole("button", { name: "保存设置" }));
  await waitFor(() => assert.equal(writes, 1));
  assert.equal((input as HTMLInputElement).disabled, true);
  await act(async () => release());
  await view.findByText(/已保存，但列表刷新失败/);
  assert.equal(writes, 1);
});

test("改密已成功而退出未确认时保留成功事实，不重复改密", async (t) => {
  let changes = 0,
    exits = 0;
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    const url = requestUrl(input);
    if (url.includes("list-sessions")) return Response.json([]);
    if (url.includes("get-session")) return Response.json(null);
    if (url.includes("change-password")) {
      changes++;
      return Response.json({ token: null, user: { id: "test" } });
    }
    if (url.includes("sign-out")) {
      exits++;
      throw Error("network");
    }
    throw Error("unexpected");
  });
  const view = render(
    <QueryBoundary owner="security">
      <AccountSecurity />
    </QueryBoundary>,
  );
  fireEvent.change(view.getByLabelText("当前密码"), { target: { value: "old-password-value" } });
  fireEvent.change(view.getByLabelText("新密码（12–128 位）"), {
    target: { value: "new-password-value" },
  });
  const confirm = view.getByLabelText("确认新密码");
  fireEvent.change(confirm, { target: { value: "different-password" } });
  fireEvent.submit(view.getByRole("button", { name: "修改密码并重新登录" }).closest("form")!);
  const mismatch = view.getByText("两次输入的新密码不一致");
  assert.equal(confirm.getAttribute("aria-describedby"), mismatch.id);
  assert.equal(changes, 0);
  fireEvent.change(confirm, { target: { value: "new-password-value" } });
  fireEvent.submit(view.getByRole("button", { name: "修改密码并重新登录" }).closest("form")!);
  await view.findByText(/密码已修改，其他会话已撤销/);
  assert.equal(changes, 1);
  assert.equal(exits, 1);
  assert.equal((view.getByLabelText("当前密码") as HTMLInputElement).value, "");
});
