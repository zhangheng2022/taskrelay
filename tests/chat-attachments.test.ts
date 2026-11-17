import assert from "node:assert/strict";
import test from "node:test";
import { app } from "../apps/cloud/src/index";
import { scannedPdfFixture } from "../apps/cloud/src/pdf-fixture";
import { visionFixture } from "../apps/cloud/src/vision-fixture";
import { retainHistory } from "../apps/cloud/src/ai/lifecycle";
import { productionModelFixture } from "./production-model-fixture";

function statement(name: string, data: string, type: string) {
  return new File([Buffer.from(data.split(",")[1], "base64")], name, { type });
}
const scan = () => statement("扫描件.pdf", scannedPdfFixture(), "application/pdf");
const picture = () => statement("图片.png", visionFixture, "image/png");

test("附件消息原子接受、防重、跨用户隔离、撤回与保留期清理", async (t) => {
  const s = await productionModelFixture(t);
  const objects = new Map<string, ArrayBuffer>();
  s.env.EVIDENCE_STORE = {
    getByName: (key: string) => ({
      put: async (_key: string, bytes: ArrayBuffer) => {
        objects.set(key, bytes);
      },
      get: async () => objects.get(key) ?? null,
      remove: async () => {
        objects.delete(key);
      },
    }),
  } as unknown as typeof s.env.EVIDENCE_STORE;
  s.sql.exec(
    "UPDATE model_profile_versions SET capabilities=json_set(capabilities,'$.vision',json('true'))",
  );
  const thread = (await s.request("/api/user/threads", { modelId: "model_test" })).data;
  const path = "/api/user/threads/" + thread.id;
  const call = (suffix: string, init?: RequestInit) =>
    app.request("http://127.0.0.1" + path + suffix, init, s.env);
  const send = (id: string, files: File[], content = "") => {
    const body = new FormData();
    body.set("requestId", id);
    body.set("content", content);
    for (const file of files) body.append("files", file);
    return call("/attachment-messages", { method: "POST", body });
  };
  assert.equal((await send("media", [scan()])).status, 400, "未验证的 PDF 不入库");
  assert.equal(
    (await send("invalid", [new File(["<svg />"], "fake.png", { type: "image/png" })])).status,
    400,
  );
  assert.equal(objects.size, 0);
  s.sql.exec(
    "UPDATE model_profile_versions SET capabilities=json_set(capabilities,'$.pdf',json('true'))",
  );
  s.respond(() =>
    JSON.stringify({
      reply: "开始浏览",
      start: true,
      title: "任务",
      goal: "打开网站",
      entryUrl: "https://example.com/",
      accountId: null,
      accountIds: [],
      executionOutline: ["打开"],
    }),
  );
  const text = new File(["sku,qty\n桃,2"], "明细.csv");
  const result = await Promise.all([
    send("media", [scan(), picture(), text]),
    send("media", [scan(), picture(), text]),
  ]);
  for (const response of result) assert.equal(response.status, 202, await response.text());
  const page = (await (await call("")).json()) as any;
  const message = page.messages.find((m: any) => m.role === "user");
  assert.equal(message.content, "");
  assert.equal(page.taskId, null, "仅附件不能触发交办，即使模型要求启动");
  assert.equal(page.messages.filter((m: any) => m.role === "user").length, 1);
  assert.equal(s.sql.prepare("SELECT COUNT(*) n FROM chat_attachments").get()!.n, 3);
  assert.equal(objects.size, 3);
  assert.equal(s.requests.length, 1);
  const inputs = s.requests[0].body.input.flatMap((m: any) =>
    Array.isArray(m.content) ? m.content : [],
  );
  assert.deepEqual(
    inputs.find((part: any) => part.type === "input_file"),
    {
      type: "input_file",
      filename: "扫描件.pdf",
      file_data: scannedPdfFixture(),
    },
  );
  assert.equal(inputs.find((part: any) => part.type === "input_image").image_url, visionFixture);
  assert.ok(inputs.some((part: any) => part.type === "input_text" && part.text.includes("桃")));
  assert.equal((await send("media", [new File(["changed"], "明细.csv")])).status, 409);
  assert.equal(
    (await s.request(path + "/messages", { requestId: "media", content: "changed" })).status,
    409,
  );
  const [file, image] = message.attachments;
  const imageUrl = "/attachments/" + image.id;
  const original = await call(imageUrl);
  assert.equal(original.headers.get("content-type"), "image/png");
  assert.match(original.headers.get("content-disposition")!, /^inline;/);
  assert.deepEqual(await original.arrayBuffer(), await picture().arrayBuffer());
  assert.match(
    (await call("/attachments/" + file.id)).headers.get("content-disposition")!,
    /^attachment;/,
  );
  s.sql.exec("INSERT INTO members(id,email,role) VALUES('a_other','another@example.com','admin')");
  assert.equal((await call(imageUrl)).status, 404);
  assert.equal((await send("not-owner", [text])).status, 404);
  s.sql.exec("UPDATE members SET disabled=1 WHERE id='a_other'");
  assert.equal(
    (await call("/messages/" + message.id + "/private", { method: "POST" })).status,
    200,
  );
  assert.equal((await call(imageUrl)).status, 200, "本人仍可下载已撤回资料");
  s.respond(() => '{"reply":"请提供新问题"}');
  assert.equal(
    (await s.request(path + "/messages", { requestId: "next", content: "你好" })).status,
    202,
  );
  assert.doesNotMatch(JSON.stringify(s.requests.at(-1)!.body), /扫描件|桃|input_file/);
  s.sql.prepare("UPDATE ai_threads SET updated_at=1 WHERE id=?").run(thread.id);
  await retainHistory(s.env, new Date(Date.now() - 3600000).toISOString());
  assert.equal((await call(imageUrl)).status, 404);
  assert.equal(objects.size, 0);
});

test("执行器按已收到的用户序号读取最近两批原件，摘要不含原件", async (t) => {
  const s = await productionModelFixture(t);
  const objects = new Map<string, ArrayBuffer>();
  s.env.EVIDENCE_STORE = {
    getByName: (key: string) => ({
      put: async (_key: string, bytes: ArrayBuffer) => {
        objects.set(key, bytes);
      },
      get: async () => objects.get(key) ?? null,
    }),
  } as unknown as typeof s.env.EVIDENCE_STORE;
  const thread = (
    await s.request("/api/user/threads", { modelId: "model_test", taskId: s.run.taskId })
  ).data;
  s.sql.prepare("UPDATE runs SET thread_id=? WHERE id=?").run(thread.id, s.run.id);
  const seqs: number[] = [];
  for (const content of ["old-ledger-1", "old-ledger-2", "new-ledger-3"]) {
    const body = new FormData();
    body.set("requestId", content);
    body.set("content", "按之前的授权核对");
    body.set("files", new File([content], content + ".txt"));
    const response = await app.request(
      "http://127.0.0.1/api/user/threads/" + thread.id + "/attachment-messages",
      { method: "POST", body },
      s.env,
    );
    assert.equal(response.status, 202);
    const page = (await response.json()) as any;
    seqs.push(page.messages.filter((m: any) => m.role === "user").at(-1).seq);
  }
  s.replies("已读", "已读", "摘要");
  const ask = (seq: number, purpose: "decision" | "summary" = "decision") =>
    s.request(`/api/runner/runs/${s.run.id}/model`, {
      epoch: s.run.leaseEpoch,
      requestId: crypto.randomUUID(),
      expectedUserSeq: seq,
      purpose,
      messages: [{ role: "user", content: "查看本次资料" }],
    });
  assert.equal((await ask(seqs[1])).status, 200);
  assert.match(JSON.stringify(s.requests[0].body), /old-ledger-1.*old-ledger-2/);
  assert.doesNotMatch(JSON.stringify(s.requests[0].body), /new-ledger-3/);
  assert.equal((await ask(seqs[2])).status, 200);
  assert.match(JSON.stringify(s.requests[1].body), /old-ledger-2.*new-ledger-3/);
  assert.doesNotMatch(JSON.stringify(s.requests[1].body), /old-ledger-1/);
  assert.equal((await ask(seqs[2], "summary")).status, 200);
  assert.doesNotMatch(JSON.stringify(s.requests[2].body), /ledger/);
});

test("PDF 测试读取扫描页并按版本和推理档位记录结果", async (t) => {
  const s = await productionModelFixture(t);
  s.sql.exec(
    `UPDATE model_profile_versions SET capabilities=json_set(capabilities,'$.reasoningEfforts.low',json('{"structured":"schema","vision":false,"streaming":[]}')) WHERE id='model_test' AND version=1`,
  );
  s.replies(
    '{"digits":"427"}',
    JSON.stringify({
      __model: {
        text: "",
        calls: [{ id: "checked", name: "check", arguments: '{"digits":"427"}' }],
      },
    }),
  );
  const passed = await s.request("/api/admin/models/model_test/pdf?version=1", { effort: "low" });
  assert.equal(passed.status, 200);
  assert.equal(passed.data.reasoningEfforts.low.pdf, true);
  assert.equal(passed.data.pdf, undefined);
  for (const { body } of s.requests) {
    assert.deepEqual(body.reasoning, { effort: "low" });
    assert.equal(body.input[0].content[1].file_data, scannedPdfFixture());
  }
  s.replies('{"digits":"724"}');
  const other = await s.request("/api/admin/models/model_test/pdf?version=2", { effort: null });
  assert.equal(other.status, 200);
  assert.equal(other.data.pdf, false);
  assert.equal(other.data.reasoningEfforts, undefined);
});
