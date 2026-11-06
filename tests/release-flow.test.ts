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
    compatibleDevice: async () => true,
    restore: async (_record, ready) => {
      calls.push(`restore:${ready}`);
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
      "restore:true",
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
    throw Error("lost response");
  };
  await assert.rejects(runRelease(s.io, s.state()));
  s.io.deployed = async () => false;
  await assert.rejects(runRelease(s.io, s.state()), /UNCONFIRMED/);
  assert.equal(s.state().phase, "deploying");
  const h = fixture();
  h.io.verifyDownload = async () => {
    throw Error("hash mismatch");
  };
  await assert.rejects(runRelease(h.io, h.state()));
  assert.equal(h.calls.includes("activate"), false);
  assert.equal(h.calls.includes("restore:true"), false);
});
test("没有兼容设备时网页恢复但领取保持暂停，恢复入口不再次迁移或发布", async () => {
  const s = fixture();
  s.io.compatibleDevice = async () => false;
  await runRelease(s.io, s.state());
  assert.equal(s.state().phase, "awaiting-device");
  s.io.compatibleDevice = async () => true;
  await runRelease(s.io, s.state());
  assert.equal(s.calls.filter((v) => v === "publish").length, 1);
  assert.equal(s.calls.filter((v) => v === "migrate").length, 1);
  assert.equal(s.state().phase, "complete");
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
