import { seedMessage } from "./helpers";
import { test } from "node:test";
import assert from "node:assert/strict";
import { productionModelFixture } from "./production-model-fixture";
import { beginCleanup, cleanupJobs, drainHistoryCleanups } from "../apps/cloud/src/history-cleanup";
import { insertTask, task } from "./helpers";
import { appendMessage } from "../apps/cloud/src/chat-messages";
import { invoke } from "../apps/cloud/src/models";

async function setup(t: Parameters<typeof productionModelFixture>[0]) {
  const s = await productionModelFixture(t);
  const created = await s.request("/api/user/threads", {
    modelId: "model_test",
    taskId: s.run.taskId,
  });
  assert.equal(created.status, 200);
  const thread = created.data.id as string;
  s.sql.prepare("UPDATE runs SET thread_id=? WHERE id=?").run(thread, s.run.id);
  await appendMessage(s.env, thread, {
    id: "msg_secret",
    source: "executor",
    content: "待删除的正文",
    runId: s.run.id,
  });
  return { ...s, thread };
}
async function drain(s: Awaited<ReturnType<typeof setup>>) {
  for (let i = 0; i < 30; i++) if (!(await drainHistoryCleanups(s.env))) return;
  assert.fail("清理没有结束");
}

test("删除运行中的聊天先关闭并隐藏，迟到收尾保持 unknown，不重写正文", async (t) => {
  const s = await setup(t);
  s.sql.prepare("UPDATE runs SET write_pending=1 WHERE id=?").run(s.run.id);
  const response = await s.request("/api/user/history-cleanups", {
    scope: "task",
    targetId: s.run.taskId,
    requestId: "delete_one",
  });
  assert.equal(response.status, 202);
  const snapshot = await s.request("/api/user/snapshot", null, "GET");
  assert.equal(snapshot.data.tasks.length, 0);
  assert.equal(snapshot.data.runs.length, 0);
  assert.equal(
    (await s.request("/api/user/threads", { modelId: "model_test", taskId: s.run.taskId })).status,
    404,
  );
  assert.equal(
    (
      await s.request(`/api/user/threads/${s.thread}/messages`, {
        content: "迟到",
        requestId: "late",
      })
    ).status,
    404,
  );
  await drain(s);
  const finish = {
    epoch: s.run.leaseEpoch,
    status: "succeeded",
    result: { summary: "不能写回的秘密", outcome: "reported", evidence: [] },
  };
  assert.equal((await s.request(`/api/runner/runs/${s.run.id}/finish`, finish)).status, 200);
  assert.equal((await s.request(`/api/runner/runs/${s.run.id}/finish`, finish)).status, 200);
  const row = s.sql
    .prepare("SELECT status,result,task_snapshot FROM run_details WHERE id=?")
    .get(s.run.id);
  assert.equal(row?.status, "unknown");
  assert.equal(row?.result, null);
  assert.equal(row?.task_snapshot, null);
  assert.ok(s.sql.prepare("SELECT * FROM account_locks WHERE run_id=?").get(s.run.id));
  assert.equal(s.sql.prepare("SELECT COUNT(*) n FROM ai_messages").get()?.n, 0);
  // 模拟已经越过入口租约检查的旧请求，数据库最后一道边界仍拒绝重新写入。
  assert.equal(
    s.sql.prepare("SELECT name FROM sqlite_master WHERE name='run_events'").get(),
    undefined,
  );
  assert.throws(
    () =>
      s.sql
        .prepare("INSERT INTO run_results(run_id,result) VALUES(?,?)")
        .run(s.run.id, JSON.stringify({ summary: "secret" })),
    /RUN_HISTORY_DELETED/,
  );
});

test("全部清理固定目标，重复请求不删除之后新建的聊天，跨用户拒绝", async (t) => {
  const s = await setup(t);
  const owner = s.run.userId;
  const groupTask = await insertTask(s.db, task({ id: "group_without_run", accountId: null }));
  const groupThread = await s.request("/api/user/threads", {
    modelId: "model_test",
    taskId: groupTask.id,
  });
  s.sql
    .prepare(
      "INSERT INTO account_dispatch_groups(id,task_id,task_version,thread_id,user_id,created_at,updated_at,member_count) VALUES('not_started',?,1,?,?,?, ?,1)",
    )
    .run(groupTask.id, groupThread.data.id, owner, Date.now(), Date.now());
  s.sql
    .prepare("INSERT INTO account_dispatch_members(group_id,position) VALUES('not_started',0)")
    .run();
  const job = await beginCleanup(s.env, owner, "all", null, "all_once");
  const newTask = await insertTask(s.db, task({ id: "new_task" }));
  const fresh = await s.request("/api/user/threads", { modelId: "model_test", taskId: newTask.id });
  assert.equal(fresh.status, 200);
  assert.equal((await beginCleanup(s.env, owner, "all", null, "all_once")).id, job.id);
  await assert.rejects(
    () => beginCleanup(s.env, owner, "task", newTask.id, "all_once"),
    /REQUEST_CONFLICT/,
  );
  await assert.rejects(
    () => beginCleanup(s.env, "another_user", "task", newTask.id, "other"),
    /TASK_NOT_FOUND/,
  );
  assert.deepEqual(await cleanupJobs(s.env, "another_user", job.id), []);
  await drain(s);
  assert.ok(s.sql.prepare("SELECT id FROM tasks WHERE id=? AND deleted=0").get(newTask.id));
  assert.ok(s.sql.prepare("SELECT id FROM ai_threads WHERE id=? AND closed=0").get(fresh.data.id));
  assert.equal((await cleanupJobs(s.env, owner, job.id))[0].status, "done");
  assert.equal(
    s.sql
      .prepare(
        "SELECT definition FROM task_versions WHERE task_id='group_without_run' AND version=1",
      )
      .get()!.definition,
    "{}",
  );
});

test("批写统计不能阻塞已清空的队首，也不能提前完成仍有下一批正文的目标", async (t) => {
  const s = await setup(t);
  for (let i = 0; i < 105; i++)
    seedMessage(s.sql, {
      id: "batch_" + i,
      thread_id: s.thread,
      seq: i + 10,
      role: "user",
      content: "待清理",
      turn_id: "turn",
      at: Date.now(),
    });
  const job = await beginCleanup(s.env, s.run.userId, "all", null, "cleanup_progress");
  const batch = s.env.DB.batch.bind(s.env.DB);
  t.mock.method(s.env.DB, "batch", async (statements: D1PreparedStatement[]) =>
    (await batch(statements)).map((r) => ({ ...r, meta: { ...r.meta, changes: 1 } })),
  );
  await drain(s);
  const [done] = await cleanupJobs(s.env, s.run.userId, job.id);
  assert.equal(done.status, "done");
  assert.equal(done.completed, done.total);
  assert.equal(
    s.sql.prepare("SELECT COUNT(*) n FROM ai_messages WHERE thread_id=?").get(s.thread)?.n,
    0,
  );
});

test("清空保留暂停入口，后台只清旧运行和旧聊天，新消息不受影响", async (t) => {
  const s = await setup(t);
  const response = await s.request("/api/user/history-cleanups", {
    scope: "clear",
    targetId: s.run.taskId,
    requestId: "clear_one",
  });
  assert.equal(response.status, 202);
  const task = s.sql.prepare("SELECT * FROM task_details WHERE id=?").get(s.run.taskId)!;
  assert.equal(task.deleted, 0);
  assert.equal(task.status, "paused");
  assert.equal(task.context_withdrawn, 1);
  assert.equal(JSON.parse(String(task.definition)).goal, "请重新交办任务");
  const fresh = await s.request("/api/user/threads", {
    modelId: "model_test",
    taskId: s.run.taskId,
  });
  assert.equal(fresh.status, 200);
  assert.notEqual(fresh.data.id, s.thread);
  await appendMessage(s.env, fresh.data.id, { id: "new", source: "cloud", content: "新的聊天" });
  await drain(s);
  assert.equal(
    s.sql.prepare("SELECT content FROM message_details WHERE id=?").get("new")?.content,
    "新的聊天",
  );
  assert.equal(
    (await s.request(`/api/user/tasks/${s.run.taskId}/run`, { requestId: "cannot_reuse" })).status,
    400,
  );
});

test("图片删除失败可恢复，正文分批清理且密文/图副本回收，保留幂等摘要", async (t) => {
  const s = await setup(t);
  let fail = true,
    removed = 0;
  s.env.EVIDENCE_STORE = {
    getByName: () => ({
      remove: async () => {
        if (fail) throw Error("offline");
        removed++;
      },
    }),
  } as unknown as typeof s.env.EVIDENCE_STORE;
  s.sql
    .prepare(
      "INSERT INTO artifacts(id,run_id,thread_id,object_key,content_type,expires_at) VALUES('image',?,?, 'image_key','image/png',253370764800000)",
    )
    .run(s.run.id, s.thread);
  s.sql
    .prepare("UPDATE message_bodies SET private_content='encrypted-secret' WHERE id='msg_secret'")
    .run();
  for (let i = 0; i < 205; i++)
    seedMessage(s.sql, {
      id: "m" + i,
      thread_id: s.thread,
      seq: i + 10,
      role: "user",
      content: "secret",
      turn_id: "turn",
      at: Date.now(),
    });
  s.sql
    .prepare(
      "INSERT INTO ai_graph_inputs(owner,id,digest,parent_thread,created_at) VALUES(?,'graph','digest',?,CAST(unixepoch('subsec')*1000 AS INTEGER))",
    )
    .run(s.run.userId, s.thread);
  s.sql
    .prepare(
      "INSERT INTO ai_checkpoints(owner,thread,ns,id,checkpoint,metadata,at) VALUES(?,'graph','','checkpoint','secret','secret',CAST(unixepoch('subsec')*1000 AS INTEGER))",
    )
    .run(s.run.userId);
  s.sql
    .prepare(
      "INSERT INTO ai_calls(id,user_id,graph_id,digest,status,created_at,updated_at) VALUES('call',?,'graph','digest','done',CAST(unixepoch('subsec')*1000 AS INTEGER),CAST(unixepoch('subsec')*1000 AS INTEGER))",
    )
    .run(s.run.userId);
  s.sql.prepare("INSERT INTO call_results(id,result) VALUES('call','secret')").run();
  const job = await beginCleanup(s.env, s.run.userId, "task", s.run.taskId, "retry");
  await drainHistoryCleanups(s.env);
  assert.equal((await cleanupJobs(s.env, s.run.userId, job.id))[0].error, "CLEANUP_RETRYING");
  assert.equal(s.sql.prepare("SELECT COUNT(*) n FROM artifacts").get()?.n, 1);
  fail = false;
  await drainHistoryCleanups(s.env);
  assert.ok(Number(s.sql.prepare("SELECT COUNT(*) n FROM ai_messages").get()?.n) > 100);
  await drain(s);
  assert.equal(removed, 1);
  for (const table of ["artifacts", "ai_messages", "ai_checkpoints"])
    assert.equal(s.sql.prepare(`SELECT COUNT(*) n FROM ${table}`).get()?.n, 0);
  assert.equal(s.sql.prepare("SELECT result FROM call_details").get()?.result, null);
  assert.equal(s.sql.prepare("SELECT digest FROM ai_calls").get()?.digest, "digest");
});

test("无 graphId 的桌面模型缓存按运行清理，清理途中返回的模型结果被丢弃", async (t) => {
  const s = await setup(t);
  s.replies("模型旧结果", "模型迟到结果");
  await invoke(
    s.env,
    "model_test",
    1,
    { messages: [{ role: "user", content: "测试" }] },
    s.run.id,
    "cached",
  );
  assert.equal(
    s.sql.prepare("SELECT run_id FROM ai_calls WHERE id=?").get("cached")?.run_id,
    s.run.id,
  );
  const original = s.env.MODEL_EGRESS.jurisdiction.bind(s.env.MODEL_EGRESS);
  t.mock.method(s.env.MODEL_EGRESS, "jurisdiction", (region: "us") => {
    const namespace = original(region);
    return {
      getByName: (name: string) => {
        const stub = namespace.getByName(name);
        return {
          ack: () => stub.ack(),
          submitAndWait: async (id: string, cipher: string) => {
            const result = await stub.submitAndWait(id, cipher);
            await beginCleanup(s.env, s.run.userId, "task", s.run.taskId, "during_model");
            await drain(s);
            return result;
          },
        };
      },
    } as typeof namespace;
  });
  await assert.rejects(
    () =>
      invoke(
        s.env,
        "model_test",
        1,
        { messages: [{ role: "user", content: "测试2" }] },
        s.run.id,
        "late",
      ),
    /MODEL_CALL_DISCARDED/,
  );
  assert.equal(
    s.sql.prepare("SELECT COUNT(*) n FROM call_details WHERE result IS NOT NULL").get()?.n,
    0,
  );
  await assert.rejects(
    () =>
      invoke(
        s.env,
        "model_test",
        1,
        { messages: [{ role: "user", content: "测试" }] },
        s.run.id,
        "cached",
      ),
    /MODEL_CALL_DISCARDED/,
  );
  assert.equal(s.requests.length, 2);
});

test("旧网页重试 DELETE 不扩大到新聊天，旧闭合会话的首次清理也不能撤回新任务", async (t) => {
  const s = await setup(t);
  const response = await s.request(`/api/user/threads/${s.thread}`, {}, "DELETE");
  assert.equal(response.status, 200);
  const fresh = await s.request("/api/user/threads", {
    modelId: "model_test",
    taskId: s.run.taskId,
  });
  assert.equal(fresh.status, 200);
  s.sql.prepare("UPDATE tasks SET context_withdrawn=0 WHERE id=?").run(s.run.taskId);
  await s.request(`/api/user/threads/${s.thread}`, {}, "DELETE");
  assert.equal(
    s.sql.prepare("SELECT context_withdrawn FROM tasks WHERE id=?").get(s.run.taskId)
      ?.context_withdrawn,
    0,
  );
  // 模拟旧版已经关闭、没有作业的会话，不应对同任务的新聊天追加停止/清空。
  s.sql
    .prepare(
      "INSERT INTO ai_threads(id,user_id,task_id,kind,model_id,model_version,closed,deleted,created_at,updated_at) VALUES('old_closed',?,?,'chat','model_test',1,1,1,0,0)",
    )
    .run(s.run.userId, s.run.taskId);
  await s.request("/api/user/threads/old_closed", {}, "DELETE");
  assert.equal(
    s.sql.prepare("SELECT context_withdrawn FROM tasks WHERE id=?").get(s.run.taskId)
      ?.context_withdrawn,
    0,
  );
  assert.equal(
    s.sql.prepare("SELECT closed FROM ai_threads WHERE id=?").get(fresh.data.id)?.closed,
    0,
  );
});

test("创建聊天读取任务后发生清空，旧任务草稿不能进入新聊天", async (t) => {
  const s = await setup(t),
    prepare = s.db.prepare.bind(s.db);
  let intercepted = false;
  t.mock.method(s.db, "prepare", (sql: string) => {
    const statement = prepare(sql);
    if (sql.startsWith("INSERT OR IGNORE INTO ai_threads") && !intercepted) {
      intercepted = true;
      const bind = statement.bind.bind(statement);
      statement.bind = (...values: unknown[]) => {
        const bound = bind(...values),
          run = bound.run.bind(bound);
        bound.run = async () => {
          await beginCleanup(s.env, s.run.userId, "clear", s.run.taskId, "racing_clear");
          return run();
        };
        return bound;
      };
    }
    return statement;
  });
  const response = await s.request("/api/user/threads", {
    modelId: "model_test",
    taskId: s.run.taskId,
  });
  assert.equal(response.status, 404);
  assert.equal(s.sql.prepare("SELECT COUNT(*) n FROM ai_threads WHERE closed=0").get()?.n, 0);
  const fresh = await s.request("/api/user/threads", {
    modelId: "model_test",
    taskId: s.run.taskId,
  });
  assert.equal(fresh.status, 200);
  assert.equal(fresh.data.draft.goal, "请重新交办任务");
});
