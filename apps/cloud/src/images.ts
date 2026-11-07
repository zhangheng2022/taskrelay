import { Buffer } from "node:buffer";
import type { AppEnv } from "./env";
import type { TaskRun } from "../../../packages/contracts/src/index";
import { imageLimits, type ImagePurpose } from "../../../packages/contracts/src/images";
import { putEvidence, getEvidence, deleteEvidence } from "./evidence";
import { now, type Row } from "./store";
import { validateSnapshotPng } from "./png";

/** 图片的上传发布、归属校验与模型引用读取；缩略图与原图在同一 Evidence 对象中原子保存。
 * 临时视觉图片不进入聊天；只有美国模型出站在调用提供方前把引用展开为 Data URL。 */
export async function saveSnapshot(
  env: AppEnv,
  run: TaskRun,
  threadId: string,
  input: { captureId: string; purpose: ImagePurpose; image: Uint8Array; thumbnail?: Uint8Array },
) {
  await validateSnapshotPng(input.image);
  if (input.thumbnail) {
    const size = await validateSnapshotPng(input.thumbnail, imageLimits.thumbnailBytes);
    if (size.width > imageLimits.thumbnailWidth || size.height > imageLimits.thumbnailHeight)
      throw Error("IMAGE_THUMBNAIL_INVALID");
  }
  const digest = Buffer.from(
    await crypto.subtle.digest("SHA-256", new Uint8Array(input.image)),
  ).toString("hex");
  const id = `${input.purpose === "chat" ? "snapshot" : "vision"}_${input.captureId}`;
  const prior = await env.DB.prepare("SELECT * FROM artifacts WHERE id=?").bind(id).first<Row>();
  const matches = (row: Row) =>
    row.run_id === run.id &&
    row.thread_id === threadId &&
    row.purpose === input.purpose &&
    (row.lease_epoch === null || row.lease_epoch === run.leaseEpoch) &&
    (!row.digest || row.digest === digest);
  if (prior) {
    if (!matches(prior)) throw Error("ARTIFACT_CONFLICT");
    if (prior.expires_at <= now()) throw Error("ARTIFACT_EXPIRED");
    return { id, expiresAt: String(prior.expires_at) };
  }
  const persistent = input.purpose === "chat";
  const expiresAt = persistent
    ? "9999-12-31T23:59:59.999Z"
    : new Date(Date.now() + imageLimits.visionTtlMs).toISOString();
  const key = `${input.purpose}/${threadId}/${id}/${crypto.randomUUID()}`;
  await putEvidence(
    env,
    key,
    new Uint8Array(input.image).buffer,
    persistent ? null : expiresAt,
    persistent,
    input.thumbnail ? new Uint8Array(input.thumbnail).buffer : undefined,
  );
  // 发布失败只清理本请求独占对象；提交结果未知时交给 alarm，不能误删已发布图片。
  const saved = await env.DB.prepare(
    `INSERT OR IGNORE INTO artifacts(id,run_id,object_key,content_type,expires_at,thread_id,persistent,purpose,lease_epoch,digest)
    SELECT ?,?,?,'image/png',?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM ai_threads WHERE id=? AND closed=0)
    AND NOT EXISTS(SELECT 1 FROM evidence_retirements WHERE object_key=?)
    AND EXISTS(SELECT 1 FROM runs WHERE id=? AND device_id=? AND lease_epoch=? AND lease_expires_at>? AND cancel_requested=0 AND history_deleted=0 AND context_withdrawn=0 AND status IN ('running','waiting_user','verifying'))`,
  )
    .bind(
      id,
      run.id,
      key,
      expiresAt,
      threadId,
      persistent ? 1 : 0,
      input.purpose,
      run.leaseEpoch,
      digest,
      threadId,
      key,
      run.id,
      run.deviceId,
      run.leaseEpoch,
      now(),
    )
    .run();
  if (!saved.meta.changes) {
    const winner = await env.DB.prepare("SELECT * FROM artifacts WHERE id=?").bind(id).first<Row>();
    if (winner?.object_key !== key) await deleteEvidence(env, key);
    if (winner && matches(winner) && winner.expires_at > now())
      return { id, expiresAt: String(winner.expires_at) };
    throw Error(winner ? "ARTIFACT_CONFLICT" : "THREAD_NOT_FOUND");
  }
  return { id, expiresAt };
}

export async function imageReference(
  env: AppEnv,
  artifactId: string,
  runId: string,
  userId: string,
  epoch: number,
) {
  const row = await env.DB.prepare(
    `SELECT a.object_key FROM artifacts a JOIN runs r ON r.id=a.run_id
    JOIN ai_threads t ON t.id=a.thread_id AND t.id=r.thread_id AND t.user_id=r.user_id
    WHERE a.id=? AND r.id=? AND r.user_id=? AND a.lease_epoch=? AND r.lease_epoch=?
    AND a.expires_at>? AND r.lease_expires_at>? AND t.closed=0 AND r.history_deleted=0
    AND r.context_withdrawn=0 AND r.cancel_requested=0 AND r.status IN ('running','waiting_user','verifying')`,
  )
    .bind(artifactId, runId, userId, epoch, epoch, now(), now())
    .first<{ object_key: string }>();
  if (!row) throw Error("IMAGE_REFERENCE_INVALID");
  return row;
}

export async function resolveModelImage(
  env: AppEnv,
  ref: { artifactId: string; epoch: number },
  runId: string | null,
  userId: string,
) {
  if (!runId) throw Error("IMAGE_REFERENCE_INVALID");
  const row = await imageReference(env, ref.artifactId, runId, userId, ref.epoch);
  const bytes = await getEvidence(env, row.object_key);
  if (!bytes) throw Error("ARTIFACT_EXPIRED");
  await imageReference(env, ref.artifactId, runId, userId, ref.epoch);
  return `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`;
}
