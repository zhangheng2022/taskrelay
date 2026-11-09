import "./ui-dom";
import { afterEach, test, mock } from "node:test";
import assert from "node:assert/strict";
import { cleanup, fireEvent, render, within, waitFor, act } from "@testing-library/react";
import { ChatAttachments } from "../packages/ui/src/chat-attachments";
import { createWebTransport } from "../apps/web/src/transport";

const parts = (id = "one") => [{ type: "image" as const, artifactId: id, alt: "执行截图" }];
const response = () =>
  new Response(new Uint8Array([1, 2]), { headers: { "Content-Type": "image/png" } });
afterEach(() => {
  cleanup();
  mock.restoreAll();
});

function blobs() {
  let count = 0;
  const created = mock.method(URL, "createObjectURL", () => `blob:test-${++count}`);
  const revoked = mock.method(URL, "revokeObjectURL", () => {});
  return { created, revoked };
}

test("缩略图显示骨架和转圈；原图请求与解码分别控制 Loading，重复预览只请求一次", async () => {
  const { revoked } = blobs();
  const fetcher = mock.method(globalThis, "fetch", async () => response());
  const transport = createWebTransport();
  transport.request = async () => {
    throw Error("图片不得经过 JSON 请求");
  };
  const view = render(<ChatAttachments transport={transport} parts={parts()} />);
  const thumbnail = view.getByRole("img");
  assert.equal(thumbnail.getAttribute("src"), "/api/user/artifacts/one?variant=thumbnail");
  assert.equal(thumbnail.getAttribute("loading"), "lazy");
  assert.ok(view.container.querySelector('[data-slot="skeleton"]'));
  assert.ok(view.container.querySelector('[data-slot="spinner"]'));
  assert.equal(fetcher.mock.callCount(), 0);
  fireEvent.load(thumbnail);
  assert.equal(view.queryByRole("status"), null);
  const trigger = view.getByRole("button", { name: "查看完整截图" });
  fireEvent.click(trigger);
  const dialog = within(view.getByRole("dialog"));
  assert.ok(dialog.getByText("正在加载原图…"));
  const original = await dialog.findByRole("img", { name: "执行截图" });
  assert.equal(original.getAttribute("src"), "blob:test-1");
  assert.ok(dialog.getByRole("status"));
  assert.equal(fetcher.mock.calls[0].arguments[0], "/api/user/artifacts/one");
  assert.equal(fetcher.mock.calls[0].arguments[1]?.credentials, "same-origin");
  fireEvent.load(original);
  assert.equal(dialog.queryByRole("status"), null);
  fireEvent.click(dialog.getByRole("button", { name: "关闭" }));
  fireEvent.click(trigger);
  assert.ok(await view.findByRole("dialog"));
  assert.equal(fetcher.mock.callCount(), 1);
  view.unmount();
  assert.equal(revoked.mock.callCount(), 1);
});

test("缩略图失败仍可查看原图，两种重试独立且加载中不丢失占位", async () => {
  blobs();
  const fetcher = mock.method(globalThis, "fetch", async () => response());
  const view = render(<ChatAttachments transport={createWebTransport()} parts={parts()} />);
  fireEvent.error(view.getByRole("img"));
  assert.equal(view.queryByRole("img"), null);
  assert.ok(view.getByText("缩略图不可用，点击查看原图"));
  fireEvent.click(view.getByRole("button", { name: "查看完整截图" }));
  const dialog = within(view.getByRole("dialog"));
  fireEvent.error(await dialog.findByRole("img", { name: "执行截图" }));
  assert.ok(dialog.getByRole("alert"));
  assert.equal(dialog.queryByRole("status"), null);
  fireEvent.click(dialog.getByRole("button", { name: "重新加载原图" }));
  assert.ok(dialog.getByRole("status"));
  await waitFor(() => assert.equal(fetcher.mock.callCount(), 2));
  fireEvent.load(await dialog.findByRole("img", { name: "执行截图" }));
  fireEvent.click(dialog.getByRole("button", { name: "关闭" }));
  fireEvent.click(view.getByRole("button", { name: "重新加载图片" }));
  assert.ok(view.getByRole("status"));
  fireEvent.load(view.getByRole("img"));
  assert.equal(view.queryByRole("status"), null);
});

test("图片切换和移除中止旧原图，迟到响应和旧缩略图事件不能污染新图片", async () => {
  const { created } = blobs();
  let finish!: (value: Response) => void;
  let signal: AbortSignal | undefined;
  mock.method(globalThis, "fetch", (_url: string | URL | Request, options?: RequestInit) => {
    signal = options?.signal as AbortSignal;
    return new Promise<Response>((resolve) => {
      finish = resolve;
    });
  });
  const transport = createWebTransport();
  const view = render(<ChatAttachments transport={transport} parts={parts()} />);
  const old = view.getByRole("img");
  fireEvent.click(view.getByRole("button", { name: "查看完整截图" }));
  view.rerender(<ChatAttachments transport={transport} parts={parts("new")} />);
  assert.ok(signal?.aborted);
  await act(async () => {
    finish(response());
  });
  assert.equal(created.mock.callCount(), 0);
  assert.equal(view.queryByRole("dialog"), null);
  fireEvent.load(old);
  assert.ok(view.getByRole("status"));
  fireEvent.load(view.getByRole("img"));
  assert.equal(view.queryByRole("status"), null);
  transport.artifactUrl = () => "/new-host/image";
  view.rerender(<ChatAttachments transport={transport} parts={parts("new")} />);
  assert.ok(view.getByRole("status"));
  view.rerender(<ChatAttachments transport={transport} parts={[]} />);
  assert.equal(view.queryByRole("img"), null);
});

test("拒绝失效登录、删除图片、非图片响应及网络错误，失败后可再次请求", async () => {
  blobs();
  const replies = [
    new Response(null, { status: 401 }),
    new Response(null, { status: 404 }),
    new Response("html"),
    Error("offline"),
    response(),
  ];
  const fetcher = mock.method(globalThis, "fetch", async () => {
    const reply = replies.shift()!;
    if (reply instanceof Error) throw reply;
    return reply;
  });
  const view = render(<ChatAttachments transport={createWebTransport()} parts={parts()} />);
  fireEvent.click(view.getByRole("button", { name: "查看完整截图" }));
  const dialog = within(view.getByRole("dialog"));
  for (let i = 0; i < 4; i++) {
    assert.ok(await dialog.findByRole("alert"));
    fireEvent.click(dialog.getByRole("button", { name: "重新加载原图" }));
  }
  fireEvent.load(await dialog.findByRole("img", { name: "执行截图" }));
  assert.equal(fetcher.mock.callCount(), 5);
  assert.equal(dialog.queryByRole("status"), null);
});

test("没有图片地址时不请求图片并保留不可用提示", () => {
  const transport = createWebTransport();
  delete transport.artifactUrl;
  const view = render(<ChatAttachments transport={transport} parts={parts()} />);
  assert.ok(view.getByRole("button", { name: "查看完整截图" }).hasAttribute("disabled"));
  assert.equal(view.queryByRole("status"), null);
});
