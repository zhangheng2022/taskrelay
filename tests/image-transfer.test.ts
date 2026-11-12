import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";
import sharp from "sharp";
import { build } from "esbuild";
import { fixturePng } from "./image-fixture";
import { productionModelFixture } from "./production-model-fixture";
import { app, maintenance } from "../apps/cloud/src/index";
import { imageLimits } from "../packages/contracts/src/images";
import { prepareSnapshot } from "../apps/desktop/src/executor/snapshots";
import { imageUploader } from "../apps/desktop/src/executor/image-upload";
import { chatSnapshots } from "../apps/desktop/src/executor/chat-snapshots";
import { unseal } from "../apps/cloud/src/crypto";
import type { EgressJob } from "../apps/cloud/src/egress";

test("Main 生产请求使用 multipart 原始字节和自动 boundary，网关错误可供图片上传重试", async (t) => {
  // 仅替换 Electron 系统令牌 API；执行真实 Cloud.request，不启动 Electron 或外部网络。
  const bundle = await build({
    entryPoints: ["apps/desktop/src/main/cloud.ts"],
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire(process.cwd() + '/package.json');",
    },
    plugins: [
      {
        name: "isolated-electron",
        setup(builder) {
          builder.onResolve({ filter: /^electron$/ }, () => ({
            path: "electron",
            namespace: "fixture",
          }));
          builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
            contents: "export const safeStorage = { decryptString: () => 'fixture-token' };",
          }));
        },
      },
    ],
  });
  const { Cloud } = (await import(
    `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
  )) as typeof import("../apps/desktop/src/main/cloud");
  const cloud = new Cloud({
    get: (key: string) => (key === "cloudUrl" ? "https://fixture.invalid" : "ZmFrZQ=="),
  } as unknown as ConstructorParameters<typeof Cloud>[0]);
  t.mock.method(globalThis, "fetch", async (input: string, init: RequestInit) => {
    assert.equal(input, "https://fixture.invalid/api/runner/runs/run_test/snapshots");
    assert.equal(new Headers(init.headers).get("content-type"), null);
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer fixture-token");
    const request = new Request(input, init);
    assert.match(request.headers.get("content-type")!, /multipart\/form-data; boundary=/);
    const form = await request.formData();
    assert.equal(form.get("epoch"), "1");
    assert.equal(form.get("captureId"), "capture_test");
    assert.equal(form.get("purpose"), "chat");
    assert.deepEqual(Buffer.from(await (form.get("image") as File).arrayBuffer()), fixturePng);
    assert.deepEqual(Buffer.from(await (form.get("thumbnail") as File).arrayBuffer()), fixturePng);
    return new Response("private gateway detail", {
      status: 503,
      headers: { "content-type": "text/html" },
    });
  });
  await assert.rejects(
    cloud.request(
      "POST",
      "/api/runner/runs/run_test/snapshots",
      { epoch: 1, captureId: "capture_test", purpose: "chat", thumbnail: fixturePng },
      false,
      fixturePng,
    ),
    /^Error: HTTP_503$/,
  );
});

async function setup(t: Parameters<typeof productionModelFixture>[0]) {
  const s = await productionModelFixture(t, "responses");
  const images = new Map<string, { original: ArrayBuffer; thumbnail?: ArrayBuffer }>();
  s.env.EVIDENCE_STORE = {
    getByName: (key: string) => ({
      put: async (
        _key: string,
        original: ArrayBuffer,
        _expires: number | null,
        _pending: boolean,
        thumbnail?: ArrayBuffer,
      ) => {
        images.set(key, { original, thumbnail });
      },
      get: async (_key: string, thumbnail: boolean) => {
        const entry = images.get(key);
        return (thumbnail ? (entry?.thumbnail ?? entry?.original) : entry?.original) ?? null;
      },
      remove: async () => {
        images.delete(key);
      },
    }),
  } as unknown as typeof s.env.EVIDENCE_STORE;
  const thread = (
    await s.request("/api/user/threads", { modelId: "model_test", taskId: s.run.taskId })
  ).data;
  s.sql.prepare("UPDATE runs SET thread_id=? WHERE id=?").run(thread.id, s.run.id);
  const upload = (
    purpose: "chat" | "vision",
    captureId: string = crypto.randomUUID(),
    image = fixturePng,
    thumbnail?: Uint8Array,
  ) =>
    s.request(
      `/api/runner/runs/${s.run.id}/snapshots`,
      { epoch: s.run.leaseEpoch, captureId, purpose, thumbnail },
      "POST",
      image,
    );
  return { ...s, thread, images, upload };
}

test("二进制原图与缩略图共用私有索引，旧版 JSON 仍兼容，ID 不能替换内容", async (t) => {
  const s = await setup(t);
  const thumbnail = await sharp(fixturePng).resize(4, 3).png().toBuffer();
  const saved = await s.upload("chat", "binary", fixturePng, thumbnail);
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  const read = (variant = "original") =>
    app.request(
      `http://127.0.0.1/api/user/artifacts/${saved.data.id}?variant=${variant}`,
      {},
      s.env,
    );
  const small = await read("thumbnail"),
    large = await read();
  assert.deepEqual(Buffer.from(await small.arrayBuffer()), thumbnail);
  assert.deepEqual(Buffer.from(await large.arrayBuffer()), fixturePng);
  assert.equal(small.headers.get("Cache-Control"), "no-store");
  assert.equal(small.headers.get("Content-Type"), "image/png");
  assert.equal((await s.upload("chat", "binary", fixturePng, thumbnail)).data.id, saved.data.id);
  assert.equal(s.images.size, 1);
  assert.equal((await s.upload("chat", "binary", thumbnail)).data.error, "ARTIFACT_CONFLICT");
  const legacy = await s.request(`/api/runner/runs/${s.run.id}/snapshots`, {
    epoch: s.run.leaseEpoch,
    captureId: "legacy",
    image: fixturePng.toString("base64"),
  });
  assert.equal(legacy.status, 200);
  const fallback = await app.request(
    `http://127.0.0.1/api/user/artifacts/${legacy.data.id}?variant=thumbnail`,
    {},
    s.env,
  );
  assert.deepEqual(Buffer.from(await fallback.arrayBuffer()), fixturePng);
  s.sql.prepare("UPDATE runs SET history_deleted=1 WHERE id=?").run(s.run.id);
  assert.equal((await read("thumbnail")).status, 404);
});

test("上传拒绝文件头、截断、CRC 损坏、超体积和超尺寸缩略图，失败不留存储", async (t) => {
  const s = await setup(t);
  const corrupt = Buffer.from(fixturePng);
  corrupt[corrupt.length - 5] ^= 1;
  for (const invalid of [
    fixturePng.subarray(0, 8),
    fixturePng.subarray(0, -1),
    corrupt,
    Buffer.concat([fixturePng, Buffer.from([0])]),
  ])
    assert.equal((await s.upload("chat", crypto.randomUUID(), invalid)).data.error, "PNG_REQUIRED");
  // CRC 正确仍不能接收损坏的压缩流、错误扫描行长度或非法过滤器。
  const withData = (data: Buffer) => {
    const chunk = Buffer.alloc(data.length + 12);
    chunk.writeUInt32BE(data.length);
    chunk.write("IDAT", 4);
    data.copy(chunk, 8);
    chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
    return Buffer.concat([fixturePng.subarray(0, 33), chunk, fixturePng.subarray(-12)]);
  };
  const raw = Buffer.alloc((8 * 4 + 1) * 6);
  raw[0] = 5;
  for (const data of [
    Buffer.from([0]),
    deflateSync(raw),
    deflateSync(Buffer.alloc(raw.length - 1)),
    deflateSync(Buffer.alloc(raw.length + 1)),
  ])
    assert.equal(
      (await s.upload("chat", crypto.randomUUID(), withData(data))).data.error,
      "PNG_REQUIRED",
    );
  assert.equal(
    (await s.upload("chat", "large", Buffer.alloc(imageLimits.bytes + 1))).data.error,
    "IMAGE_TOO_LARGE",
  );
  const tooWide = await sharp({
    create: { width: 641, height: 1, channels: 4, background: "white" },
  })
    .png()
    .toBuffer();
  assert.equal(
    (await s.upload("chat", "bad-thumb", fixturePng, tooWide)).data.error,
    "IMAGE_THUMBNAIL_INVALID",
  );
  assert.equal(s.images.size, 0);
});

test(`模型 Responses 只传图片引用到美国出站，结构化修复保留引用，临时图不进入聊天`, async (t) => {
  const s = await setup(t);
  s.sql
    .prepare(
      "UPDATE model_profile_versions SET capabilities=json_set(capabilities,'$.vision',json('true'))",
    )
    .run();
  const saved = await s.upload("vision");
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  const artifactId = saved.data.id;
  assert.ok(Date.parse(saved.data.expiresAt) <= Date.now() + imageLimits.visionTtlMs);
  assert.equal(
    (await app.request(`http://127.0.0.1/api/user/artifacts/${artifactId}`, {}, s.env)).status,
    404,
  );
  const attach = await s.request(`/api/runner/runs/${s.run.id}/messages`, {
    epoch: s.run.leaseEpoch,
    id: "cannot-publish-vision",
    content: "临时图片",
    parts: [{ type: "image", artifactId, alt: "临时" }],
  });
  assert.notEqual(attach.status, 200);
  const jurisdiction = s.env.MODEL_EGRESS.jurisdiction.bind(s.env.MODEL_EGRESS);
  let refJobs = 0;
  t.mock.method(s.env.MODEL_EGRESS, "jurisdiction", (region: "us") => {
    const ns = jurisdiction(region),
      get = ns.getByName.bind(ns);
    return {
      getByName: (name: string) => {
        const stub = get(name),
          submit = stub.submitAndWait.bind(stub);
        return {
          submitAndWait: async (id: string, cipher: string) => {
            const job = await unseal<EgressJob>(cipher, s.env.MASTER_KEY, `egress:${id}:request`);
            assert.equal(job.kind, "inference");
            if (job.kind === "inference") {
              assert.deepEqual(job.request.imageRef, { artifactId, epoch: s.run.leaseEpoch });
              assert.equal(job.request.image, undefined);
              refJobs++;
            }
            return submit(id, cipher);
          },
          ack: stub.ack.bind(stub),
        };
      },
    } as typeof ns;
  });
  s.replies("invalid JSON", '{"value":"seen"}');
  const body = {
    epoch: s.run.leaseEpoch,
    requestId: "reference",
    imageArtifactId: artifactId,
    messages: [{ role: "user", content: "读取图片" }],
    schema: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    },
  };
  const result = await s.request(`/api/runner/runs/${s.run.id}/stagehand`, body);
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(refJobs, 2);
  for (const request of s.requests) {
    assert.ok(
      JSON.stringify(request.body).includes(
        `data:image/png;base64,${fixturePng.toString("base64")}`,
      ),
    );
    assert.ok(!JSON.stringify(request.body).includes(artifactId));
  }
  assert.equal((await s.request(`/api/runner/runs/${s.run.id}/stagehand`, body)).status, 200);
  assert.equal(refJobs, 2, "同次推理不得重放");
  s.sql.prepare("UPDATE artifacts SET lease_epoch=99 WHERE id=?").run(artifactId);
  assert.equal(
    (
      await s.request(`/api/runner/runs/${s.run.id}/stagehand`, {
        ...body,
        requestId: "other-epoch",
      })
    ).data.error,
    "IMAGE_REFERENCE_INVALID",
  );
  s.sql
    .prepare("UPDATE artifacts SET lease_epoch=?,expires_at=946684800000 WHERE id=?")
    .run(s.run.leaseEpoch, artifactId);
  assert.equal(
    (await s.request(`/api/runner/runs/${s.run.id}/stagehand`, { ...body, requestId: "expired" }))
      .data.error,
    "IMAGE_REFERENCE_INVALID",
  );
  await maintenance(s.env);
  assert.equal(s.images.size, 0);
});

test("高复杂度截图按字节预算缩放并生成独立缩略图", async () => {
  const original = await sharp(randomBytes(1200 * 900 * 4), {
    raw: { width: 1200, height: 900, channels: 4 },
  })
    .png()
    .toBuffer();
  assert.ok(original.length > imageLimits.bytes);
  const output = await prepareSnapshot(original);
  assert.ok(output.image.length <= imageLimits.bytes);
  assert.ok(output.thumbnail && output.thumbnail.length <= imageLimits.thumbnailBytes);
  const size = await sharp(output.thumbnail).metadata();
  assert.ok(size.width! <= 640 && size.height! <= 360);
  assert.equal((await prepareSnapshot(fixturePng, false)).thumbnail, undefined);
});

test("只有图片上传重试，响应丢失沿用同一身份，取消后不重试；失败不会谎称已附图", async () => {
  const attempts: string[] = [];
  const upload = imageUploader(
    "run:epoch",
    () => {},
    async (id) => {
      attempts.push(id);
      if (attempts.length === 1) throw Error("OFFLINE");
      return { id: "saved" };
    },
  );
  await upload({ image: fixturePng }, "vision");
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0], attempts[1]);
  await upload({ image: fixturePng }, "vision");
  assert.equal(attempts.length, 2);
  let cancelled = false,
    calls = 0;
  const stopped = imageUploader(
    "run:epoch",
    () => {
      if (cancelled) throw Error("CANCEL_REQUESTED");
    },
    async () => {
      calls++;
      cancelled = true;
      throw Error("OFFLINE");
    },
  );
  await assert.rejects(stopped({ image: fixturePng }, "chat"), /CANCEL_REQUESTED/);
  assert.equal(calls, 1);
  const owner = chatSnapshots(
    "scope",
    async () => ({ image: fixturePng }),
    async () => {
      throw Error("OFFLINE");
    },
  );
  const failed = await owner.take("opened");
  assert.equal(failed.available, false);
  assert.match(failed.error!, /上传失败/);
});
