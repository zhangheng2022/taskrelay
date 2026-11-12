import "./ui-dom";
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { render, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { SettingsModels } from "../packages/ui/src/settings-models";
import { AdminPanel } from "../packages/ui/src/admin-panel";
import { AccountSecurity } from "../packages/ui/src/account-security";
import { QueryBoundary } from "../packages/ui/src/queries";
import { PROTOCOL_VERSION } from "../packages/contracts/src/index";
import { snapshot, transportWith } from "./ui-fixtures";
import { requestUrl } from "./http-fixture";
afterEach(cleanup);

test("模型管理区分连接与任务能力，确认停用和恢复，删除冲突不重放", async () => {
  let state = structuredClone(snapshot);
  state.models[0] = {
    ...state.models[0],
    enabled: true,
    managementVersion: 7,
    capabilities: {
      connection: true,
      tools: false,
      structured: "none",
      vision: false,
      testedAt: null,
    },
  };
  const writes: { method: string; path: string; body: unknown }[] = [];
  const transport = transportWith(async (method, path, body) => {
    writes.push({ method, path, body });
    if (method === "DELETE") {
      if (state.models[0].enabled) throw Error("MODEL_DISABLE_BEFORE_DELETE");
      state.models = [];
      return { ok: true };
    }
    if (path.endsWith("/state")) {
      assert.equal(body.expectedVersion, state.models[0].managementVersion);
      state.models[0] = {
        ...state.models[0],
        enabled: body.enabled,
        managementVersion: body.expectedVersion + 1,
      };
    } else if (path.includes("/test?version=")) {
      state.models[0].capabilities = {
        ...state.models[0].capabilities,
        questionAnswered: true,
        tools: true,
        structured: "schema",
        testedAt: new Date().toISOString(),
      };
    } else if (path.includes("/vision?version=")) {
      state.models[0].capabilities = {
        ...state.models[0].capabilities,
        vision: false,
        visionTestedAt: new Date().toISOString(),
      };
    }
    return { ok: true };
  });
  const refresh = async () =>
    view.rerender(
      <SettingsModels snapshot={{ ...state }} transport={transport} refresh={refresh} />,
    );
  const view = render(<SettingsModels snapshot={state} transport={transport} refresh={refresh} />);
  const menu = async (label: string) => {
    fireEvent.keyDown(view.getByRole("button", { name: /更多：/ }), { key: "ArrowDown" });
    fireEvent.click(await view.findByRole("menuitem", { name: label }));
  };
  assert.equal(view.queryByText("工具调用 未通过"), null);
  await menu("停用");
  let dialog = await view.findByRole("alertdialog");
  assert.match(dialog.textContent!, /任务标记为失败/);
  fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
  assert.equal(writes.length, 0);
  await menu("停用");
  fireEvent.click(
    within(await view.findByRole("alertdialog")).getByRole("button", { name: "停用模型" }),
  );
  await view.findByText("已停用");
  await waitFor(() =>
    assert.equal(
      (view.getByRole("button", { name: "测试模型" }) as HTMLButtonElement).disabled,
      false,
    ),
  );
  fireEvent.click(view.getByRole("button", { name: "测试模型" }));
  fireEvent.click(await view.findByRole("button", { name: "启用" }));
  dialog = await view.findByRole("alertdialog");
  assert.match(dialog.textContent!, /旧任务不会自动重试/);
  fireEvent.click(within(dialog).getByRole("button", { name: "启用模型" }));
  await view.findByText("已启用");
  assert.deepEqual(
    writes.filter((w) => w.path.endsWith("/state")).map((w) => w.body),
    [
      { expectedVersion: 7, enabled: false },
      { expectedVersion: 8, enabled: true },
    ],
  );
  await menu("测试详情");
  await view.findByText("工具调用 通过");
  fireEvent.click(view.getByRole("button", { name: "测试图像" }));
  await view.findByText("图像输入 未通过");
  fireEvent.keyDown(view.getByRole("dialog"), { key: "Escape" });
  await menu("删除");
  fireEvent.click(
    within(await view.findByRole("alertdialog")).getByRole("button", { name: "永久删除模型" }),
  );
  await view.findByText(/请先停用，再删除模型配置/);
  assert.equal(writes.filter((w) => w.method === "DELETE").length, 1);
  fireEvent.click(view.getByRole("button", { name: "筛选" }));
  fireEvent.change(view.getByLabelText("搜索名称或模型"), { target: { value: "不存在" } });
  await view.findByText("没有匹配的模型");
  fireEvent.change(view.getByLabelText("搜索名称或模型"), { target: { value: "" } });
  fireEvent.change(view.getByLabelText("筛选状态"), { target: { value: "disabled" } });
  await view.findByText("没有匹配的模型");
  fireEvent.change(view.getByLabelText("筛选状态"), { target: { value: "all" } });
  await menu("停用");
  fireEvent.click(
    within(await view.findByRole("alertdialog")).getByRole("button", { name: "停用模型" }),
  );
  await view.findByRole("button", { name: "启用" });
  await menu("删除");
  dialog = await view.findByRole("alertdialog");
  assert.match(dialog.textContent!, /历史聊天、运行和用量记录会保留/);
  fireEvent.click(within(dialog).getByRole("button", { name: "永久删除模型" }));
  await view.findByText("还没有平台模型");
  assert.equal(view.queryByRole("button", { name: "编辑" }), null);
});

test("未配置服务时引导接入，添加模型只填模型名，问答失败后重试已保存版本", async () => {
  const data = structuredClone(snapshot);
  data.models = [];
  data.modelConnections = [];
  let submitted = 0,
    probes = 0;
  const transport = transportWith(async (method, path, body) => {
    if (path === "/api/admin/model-connections") {
      const connection = {
        ...body,
        id: "conn_fixture",
        gatewayProvider: "workers-ai",
        keyAlias: null,
        bindingVerified: true,
      };
      data.modelConnections!.push(connection);
      return connection;
    }
    if (path === "/api/admin/models") {
      submitted++;
      assert.equal(body.name, body.model);
      assert.equal(body.region, "inherit");
      data.models.push({
        ...body,
        id: "model_saved",
        version: 3,
        enabled: false,
        managementVersion: 1,
        capabilities: {
          tools: false,
          connection: false,
          structured: "none",
          vision: false,
          testedAt: null,
        },
      });
      return { id: "model_saved", version: 3 };
    }
    assert.equal(path, "/api/admin/models/model_saved/test?version=3");
    probes++;
    data.models[0].capabilities = {
      ...data.models[0].capabilities,
      connection: probes > 1,
      questionAnswered: probes > 1,
      tools: probes > 1,
      structured: probes > 1 ? "schema" : "none",
      testedAt: "2026-11-12",
    };
    return data.models[0].capabilities;
  });
  const refresh = async () =>
    view.rerender(
      <SettingsModels snapshot={{ ...data }} transport={transport} refresh={refresh} />,
    );
  const view = render(<SettingsModels snapshot={data} transport={transport} refresh={refresh} />);
  fireEvent.click(view.getByRole("button", { name: "添加模型" }));
  await view.findByText(/先添加一个服务/);
  fireEvent.click(view.getByRole("button", { name: "添加服务" }));
  fireEvent.keyDown(view.getByRole("combobox", { name: "服务提供方" }), { key: "ArrowDown" });
  fireEvent.keyDown(await view.findByRole("option", { name: "Workers AI" }), { key: "Enter" });
  fireEvent.click(view.getByRole("button", { name: "保存服务" }));
  fireEvent.click(await view.findByRole("button", { name: "继续添加模型" }));
  assert.equal(
    (view.getByLabelText("选择服务") as unknown as HTMLSelectElement).value,
    "conn_fixture",
  );
  fireEvent.change(view.getByLabelText("模型名"), { target: { value: "@cf/openai/example" } });
  fireEvent.click(view.getByRole("button", { name: "保存并测试" }));
  await view.findByText("测试失败");
  fireEvent.click(view.getByRole("button", { name: "重新测试" }));
  await view.findByText("测试通过，待启用");
  assert.equal(submitted, 1);
  assert.equal(probes, 2);
});
test("成员管理禁止停用自己，筛选后独立提交状态并按需读取使用量", async () => {
  const data = {
    users: [
      { id: "self", email: "admin@example.com", role: "admin", disabled: 0 },
      { id: "member", email: "member@example.com", role: "user", disabled: 0 },
    ],
    devices: [],
    runs: [],
    accounts: [],
    settings: { claimsEnabled: "0" },
  };
  const writes: unknown[] = [];
  let usages = 0;
  const transport = transportWith(async (method, path, body) => {
    if (path.endsWith("/usage")) {
      usages++;
      return { used: { runs: 2, chat: 3, models: 4 } };
    }
    if (method === "GET") return structuredClone(data);
    writes.push(body);
    data.users[1].disabled = Number(body.disabled);
    return { ok: true };
  });
  const view = render(<AdminPanel section="users" currentUserId="self" transport={transport} />);
  const self = await view.findByRole("button", { name: "当前用户" });
  assert.equal((self as HTMLButtonElement).disabled, true);
  assert.equal(usages, 0);
  fireEvent.change(view.getByLabelText("角色"), { target: { value: "user" } });
  assert.equal(view.queryByText("admin@example.com"), null);
  const usageToggle = view.getByRole("button", { name: "查看今日使用量" });
  assert.equal(usageToggle.getAttribute("aria-expanded"), "false");
  fireEvent.click(usageToggle);
  const usageText = await view.findByText("运行 2 · 对话 3 · 模型调用 4");
  assert.equal(usageToggle.getAttribute("aria-expanded"), "true");
  assert.ok(
    document.getElementById(usageToggle.getAttribute("aria-controls")!)?.contains(usageText),
  );
  assert.equal(usages, 1);
  fireEvent.click(view.getByRole("button", { name: "停用用户" }));
  let dialog = await view.findByRole("alertdialog");
  assert.match(dialog.textContent!, /退出该用户的登录会话，并请求停止/);
  fireEvent.click(within(dialog).getByRole("button", { name: "停用用户" }));
  await view.findByRole("button", { name: "恢复用户" });
  assert.deepEqual(writes, [{ disabled: true }]);
  fireEvent.change(view.getByLabelText("筛选状态"), { target: { value: "disabled" } });
  fireEvent.click(view.getByRole("button", { name: "恢复用户" }));
  dialog = await view.findByRole("alertdialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "恢复用户" }));
  await view.findByText("没有匹配的结果");
  assert.deepEqual(writes, [{ disabled: true }, { disabled: false }]);
  fireEvent.change(view.getByLabelText("筛选状态"), { target: { value: "all" } });
  fireEvent.change(view.getByLabelText("搜索用户邮箱"), { target: { value: "other" } });
  assert.ok(view.getByText("没有匹配的结果"));
});

test("设备管理只允许兼容设备迁移，要求停止确认，锁冲突保留草稿，吊销须确认", async () => {
  const data = {
    users: [],
    runs: [],
    settings: { claimsEnabled: "0" },
    devices: [
      {
        id: "ready",
        name: "新设备",
        last_seen: new Date().toISOString(),
        revoked: 0,
        protocol_version: PROTOCOL_VERSION,
        activeRunIds: ["run_active"],
      },
      {
        id: "old",
        name: "旧设备",
        last_seen: null,
        revoked: 0,
        protocol_version: PROTOCOL_VERSION - 1,
        activeRunIds: [],
      },
    ],
    accounts: [
      {
        id: "account",
        user_id: "member",
        name: "工作账号",
        origin: "https://example.com",
        assigned_device_id: "old",
        login_reset: 0,
      },
    ],
  };
  let locked = true;
  const writes: { path: string; body: unknown }[] = [];
  const transport = transportWith(async (method, path, body) => {
    if (method === "GET") return structuredClone(data);
    writes.push({ path, body });
    if (path.endsWith("/migrate")) {
      if (locked) throw Error("ACCOUNT_IN_USE");
      data.accounts[0].assigned_device_id = body.deviceId;
    } else data.devices[0].revoked = 1;
    return { ok: true };
  });
  const view = render(<AdminPanel section="devices" transport={transport} />);
  const select = await view.findByLabelText("优先设备");
  assert.ok(view.getByText("需要升级客户端"));
  assert.ok(view.getByText("run_active"));
  assert.equal(within(select).queryByRole("option", { name: "旧设备" }), null);
  fireEvent.change(select, { target: { value: "ready" } });
  const save = view.getByRole("button", { name: "设置优先设备" });
  assert.equal((save as HTMLButtonElement).disabled, true);
  fireEvent.click(view.getByLabelText("已确认旧设备停止该账号的执行"));
  fireEvent.click(save);
  await view.findByRole("alert");
  assert.equal((select as unknown as HTMLSelectElement).value, "ready");
  assert.equal(writes.length, 1);
  locked = false;
  fireEvent.click(save);
  await view.findByText("当前：新设备");
  assert.deepEqual(writes[1].body, { deviceId: "ready", oldExecutionStopped: true });
  await waitFor(() => assert.equal((select as unknown as HTMLSelectElement).value, ""));
  fireEvent.click(view.getAllByRole("button", { name: "吊销授权" })[0]);
  const dialog = await view.findByRole("alertdialog");
  assert.match(dialog.textContent!, /新设备/);
  fireEvent.click(within(dialog).getByRole("button", { name: "吊销授权" }));
  await view.findByText("已吊销");
  assert.equal(writes.at(-1)?.path, "/api/admin/devices/ready/revoke");
});

test("登录会话分别撤销指定及全部其他会话，当前会话始终保留", async (t) => {
  const at = new Date().toISOString();
  let sessions = ["self", "other", "third"].map((id) => ({
    id,
    token: id + "-token",
    userId: "user",
    userAgent: id,
    updatedAt: at,
    createdAt: at,
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
  }));
  const writes: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input);
    if (url.includes("list-sessions")) return Response.json(sessions);
    if (url.includes("get-session"))
      return Response.json({ session: sessions[0], user: { id: "user" } });
    writes.push(url);
    if (url.includes("revoke-session")) {
      assert.ok(typeof init?.body === "string");
      const body = JSON.parse(init.body);
      assert.equal(body.token, "other-token");
      sessions = sessions.filter((s) => s.id !== "other");
    } else if (url.includes("revoke-other-sessions"))
      sessions = sessions.filter((s) => s.id === "self");
    else throw Error("UNEXPECTED_AUTH_REQUEST");
    return Response.json({ status: true });
  });
  const view = render(
    <QueryBoundary owner="sessions-management">
      <AccountSecurity />
    </QueryBoundary>,
  );
  await view.findByText("当前会话");
  fireEvent.click(view.getAllByRole("button", { name: "退出会话" })[0]);
  let dialog = await view.findByRole("alertdialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "退出会话" }));
  await waitFor(() => assert.ok(!view.queryByText("other")));
  assert.ok(view.getByText("third"));
  fireEvent.click(view.getByRole("button", { name: "退出全部其他会话" }));
  dialog = await view.findByRole("alertdialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "退出其他会话" }));
  await waitFor(() => assert.ok(!view.queryByText("third")));
  assert.ok(view.getByText("当前会话"));
  assert.equal(writes.length, 2);
  assert.equal(
    (view.getByRole("button", { name: "退出全部其他会话" }) as HTMLButtonElement).disabled,
    true,
  );
});
