import test from "node:test";
import assert from "node:assert/strict";
import {
  runRelease,
  releaseScope,
  assertNewDesktopVersion,
  type ReleaseIO,
  type ReleaseRecord,
} from "../scripts/release-core.mjs";
function fixture() {
  const calls: string[] = [];
  let state: ReleaseRecord = { phase: "prepared", cloud: true, desktop: true };
  const io: ReleaseIO = {
    save: async (_old, next) => {
      calls.push(`save:${next.phase}`);
      state = next;
      return next;
    },
    assertOwnership: async () => {
      calls.push("ownership");
    },
    pause: async () => {
      calls.push("pause");
    },
    drain: async () => {
      calls.push("drain");
    },
    bookmark: async () => {
      calls.push("bookmark");
      return "original-backup";
    },
    migrate: async () => {
      calls.push("migrate");
    },
    assertQuiescent: async () => {
      calls.push("quiescent");
    },
    deploy: async () => {
      calls.push("deploy");
    },
    deployed: async () => true,
    publish: async () => {
      calls.push("publish");
    },
    register: async () => {
      calls.push("register");
    },
    verifyDownload: async () => {
      calls.push("verifyDownload");
    },
    activate: async () => {
      calls.push("activate");
    },
    restore: async () => {
      calls.push("restore");
    },
  };
  return { io, calls, state: () => state };
}

test("桌面版本必须递增，不能以旧版本绕过公开版本保护", () => {
  assertNewDesktopVersion("0.17.1", "0.17.0");
  assertNewDesktopVersion("1.0.0", "0.99.9");
  for (const version of ["0.17.0", "0.16.9", "invalid"]) {
    assert.throws(() => assertNewDesktopVersion(version, "0.17.0"));
  }
});
test("发布按排空、备份、迁移、部署、公开、下载验证、启用的顺序运行", async () => {
  const s = fixture();
  s.io.deployed = async () => {
    throw Error("新部署成功后不应读取尚未传播的 health");
  };
  const result = await runRelease(s.io, s.state());
  assert.equal(result.phase, "complete");
  assert.deepEqual(
    s.calls.filter((name) => !name.startsWith("save:") && name !== "quiescent"),
    [
      "ownership",
      "pause",
      "drain",
      "bookmark",
      "migrate",
      "deploy",
      "publish",
      "register",
      "verifyDownload",
      "activate",
      "restore",
    ],
  );
  await assert.rejects(runRelease(s.io, result), /ALREADY_COMPLETE/);
});
test("中途失败不恢复领取；部分迁移显式恢复复用原备份", async () => {
  const s = fixture();
  s.io.migrate = async () => {
    throw Error("partial migration");
  };
  await assert.rejects(runRelease(s.io, s.state()));
  assert.equal(s.state().phase, "migrating");
  assert.equal(
    s.calls.some((v) => v.startsWith("restore")),
    false,
  );
  s.io.migrate = async () => {
    s.calls.push("migrate-resume");
  };
  await runRelease(s.io, s.state());
  assert.equal(s.calls.filter((v) => v === "bookmark").length, 1);
});
test("部署未知仅核验，不重发；错误下载哈希不切换通道", async () => {
  const s = fixture();
  s.io.deploy = async () => {
    s.calls.push("deploy");
    throw Error("lost response");
  };
  await assert.rejects(runRelease(s.io, s.state()));
  s.io.deployed = async () => false;
  await assert.rejects(runRelease(s.io, s.state()), /UNCONFIRMED/);
  assert.equal(s.state().phase, "deploying");
  assert.equal(s.calls.includes("publish"), false);
  assert.equal(s.calls.includes("restore"), false);
  let confirmations = 0;
  s.io.deployed = async () => {
    confirmations++;
    return true;
  };
  assert.equal((await runRelease(s.io, s.state())).phase, "complete");
  assert.equal(confirmations, 1);
  assert.equal(s.calls.filter((name) => name === "deploy").length, 1);
  const h = fixture();
  h.io.verifyDownload = async () => {
    throw Error("hash mismatch");
  };
  await assert.rejects(runRelease(h.io, h.state()));
  assert.equal(h.calls.includes("activate"), false);
  assert.equal(h.calls.includes("restore"), false);
});
test("旧等待设备记录直接恢复原开关，不再次迁移、部署或发布", async () => {
  const s = fixture();
  const result = await runRelease(s.io, { ...s.state(), phase: "awaiting-device" });
  assert.equal(result.phase, "complete");
  assert.deepEqual(s.calls, ["ownership", "pause", "quiescent", "restore", "save:complete"]);
});
test("排空失败、并发所有权冲突及遗漏范围均阻止后续操作", async () => {
  const s = fixture();
  s.io.drain = async () => {
    throw Error("unknown result");
  };
  await assert.rejects(runRelease(s.io, s.state()));
  assert.equal(s.calls.includes("migrate"), false);
  const conflict = fixture();
  conflict.io.assertOwnership = async () => {
    throw Error("owned");
  };
  await assert.rejects(runRelease(conflict.io, conflict.state()));
  assert.equal(conflict.calls.includes("pause"), false);
  assert.throws(() => releaseScope(["packages/contracts/src/index.ts"], "cloud"));
  assert.deepEqual(releaseScope(["apps/web/src/app.tsx"]), { cloud: true, desktop: false });
  assert.deepEqual(releaseScope(["apps/desktop/src/main/index.ts"]), {
    cloud: false,
    desktop: true,
  });
});
