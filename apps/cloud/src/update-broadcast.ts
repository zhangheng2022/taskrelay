import type { AppEnv } from "./env";
import type { DesktopRelease } from "../../../packages/contracts/src/updates";

type Pending = { revision: string; cursor: string };
/** 更新目录是权威；只广播已激活版本。DO 保存分页游标与看门狗，故障允许重复通知，
 * 不把所有设备装入内存，也不依赖发布脚本一直在线。客户端自行重新读取清单。 */
export class UpdateBroadcast {
  constructor(
    private storage: DurableObjectStorage,
    private env: Pick<AppEnv, "DB" | "NOTIFICATIONS">,
  ) {}
  async observe(release: DesktopRelease | null) {
    const revision = release ? `${release.version}:${release.sha256}` : "none";
    await this.storage.transaction(async (tx) => {
      if ((await tx.get<string>("updateRevision")) === revision) return;
      await tx.put("updateRevision", revision);
      if (release) {
        await tx.put("updatePending", { revision, cursor: "" } satisfies Pending);
        await tx.setAlarm(Date.now() + 1);
      } else await tx.delete("updatePending");
    });
  }
  async alarm() {
    const pending = await this.storage.transaction(async (tx) => {
      const value = await tx.get<Pending>("updatePending");
      // 与读取原子提交，避免旧批次的看门狗覆盖新版本的立即唤醒。
      if (value) await tx.setAlarm(Date.now() + 60_000);
      return value;
    });
    if (!pending) return;
    // 一批失败时保留游标，重复投递由客户端合并。新版本可替换旧待通知批次。
    const devices = await this.env.DB.prepare(
      "SELECT id FROM devices WHERE revoked=0 AND id>? ORDER BY id LIMIT 20",
    )
      .bind(pending.cursor)
      .all<{ id: string }>();
    await Promise.all(
      devices.results.map(({ id }) =>
        this.env.NOTIFICATIONS.getByName("device:" + id).publish({
          type: "update.available",
          version: 1,
        }),
      ),
    );
    await this.storage.transaction(async (tx) => {
      const current = await tx.get<Pending>("updatePending");
      if (current?.revision !== pending.revision || current.cursor !== pending.cursor) return;
      if (devices.results.length < 20) await tx.delete("updatePending");
      else {
        await tx.put("updatePending", { ...pending, cursor: devices.results.at(-1)!.id });
        await tx.setAlarm(Date.now() + 1);
      }
    });
  }
}
