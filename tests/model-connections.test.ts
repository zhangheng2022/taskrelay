/** 服务删除走真实 HTTP 路由，覆盖历史引用、权限边界及保存模型时的竞态。 */
import test from "node:test";
import assert from "node:assert/strict";
import { testDb } from "./helpers";
import { app } from "../apps/cloud/src/index";
import { createConnection, type connectionDeletionPreview } from "../apps/cloud/src/model-gateway";
import { storeModel } from "../apps/cloud/src/models";
import type { AppEnv } from "../apps/cloud/src/env";
type DeletionPreview = Awaited<ReturnType<typeof connectionDeletionPreview>>;

test("服务删除检查所有版本，过期预览不能删除新引用，私有连接和网关配置保持不变", async (t) => {
  const { db, sql } = testDb();
  t.after(() => sql.close());
  const env = { DB: db, DEV_MODE: "1" } as AppEnv;
  t.mock.method(globalThis, "fetch", () => {
    throw Error("删除不应请求外部网关");
  });
  const request = (id: string, method = "GET") =>
    app.request(
      `http://localhost/api/admin/model-connections/${id}${method === "GET" ? "/deletion" : ""}`,
      { method },
      env,
    );
  const empty = await createConnection(env, {
    kind: "provider",
    provider: "openai",
    name: "空服务",
    defaultRegion: "auto",
  });
  assert.deepEqual(await (await request(empty.id)).json(), {
    name: "空服务",
    referenceCount: 0,
    references: [],
  });
  assert.equal((await request(empty.id, "DELETE")).status, 200);
  assert.equal((await request(empty.id)).status, 404);
  assert.equal((await request(empty.id, "DELETE")).status, 404);
  assert.ok(sql.prepare("SELECT id FROM model_connections WHERE id='conn_test'").get());

  const referenced = await createConnection(env, {
    kind: "workers-ai",
    name: "历史服务",
    defaultRegion: "auto",
  });
  const before = (await (await request(referenced.id)).json()) as DeletionPreview;
  assert.equal(before.referenceCount, 0);
  const model = await storeModel(env, {
    name: "旧配置",
    connectionId: referenced.id,
    model: "@cf/test/example",
  });
  await storeModel(
    env,
    { name: "新配置", connectionId: "conn_test", model: "current" },
    model.id,
    1,
  );
  const preview = (await (await request(referenced.id)).json()) as DeletionPreview;
  assert.deepEqual(preview.references, [{ modelId: model.id, version: 1, name: "旧配置" }]);
  const blocked = await request(referenced.id, "DELETE");
  assert.equal(blocked.status, 409);
  assert.deepEqual(await blocked.json(), { error: "MODEL_CONNECTION_IN_USE" });
  // 模型本身仍为停用；仅停用或将新版本切到其他服务都不能清除历史引用。
  const removed = await app.request(
    `http://localhost/api/admin/models/${model.id}`,
    {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedVersion: 2 }),
    },
    env,
  );
  assert.equal(removed.status, 200, await removed.text());
  assert.equal((await request(referenced.id, "DELETE")).status, 200);
  sql.exec(
    "INSERT INTO model_connections(id,owner_user_id,name,kind,provider,key_alias,default_region) VALUES('private_connection','fixture_owner','私有','provider','openai','private','auto')",
  );
  for (const method of ["GET", "DELETE"])
    assert.equal((await request("private_connection", method)).status, 404);
  assert.ok(sql.prepare("SELECT id FROM model_connections WHERE id='private_connection'").get());
  assert.deepEqual(sql.prepare("PRAGMA foreign_key_check").all(), []);
});

test("删除预览限制返回数量并保留准确的版本总数", async (t) => {
  const { db, sql } = testDb();
  t.after(() => sql.close());
  const env = { DB: db, DEV_MODE: "1" } as AppEnv;
  const model = await storeModel(env, {
    name: "多版本",
    connectionId: "conn_test",
    model: "fixture",
  });
  for (let version = 1; version <= 20; version++) {
    await storeModel(
      env,
      { name: "多版本", connectionId: "conn_test", model: "fixture" },
      model.id,
      version,
    );
  }
  const preview = (await (
    await app.request("http://localhost/api/admin/model-connections/conn_test/deletion", {}, env)
  ).json()) as DeletionPreview;
  assert.equal(preview.referenceCount, 21);
  assert.equal(preview.references.length, 20);
});

test("连接在模型读取后删除，不留下空模型或前移已有模型版本", async (t) => {
  const { db, sql } = testDb();
  t.after(() => sql.close());
  const env = { DB: db, DEV_MODE: "1" } as AppEnv;
  const existing = await storeModel(env, {
    name: "已有模型",
    connectionId: "conn_test",
    model: "fixture",
  });
  const batch = db.batch.bind(db);
  for (const id of ["new_model", existing.id]) {
    const connection = await createConnection(env, {
      kind: "workers-ai",
      name: "即将删除",
      defaultRegion: "auto",
    });
    const mock = t.mock.method(db, "batch", async (...args: Parameters<typeof db.batch>) => {
      const result = await app.request(
        `http://localhost/api/admin/model-connections/${connection.id}`,
        { method: "DELETE" },
        env,
      );
      assert.equal(result.status, 200);
      return batch(...args);
    });
    await assert.rejects(
      storeModel(
        env,
        { name: "新配置", connectionId: connection.id, model: "@cf/test/example" },
        id,
        id === existing.id ? 1 : undefined,
      ),
      /RESOURCE_VERSION_CONFLICT/,
    );
    mock.mock.restore();
  }
  assert.equal(sql.prepare("SELECT id FROM models WHERE id='new_model'").get(), undefined);
  assert.equal(
    sql.prepare("SELECT current_version FROM models WHERE id=?").get(existing.id)!.current_version,
    1,
  );
  assert.deepEqual(sql.prepare("PRAGMA foreign_key_check").all(), []);
});
