import { AiTurn as ProductionAiTurn } from "../../apps/cloud/src/ai/turn";
// Isolated workerd fixture. No network provider and no production secrets.
import worker from "../../apps/cloud/src/worker";
export {
  RequestCoordinator,
  Scheduler,
  NotificationHub,
  ModelEgress,
} from "../../apps/cloud/src/worker";
import { Evidence as ProductionEvidence } from "../../apps/cloud/src/evidence-store";
import { hash } from "../../packages/contracts/src/security";
import { seal, unseal } from "../../apps/cloud/src/crypto";
import { enqueue, claim } from "../../apps/cloud/src/store";
import type { TaskDefinition } from "../../packages/contracts/src/index";
import { D1Checkpointer } from "../../apps/cloud/src/ai/checkpointer";
import { emptyCheckpoint } from "@langchain/langgraph-checkpoint";
import type { AppEnv } from "../../apps/cloud/src/env";
import { app } from "../../apps/cloud/src/index";
import { stagehandSchema } from "../../apps/cloud/src/ai/stagehand-schema";
import { z } from "zod";
import { applicationDb } from "../../apps/cloud/src/database";
import { validateSnapshotPng } from "../../apps/cloud/src/png";
import type { DraftPublication } from "../../apps/cloud/src/chat-drafts";
app.onError((e, c) => {
  console.error("fixture error", e.message);
  return c.json({ error: e.message }, 500);
});
export default {
  async fetch(req: Request, env: AppEnv, ctx: ExecutionContext) {
    env = { ...env, DB: applicationDb(env.DB) };
    if (!["localhost", "127.0.0.1"].includes(new URL(req.url).hostname))
      return new Response(null, { status: 403 });
    const path = new URL(req.url).pathname;
    if (path === "/_image-validation") {
      const bytes = new Uint8Array(await req.arrayBuffer());
      const size = await validateSnapshotPng(bytes);
      let rejected = false;
      try {
        await validateSnapshotPng(bytes.subarray(0, 8));
      } catch {
        rejected = true;
      }
      return Response.json({ ...size, rejected });
    }
    if (path === "/_schema") {
      const validate = stagehandSchema(z.toJSONSchema(z.strictObject({ extraction: z.string() })));
      const valid = validate({ extraction: "fixture" });
      let rejected = false;
      try {
        validate({ extraction: 3 });
      } catch {
        rejected = true;
      }
      return Response.json({ valid, rejected });
    }
    if (path === "/_init") {
      await env.DB.prepare("UPDATE settings SET value='0' WHERE key='modelStreamingEnabled'").run();
      await env.DB.prepare(
        "INSERT INTO members(id,email,role) VALUES('fixture_owner','fixture@example.com','admin')",
      ).run();
      await env.DB.prepare(
        "INSERT INTO devices(id,name,token_hash,protocol_version) VALUES('fixture','fixture',?,19)",
      )
        .bind(await hash("d".repeat(64)))
        .run();
      await env.DB.prepare(
        "INSERT INTO model_connections(id,name,kind,provider,key_alias,default_region,binding_verified) VALUES('conn_test','fixture','provider','openai','fixture-key','us',1)",
      ).run();
      await env.DB.prepare(
        "INSERT INTO model_profile_versions(id,version,config,connection_id,effective_region,capabilities,created_at) VALUES(?,1,?,'conn_test','us',?,?)",
      )
        .bind(
          "fixture",
          JSON.stringify({
            name: "fixture",
            region: "inherit",
            model: "fixture",
            protocol: "responses",
            inputPrice: null,
            outputPrice: null,
          }),
          JSON.stringify({ connection: true, tools: true, structured: "schema", vision: false }),
          Date.now(),
        )
        .run();
      return Response.json({ ok: true });
    }
    if (path === "/_evidence") {
      const store = env.EVIDENCE_STORE.getByName("fixture");
      const bytes = new Uint8Array(1_100_000).fill(51).buffer;
      const thumbnail = new Uint8Array(900).fill(17).buffer;
      await store.put("fixture", bytes, Date.now() + 60000, false, thumbnail);
      const result = await store.get("fixture");
      const other = await store.get("other");
      const small = await store.get("fixture", true);
      if (small?.byteLength !== 900 || new Uint8Array(small)[0] !== 17)
        throw Error("THUMBNAIL_FAILED");
      await store.remove();
      if (await store.get("fixture", true)) throw Error("THUMBNAIL_NOT_REMOVED");
      return Response.json({
        size: result?.byteLength,
        first: result ? new Uint8Array(result)[0] : null,
        other,
        removed: await store.get("fixture"),
      });
    }
    if (path === "/_checkpoint") {
      const saver = new D1Checkpointer(env.DB, "fixture_owner", env.MASTER_KEY),
        cp = emptyCheckpoint();
      const text = "a".repeat(1_250_000);
      cp.channel_values = { original: text };
      const config = await saver.put({ configurable: { thread_id: "large-fixture" } }, cp, {
        source: "input",
        step: 0,
        parents: {},
      });
      await saver.putWrites(config, [["output", text]], "fixture");
      const saved = await saver.getTuple(config);
      const intact =
        saved?.checkpoint.channel_values.original === text &&
        saved.pendingWrites?.[0]?.[2] === text;
      await saver.deleteThread("large-fixture");
      const remaining = await env.DB.prepare(
        "SELECT (SELECT count(*) FROM ai_checkpoint_chunks)+(SELECT count(*) FROM ai_write_chunks) AS n",
      ).first<{ n: number }>();
      return Response.json({ intact, remaining: remaining?.n });
    }
    if (path === "/_evidence-publication") {
      const { threadId, runId } = (await req.json()) as { threadId: string; runId: string };
      const bytes = new Uint8Array(1_100_000).fill(37).buffer;
      const store = (key: string) =>
        env.EVIDENCE_STORE.getByName(key) as DurableObjectStub<Evidence>;
      const published = store("published-image"),
        orphan = store("orphan-image"),
        deleted = store("deleted-image");
      await published.put("published-image", bytes, null, true);
      await env.DB.prepare(
        "INSERT INTO artifacts(id,run_id,thread_id,object_key,content_type,expires_at,persistent) VALUES('published-image',?,?,'published-image','image/png',253370764800000,1)",
      )
        .bind(runId, threadId)
        .run();
      await published.expireStaging();
      const retained = await published.get("published-image");
      await published.duplicateAlarm();
      const duplicateSafe =
        (await published.get("published-image"))?.byteLength === bytes.byteLength;
      await orphan.put("orphan-image", bytes, null, true);
      await orphan.expireStaging();
      await deleted.put("deleted-image", bytes, null, true);
      await env.DB.prepare(
        "INSERT INTO ai_threads(id,user_id,kind,model_id,model_version,closed,created_at,updated_at) VALUES('deleted-image-thread','fixture_owner','chat','fixture',1,1,1767225600000,1767225600000)",
      ).run();
      await env.DB.prepare(
        "INSERT INTO artifacts(id,run_id,thread_id,object_key,content_type,expires_at,persistent) VALUES('deleted-image',?,'deleted-image-thread','deleted-image','image/png',253370764800000,1)",
      )
        .bind(runId)
        .run();
      await deleted.expireStaging();
      const retired = await env.DB.prepare(
        "SELECT count(*) n FROM evidence_retirements WHERE object_key IN ('orphan-image','deleted-image')",
      ).first<{ n: number }>();
      const result = {
        retained: retained?.byteLength,
        duplicateSafe,
        orphan: await orphan.get("orphan-image"),
        deleted: await deleted.get("deleted-image"),
        retired: retired?.n,
      };
      await published.remove();
      return Response.json(result);
    }
    if (path === "/_help-init") {
      const { threadId } = (await req.json()) as { threadId: string };
      const task: TaskDefinition = {
        id: "fixture_task",
        version: 1,
        title: "协助暂停恢复",
        goal: "仅读取页面并询问测试码",
        entryUrl: "https://example.com/",
        accountId: null,
        modelId: "fixture",
        modelVersion: 1,
        allowedActions: ["read"],
        verification: { kind: "goal", value: "读取" },
        schedule: { kind: "manual" },
        status: "active",
        createdAt: new Date().toISOString(),
        nextRunAt: null,
      };
      const taskHead = env.DB.prepare(
        "INSERT INTO tasks(id,version,title,schedule_kind,status,created_at,updated_at,user_id) VALUES(?,1,?,'manual',?,?,?,?)",
      ).bind(
        task.id,
        task.title,
        "active",
        Date.parse(task.createdAt),
        Date.parse(task.createdAt),
        "fixture_owner",
      );
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO task_versions(task_id,version,definition,user_id,model_id,model_version) VALUES(?,1,?,'fixture_owner','fixture',1)",
        ).bind(task.id, JSON.stringify(task)),
        taskHead,
      ]);
      await env.DB.prepare("UPDATE ai_threads SET task_id=? WHERE id=?")
        .bind(task.id, threadId)
        .run();
      await enqueue(env.DB, task, "fixture_help");
      const run = await claim(env.DB, "fixture", "fixture_claim");
      return Response.json({ run });
    }
    if (path === "/_help-diagnostics") {
      const row = await env.DB.prepare(
        "SELECT id,status,error FROM ai_graph_inputs WHERE kind='help' LIMIT 1",
      ).first<{ id: string; status: string; error: string | null }>();
      const tuple = row
        ? await new D1Checkpointer(env.DB, "fixture_owner", env.MASTER_KEY).getTuple({
            configurable: { thread_id: row.id },
          })
        : null;
      return Response.json({
        graph: row,
        pendingErrors:
          tuple?.pendingWrites?.filter((w) => w[1] === "__error__").map((w) => w[2]) ?? [],
      });
    }
    if (path === "/_publish") {
      await env.NOTIFICATIONS.getByName("device:fixture").publish();
      return Response.json({ ok: true });
    }
    if (path === "/_draft-socket") {
      return env.NOTIFICATIONS.getByName("user:fixture_owner").fetch(
        new Request("https://notification.internal/", {
          headers: {
            Upgrade: "websocket",
            "x-subscriber": JSON.stringify({
              owner: "fixture_owner",
              session: "draft_session",
              expires: Date.now() + 600000,
              protocol: 2,
            }),
          },
        }),
      );
    }
    if (path === "/_draft") {
      const body = (await req.json()) as { publication: DraftPublication; close?: boolean };
      const hub = env.NOTIFICATIONS.getByName("user:fixture_owner");
      if (body.close) await hub.closeDrafts(body.publication.target.threadId);
      else await hub.publishDraft(body.publication);
      return Response.json({
        drafts: await hub.drafts("fixture_owner", body.publication.target.threadId),
        other: await hub.drafts("other", body.publication.target.threadId),
      });
    }
    return worker.fetch(req, env, ctx);
  },
};

// 只在隔离测试中推进暂存到期时间；业务读写和alarm都使用生产实现。
export class Evidence extends ProductionEvidence {
  async expireStaging() {
    await this.ctx.storage.put("expires", Date.now() - 1);
    await super.alarm();
  }
  async duplicateAlarm() {
    await super.alarm();
  }
}

// Test-only synthetic model adapter. The production jurisdiction path is unchanged.
export class AiTurn extends ProductionAiTurn {
  constructor(ctx: DurableObjectState, env: AppEnv) {
    const model = {
      jurisdiction: () => ({
        getByName: () => ({
          submitAndWait: async (id: string, cipher: string) => {
            const job = await unseal<{
              request: { schema?: { properties?: Record<string, unknown> }; messages: unknown[] };
            }>(cipher, env.MASTER_KEY, `egress:${id}:request`);
            const isHelp = !!job.request.schema?.properties?.askUser;
            const replied = JSON.stringify(job.request.messages).includes(
              "workerd-resume-code-0012",
            );
            const result = isHelp
              ? {
                  message: replied ? "已收到完整回复，继续读取。" : "请提供测试码。",
                  askUser: !replied,
                  accountId: null,
                }
              : {
                  reply: "请提供网站和目标",
                  start: false,
                  title: null,
                  goal: null,
                  entryUrl: null,
                  accountId: null,
                  executionOutline: [],
                };
            return {
              status: "done",
              cipher: await seal(
                { text: JSON.stringify(result), usage: { input: 10, output: 10 }, calls: [] },
                env.MASTER_KEY,
                `egress:${id}:response`,
              ),
            };
          },
          ack: async () => {},
        }),
      }),
    };
    super(ctx, { ...env, MODEL_EGRESS: model as unknown as AppEnv["MODEL_EGRESS"] });
  }
}
