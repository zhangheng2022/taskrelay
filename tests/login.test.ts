import test from "node:test";
import assert from "node:assert/strict";
import type { App, LaunchItems, Settings } from "electron";
import { appUserModelId, loginSettings } from "../apps/desktop/src/main/login";

const launcher = "C:\\Users\\Test\\AppData\\Local\\TaskRelay\\TaskRelay.exe";
const item = (overrides: Partial<LaunchItems> = {}): LaunchItems => ({
  name: appUserModelId,
  path: launcher,
  args: [],
  scope: "user",
  enabled: true,
  ...overrides,
});
function fixture(
  items: LaunchItems[],
  legacy = { openAtLogin: false, executableWillLaunchAtLogin: false },
) {
  const writes: Settings[] = [],
    reads: unknown[] = [];
  let id = "legacy";
  const app = {
    getLoginItemSettings: (options?: { path?: string; args?: string[] }) => {
      reads.push(options);
      if (!options) return { ...legacy, launchItems: [] };
      assert.equal(id, appUserModelId);
      // Mirrors Electron's literal command mismatch despite a matching Windows path.
      return {
        openAtLogin: false,
        executableWillLaunchAtLogin: items.some((i) => i.enabled),
        launchItems: items,
      };
    },
    setAppUserModelId: (value: string) => {
      id = value;
    },
    setLoginItemSettings: (value: Settings) => {
      writes.push(value);
      if (value.name === appUserModelId)
        items = value.openAtLogin ? [item({ enabled: value.enabled ?? true })] : [];
    },
  } as Pick<App, "getLoginItemSettings" | "setLoginItemSettings" | "setAppUserModelId">;
  return { login: loginSettings(app, launcher.toLowerCase()), writes, reads };
}
test("正式登录设置：命令大小写不同仍识别本应用启用的稳定入口", () => {
  const s = fixture([item()]);
  assert.equal(s.login.enabled(), true);
  assert.deepEqual(s.writes, []);
  assert.deepEqual(s.reads.at(-1), { path: launcher.toLowerCase(), args: [] });
});
test("正式登录设置：保留系统禁用状态，不读取其他作用域、名称或参数的启动项", () => {
  for (const entry of [
    item({ enabled: false }),
    item({ scope: "machine" }),
    item({ name: "other" }),
    item({ args: ["--other"] }),
  ]) {
    const s = fixture([entry]);
    assert.equal(s.login.enabled(), false);
    assert.deepEqual(s.writes, []);
  }
});
test("正式登录设置：迁移旧入口保留启用/禁用，但不覆盖已有稳定入口", () => {
  for (const enabled of [true, false]) {
    const s = fixture([], { openAtLogin: true, executableWillLaunchAtLogin: enabled });
    assert.equal(s.login.enabled(), enabled);
    assert.deepEqual(s.writes, [
      { openAtLogin: false },
      { path: launcher.toLowerCase(), args: [], name: appUserModelId, openAtLogin: true, enabled },
    ]);
  }
  const existing = fixture([item({ enabled: false })], {
    openAtLogin: true,
    executableWillLaunchAtLogin: true,
  });
  assert.equal(existing.login.enabled(), false);
  assert.deepEqual(existing.writes, [{ openAtLogin: false }]);
});
test("正式登录设置：默认不注册，显式开关只修改本应用的稳定入口", () => {
  const s = fixture([]);
  assert.equal(s.login.enabled(), false);
  assert.equal(s.writes.length, 0);
  s.login.setEnabled(true);
  assert.equal(s.login.enabled(), true);
  s.login.setEnabled(false);
  assert.equal(s.login.enabled(), false);
  assert.deepEqual(
    s.writes.map((w) => ({ name: w.name, path: w.path, args: w.args })),
    Array(2).fill({ name: appUserModelId, path: launcher.toLowerCase(), args: [] }),
  );
});
