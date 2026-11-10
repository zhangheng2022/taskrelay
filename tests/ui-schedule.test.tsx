import "./ui-dom";
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { ScheduleCard } from "../packages/ui/src/schedule-card";
import { QueryBoundary } from "../packages/ui/src/queries";
import { transportWith } from "./ui-fixtures";
import type { ScheduleCard as Card } from "../packages/contracts/src/task-schedule";
afterEach(cleanup);
test("需求明确后才显示入口，预览后启用；频率没有工作日，暂停独立于当前运行", async () => {
  let card: Card = {
    version: 1,
    taskVersion: 1,
    summary: "每天检查订单",
    ready: true,
    state: "off",
    frequency: null,
    legacy: null,
    nextRunAt: null,
  };
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  const transport = transportWith(async (method, path, body) => {
    if (method === "GET") return { card, learning: [] };
    writes.push({ path, body });
    if (path.endsWith("/preview")) return { times: ["2026-11-12T01:00:00.000Z"] };
    card = {
      ...card,
      version: card.version + 1,
      state: body.enabled ? "enabled" : "paused",
      frequency: body.frequency ?? card.frequency,
    };
    return { card };
  });
  const view = render(
    <QueryBoundary owner={transport}>
      <ScheduleCard transport={transport} taskId="task_test" offline={false} />
    </QueryBoundary>,
  );
  fireEvent.click(await view.findByRole("button", { name: "定时任务：未开启" }));
  assert.equal(view.queryByText("工作日"), null);
  assert.equal(
    (view.getByRole("button", { name: "保存并启用" }) as HTMLButtonElement).disabled,
    true,
  );
  fireEvent.click(view.getByRole("button", { name: "预览执行时间" }));
  await waitFor(() =>
    assert.equal(
      (view.getByRole("button", { name: "保存并启用" }) as HTMLButtonElement).disabled,
      false,
    ),
  );
  fireEvent.click(view.getByRole("button", { name: "保存并启用" }));
  await view.findByText("已保存并启用");
  fireEvent.click(view.getByRole("button", { name: "暂停定时" }));
  await view.findByText("已暂停，当前运行不受影响");
  assert.equal(writes.filter((w) => w.path.endsWith("/cancel")).length, 0);
  assert.equal(writes.at(-1)!.body.enabled, false);
});
test("未确认不出现卡片", async () => {
  const transport = transportWith(async () => ({ card: null, learning: [] }));
  const view = render(
    <QueryBoundary owner={transport}>
      <ScheduleCard transport={transport} taskId="none" offline />
    </QueryBoundary>,
  );
  await waitFor(() => assert.equal(view.queryByRole("button"), null));
});
test("保存失败重试复用身份，重新打开恢复服务端配置，离线不能预览或保存", async () => {
  let card: Card = {
    version: 1,
    taskVersion: 1,
    summary: "读取订单",
    ready: true,
    state: "off",
    frequency: null,
    legacy: null,
    nextRunAt: null,
  };
  const writes: Record<string, unknown>[] = [];
  const transport = transportWith(async (method, path, body) => {
    if (method === "GET") return { card, learning: [] };
    if (path.endsWith("/preview")) return { times: ["2026-11-12T01:00:00.000Z"] };
    writes.push(body);
    if (writes.length === 1) throw Error("OFFLINE");
    card = { ...card, version: 2, state: "enabled", frequency: body.frequency };
    return { card };
  });
  const screen = (offline = false) => (
    <QueryBoundary owner={transport}>
      <ScheduleCard transport={transport} taskId="retry_task" offline={offline} />
    </QueryBoundary>
  );
  const view = render(screen());
  fireEvent.click(await view.findByRole("button", { name: "定时任务：未开启" }));
  fireEvent.click(view.getByRole("button", { name: "预览执行时间" }));
  await waitFor(() =>
    assert.equal(
      (view.getByRole("button", { name: "保存并启用" }) as HTMLButtonElement).disabled,
      false,
    ),
  );
  fireEvent.click(view.getByRole("button", { name: "保存并启用" }));
  await waitFor(() => assert.equal(writes.length, 1));
  await waitFor(() =>
    assert.equal(
      (view.getByRole("button", { name: "保存并启用" }) as HTMLButtonElement).disabled,
      false,
    ),
  );
  fireEvent.click(view.getByRole("button", { name: "保存并启用" }));
  await view.findByText("已保存并启用");
  assert.equal(writes[0].requestId, writes[1].requestId);
  fireEvent.keyDown(view.getByRole("dialog"), { key: "Escape" });
  await waitFor(() => assert.equal(view.queryByRole("dialog"), null));
  fireEvent.click(view.getByRole("button", { name: "定时任务：已开启" }));
  assert.equal((view.getByLabelText("执行频率") as unknown as HTMLSelectElement).value, "daily");
  view.rerender(screen(true));
  assert.equal(
    (view.getByRole("button", { name: "保存并启用" }) as HTMLButtonElement).disabled,
    true,
  );
  assert.equal(
    (view.getByRole("button", { name: "预览执行时间" }) as HTMLButtonElement).disabled,
    true,
  );
});
