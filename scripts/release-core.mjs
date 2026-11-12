/** 发布状态机：所有外部写入之前持久化阶段，失败保持领取暂停。恢复核对已发生的结果，不重放任务或回滚数据库。 */
export const phases = [
  "prepared",
  "paused",
  "drained",
  "migrating",
  "migrated",
  "deploying",
  "deployed",
  "publishing",
  "published",
  "registered",
  "download-verified",
  "activated",
  "awaiting-device", // 只兼容旧记录；新发布不再进入设备等待阶段。
  "complete",
];

export async function runRelease(io, record) {
  let state = record;
  const reached = (phase) => phases.indexOf(state.phase) >= phases.indexOf(phase);
  const save = async (phase, values = {}) => {
    state = await io.save(state, { ...state, ...values, phase });
  };
  if (!phases.includes(state.phase)) throw Error("RELEASE_PHASE_INVALID");
  if (state.phase === "complete") throw Error("RELEASE_ALREADY_COMPLETE");
  await io.assertOwnership(state);
  // 重跑恢复也先核对领取暂停。原开关只在初次建记录时保存，不从失败现场重新取值。
  await io.pause(state);
  if (!reached("paused")) await save("paused");
  if (!reached("drained")) {
    await io.drain(state);
    await save("drained");
  }
  if (!reached("migrated")) {
    if (!reached("migrating")) await save("migrating", { bookmark: await io.bookmark() });
    await io.migrate(state); // Wrangler 按 d1_migrations 跳过已提交迁移；部分失败只在显式恢复时继续。
    await io.assertQuiescent(state);
    await save("migrated");
  }
  if (!reached("deployed")) {
    const wasPending = state.phase === "deploying";
    if (!wasPending) await save("deploying");
    if (state.cloud) {
      if (wasPending) {
        // 上传结果未知时只读 health；不能无条件再次部署。
        if (!(await io.deployed(state))) throw Error("DEPLOYMENT_OUTCOME_UNCONFIRMED");
      } else {
        // Wrangler 成功返回即继续；刚部署时 health 可能仍命中旧版本，不再作为发布门槛。
        await io.deploy(state);
      }
    }
    await save("deployed");
  }
  if (!reached("published")) {
    if (!reached("publishing")) await save("publishing");
    if (state.desktop) await io.publish(state); // 已公开版本必须逐个校验哈希，绝不覆盖。
    await save("published");
  }
  if (!reached("registered")) {
    if (state.desktop) await io.register(state);
    await save("registered");
  }
  if (!reached("download-verified")) {
    if (state.desktop) await io.verifyDownload(state);
    await save("download-verified");
  }
  if (!reached("activated")) {
    if (state.desktop) await io.activate(state);
    await save("activated");
  }
  await io.assertQuiescent(state);
  // 发布完成不依赖设备在线；实际领取仍由调度器核对设备授权、协议与就绪状态。
  // 恢复原开关而非强制开启，兼容旧 awaiting-device 记录且不重放前面的发布步骤。
  await io.restore(state);
  await save("complete");
  return state;
}

export { releaseImpact as releaseScope } from "./workflow-policy.mjs";

export function assertNewDesktopVersion(current, published) {
  const version = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
  if (!version.test(current) || !version.test(published)) throw Error("DESKTOP_VERSION_INVALID");
  const next = current.split(".").map(Number);
  const previous = published.split(".").map(Number);
  const part = next.findIndex((value, index) => value !== previous[index]);
  if (part < 0 || next[part] < previous[part]) throw Error("DESKTOP_VERSION_NOT_INCREMENTED");
}
