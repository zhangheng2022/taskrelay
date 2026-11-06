import { dom } from "./ui-dom";
import { StrictMode } from "react";
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { render, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { PairingNotice } from "../packages/ui/src/pairing-notice";
import { transportWith } from "./ui-fixtures";

afterEach(() => {
  cleanup();
  dom.window.history.replaceState(null, "", "/");
});
const code = "68170779B4C6";
const lookup = `/api/admin/pairings/${code}`;
const pairing = { name: "验收设备", code, approved: false };
function link() {
  dom.window.history.replaceState({ retained: true }, "", `/?view=tasks&pair=${code}#task-example`);
}

test("expired pairing is dismissible, preserves task navigation, and is not queried after remount", async () => {
  link();
  let requests = 0;
  const transport = transportWith(async (method, path) => {
    assert.equal(method, "GET");
    assert.equal(path, lookup);
    requests++;
    throw new Error("PAIRING_EXPIRED");
  });
  const view = render(
    <StrictMode>
      <PairingNotice transport={transport} refresh={async () => {}} />
    </StrictMode>,
  );
  await view.findByText(/设备配对链接已过期/);
  assert.equal(dom.window.location.search, "?view=tasks");
  assert.equal(dom.window.location.hash, "#task-example");
  assert.deepEqual(dom.window.history.state, { retained: true });
  fireEvent.click(view.getByRole("button", { name: "关闭配对提示" }));
  assert.equal(view.queryByRole("region", { name: "设备配对" }), null);
  view.unmount();
  const count = requests;
  const reopened = render(<PairingNotice transport={transport} refresh={async () => {}} />);
  assert.equal(reopened.queryByRole("region"), null);
  assert.equal(requests, count);
});

test("pending pairing only approves on explicit click and removes the link after success", async () => {
  link();
  const writes: string[] = [];
  let refreshes = 0;
  const transport = transportWith(async (method, path) => {
    if (method === "POST") {
      writes.push(path);
      return { ok: true };
    }
    return pairing;
  });
  const view = render(
    <PairingNotice
      transport={transport}
      refresh={async () => {
        refreshes++;
      }}
    />,
  );
  await view.findByText("授权连接这台设备");
  assert.ok(dom.window.location.search.includes("pair="));
  assert.deepEqual(writes, []);
  fireEvent.click(view.getByRole("button", { name: "授权设备" }));
  await view.findByText("设备已授权");
  assert.deepEqual(writes, [`${lookup}/approve`]);
  assert.equal(refreshes, 1);
  assert.equal(dom.window.location.search, "?view=tasks");
  assert.equal(view.queryByRole("button", { name: "授权设备" }), null);
});

test("previously approved pairing clears the stale link without approving again", async () => {
  link();
  const transport = transportWith(async (method) => {
    assert.equal(method, "GET");
    return { ...pairing, approved: true };
  });
  const view = render(<PairingNotice transport={transport} refresh={async () => {}} />);
  await view.findByText("设备已授权");
  assert.equal(dom.window.location.search, "?view=tasks");
  assert.equal(view.queryByRole("button", { name: "授权设备" }), null);
});

test("expiry during approval removes the obsolete card and link", async () => {
  link();
  const transport = transportWith(async (method) => {
    if (method === "POST") throw new Error("PAIRING_EXPIRED");
    return pairing;
  });
  const view = render(<PairingNotice transport={transport} refresh={async () => {}} />);
  fireEvent.click(await view.findByRole("button", { name: "授权设备" }));
  await view.findByText(/设备配对链接已过期/);
  assert.equal(view.queryByRole("button", { name: "授权设备" }), null);
  assert.equal(dom.window.location.search, "?view=tasks");
});

test("temporary lookup failure keeps the link for reload; dismissal clears it", async () => {
  link();
  const transport = transportWith(async () => {
    throw new Error("OFFLINE");
  });
  const view = render(<PairingNotice transport={transport} refresh={async () => {}} />);
  await waitFor(() => assert.ok(view.getByRole("alert")));
  assert.ok(dom.window.location.search.includes("pair="));
  fireEvent.click(view.getByRole("button", { name: "关闭配对提示" }));
  assert.equal(dom.window.location.search, "?view=tasks");
});
