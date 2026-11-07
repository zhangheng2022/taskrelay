import test from "node:test";
import assert from "node:assert/strict";
import { chatSnapshots } from "../apps/desktop/src/executor/chat-snapshots";

test("图片上传后消息发布失败，后续节点复用对象但仍附图；确认发布后才省略重复图片", async () => {
  let captures = 0,
    uploads = 0;
  const owner = chatSnapshots(
    "run:epoch",
    async () => {
      captures++;
      return { image: Buffer.from("masked-png") };
    },
    async () => {
      uploads++;
      return { id: "image_one" };
    },
  );
  const first = await owner.take("failure");
  assert.equal(first.parts.length, 1);
  // 模拟 publish 未成功：没有调用 published，不能宣称聊天已有该图。
  const next = await owner.take("final");
  assert.equal(next.reused, false);
  assert.deepEqual(next.parts, first.parts);
  owner.published(next.parts);
  const after = await owner.take("explicit");
  assert.equal(after.reused, true);
  assert.equal(after.parts.length, 0);
  await owner.take("explicit");
  assert.equal(captures, 3);
  assert.equal(uploads, 1);
});
