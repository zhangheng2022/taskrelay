import "./ui-dom";
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { ChatAttachments } from "../packages/ui/src/chat-attachments";
import { createWebTransport } from "../apps/web/src/transport";

afterEach(cleanup);

test("聊天图片直接加载同源地址，原生加载完成后才开放预览，失败不会回退到 JSON", () => {
  const transport = createWebTransport();
  transport.request = async () => {
    throw Error("图片不得经过 JSON 请求");
  };
  const view = render(
    <ChatAttachments
      transport={transport}
      parts={[{ type: "image", artifactId: "shot_one", alt: "执行截图" }]}
    />,
  );
  const thumbnail = view.getByRole("img", { name: "执行截图" });
  assert.equal(thumbnail.getAttribute("src"), "/api/user/artifacts/shot_one?variant=thumbnail");
  assert.equal(thumbnail.getAttribute("loading"), "lazy");
  assert.ok(view.getByRole("button", { name: "查看完整截图" }).hasAttribute("disabled"));
  assert.ok(view.getByRole("status"));
  fireEvent.load(thumbnail);
  assert.equal(view.queryByRole("status"), null);
  fireEvent.click(view.getByRole("button", { name: "查看完整截图" }));
  const dialog = within(view.getByRole("dialog"));
  const preview = dialog.getByRole("img", { name: "执行截图" });
  assert.equal(preview.getAttribute("src"), "/api/user/artifacts/shot_one");
  fireEvent.error(preview);
  assert.ok(dialog.getByText("图片加载失败或已不可用。"));
  // 大图另一次请求失败不能删除已经成功加载的聊天缩略图。
  assert.ok(thumbnail.isConnected);
});

test("图片失败不保留损坏图片，地址切换重置状态，旧图片事件不污染新图片", () => {
  const transport = createWebTransport();
  const parts = [{ type: "image" as const, artifactId: "old", alt: "执行截图" }];
  const view = render(<ChatAttachments transport={transport} parts={parts} />);
  const old = view.getByRole("img");
  fireEvent.error(old);
  assert.equal(view.queryByRole("img"), null);
  assert.ok(view.getByText("图片加载失败或已不可用。"));
  fireEvent.click(view.getByRole("button", { name: "重新加载图片" }));
  assert.ok(view.getByRole("img"));
  assert.ok(view.getByRole("status"));
  view.rerender(
    <ChatAttachments transport={transport} parts={[{ ...parts[0], artifactId: "new" }]} />,
  );
  const current = view.getByRole("img");
  fireEvent.load(old);
  assert.ok(view.getByRole("status"));
  fireEvent.load(current);
  assert.equal(view.queryByRole("status"), null);
  transport.artifactUrl = () => "/different-host-adapter/image";
  view.rerender(
    <ChatAttachments transport={transport} parts={[{ ...parts[0], artifactId: "new" }]} />,
  );
  assert.ok(view.getByRole("status"));
  assert.equal(view.getByRole("img").getAttribute("src"), "/different-host-adapter/image");
});
