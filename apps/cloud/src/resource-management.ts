/** 账号与模型的管理状态及受约束删除。条件写与外键在同一事务中裁决并发引用；不删除任务历史。 */
import { Hono } from "hono";
import { validator } from "hono/validator";
import { z } from "zod";
import type { AppEnv, Variables } from "./env";
import { dbTime } from "./database";
import { notifyUser } from "./notifications";
import { appendMessage } from "./chat-messages";

const versionInput = z.object({ expectedVersion: z.number().int().positive() }).strict();
const stateInput = versionInput.extend({ enabled: z.boolean() });
function routes(kind: "accounts" | "models") {
  const app = new Hono<{ Bindings: AppEnv; Variables: Variables }>();
  return app
    .put(
      "/:id/state",
      validator("json", (v: z.input<typeof stateInput>) => stateInput.parse(v)),
      async (c) => {
        const { enabled, expectedVersion } = c.req.valid("json");
        const id = c.req.param("id");
        const token = crypto.randomUUID();
        const update = c.env.DB.prepare(
          `UPDATE ${kind} SET enabled=?,management_token=?,management_version=management_version+1 WHERE id=? AND management_version=? ${kind === "accounts" ? "AND user_id=?" : "AND owner_user_id IS NULL AND EXISTS(SELECT 1 FROM model_profile_versions v WHERE v.id=models.id AND v.version=models.current_version AND v.connection_id IS NOT NULL AND json_extract(v.config,'$.protocol')='responses')"}`,
        ).bind(
          Number(enabled),
          token,
          id,
          expectedVersion,
          ...(kind === "accounts" ? [c.get("userId")] : []),
        );
        const at = dbTime(Date.now());
        const statements = [update];
        if (!enabled) {
          const gate = `EXISTS(SELECT 1 FROM ${kind} WHERE id=? AND enabled=0 AND management_token=?)`;
          const matches = (json: string) =>
            kind === "models"
              ? `json_extract(${json},'$.modelId')=?`
              : `(json_extract(${json},'$.accountId')=? OR EXISTS(SELECT 1 FROM json_each(${json},'$.accountIds') WHERE value=?))`;
          const matchArgs = kind === "models" ? [id] : [id, id];
          const targets = `SELECT r.id FROM runs r JOIN run_snapshots s ON s.run_id=r.id WHERE r.status IN ('queued','running','waiting_user','verifying') AND (${kind === "accounts" ? "r.account_id=? OR " : ""}${matches("s.task_snapshot")} OR r.dispatch_group_id IN(SELECT c.id FROM conversation_commands c WHERE c.run_task IS NOT NULL AND ${matches("c.run_task")})) AND ${gate}`;
          const args = [
            ...(kind === "accounts" ? [id] : []),
            ...matchArgs,
            ...matchArgs,
            id,
            token,
          ];
          const code = kind === "models" ? "MODEL_DISABLED" : "ACCOUNT_DISABLED";
          statements.push(
            c.env.DB.prepare(
              `INSERT OR IGNORE INTO run_results(run_id,result) SELECT id,json_object('summary',?,'outcome','unconfirmed','evidence',json('[]'),'errorCode',?) FROM runs WHERE id IN(${targets})`,
            ).bind("资源已停用，任务已失败；已发出的操作请核查实际结果。", code, ...args),
            c.env.DB.prepare(
              `UPDATE runs SET status='failed',cancel_requested=1,lease_expires_at=NULL,updated_at=? WHERE id IN(${targets}) RETURNING id,user_id,thread_id,device_id`,
            ).bind(at, ...args),
            c.env.DB.prepare(
              `UPDATE execution_help SET awaiting_user=0 WHERE run_id IN(SELECT run_id FROM run_results WHERE json_extract(result,'$.errorCode')=?)`,
            ).bind(code),
            c.env.DB.prepare(
              `UPDATE account_dispatch_groups SET state='cancelled',updated_at=? WHERE state IN ('active','paused') AND id IN(SELECT id FROM conversation_commands WHERE run_task IS NOT NULL AND ${matches("run_task")}) AND ${gate}`,
            ).bind(at, ...matchArgs, id, token),
            c.env.DB.prepare(
              `UPDATE tasks SET status='paused',next_run_at=NULL WHERE id IN(SELECT v.task_id FROM task_versions v JOIN tasks t ON t.id=v.task_id AND t.version=v.version WHERE ${matches("v.definition")}) AND ${gate}`,
            ).bind(...matchArgs, id, token),
            c.env.DB.prepare(
              `UPDATE conversation_commands SET state='done',run_task=NULL WHERE state IN ('pending','committed') AND run_task IS NOT NULL AND ${matches("run_task")} AND ${gate}`,
            ).bind(...matchArgs, id, token),
          );
          // 模型停用也退休尚在规划的交办；恢复模型不能让旧回合迟到创建任务。
          if (kind === "models") {
            const threads = `SELECT id FROM ai_threads WHERE model_id=? AND active_turn IS NOT NULL AND ${gate}`;
            statements.push(
              c.env.DB.prepare(
                `UPDATE ai_graph_inputs SET active=0,generation=generation+1,status='cancelled' WHERE parent_thread IN(${threads}) AND active=1`,
              ).bind(id, id, token),
              c.env.DB.prepare(
                `UPDATE ai_turns SET status='failed',error='MODEL_DISABLED',updated_at=? WHERE status='running' AND thread_id IN(${threads})`,
              ).bind(at, id, id, token),
              c.env.DB.prepare(
                `UPDATE conversation_inbox SET status='failed' WHERE status IN ('queued','processing') AND thread_id IN(${threads})`,
              ).bind(id, id, token),
              c.env.DB.prepare(
                `UPDATE ai_threads SET active_turn=NULL,version=version+1 WHERE id IN(${threads})`,
              ).bind(id, id, token),
            );
          }
        }
        const results = await c.env.DB.batch(statements);
        if (!results[0].meta.changes) return c.json({ error: "RESOURCE_VERSION_CONFLICT" }, 409);
        if (!enabled) {
          const stopped = results[2].results as {
            id: string;
            user_id: string;
            thread_id: string | null;
            device_id: string | null;
          }[];
          for (const run of stopped) {
            if (run.thread_id)
              await appendMessage(c.env, run.thread_id, {
                id: `resource_disabled_${run.id}`,
                runId: run.id,
                source: "cloud",
                content: "资源已停用，任务已失败。已发出的操作不会自动重试，请核查实际结果。",
              }).catch(() => {});
            await notifyUser(c.env, run.user_id);
            if (run.device_id && c.env.NOTIFICATIONS)
              await c.env.NOTIFICATIONS.getByName("device:" + run.device_id)
                .publish()
                .catch(() => {});
          }
        }
        return c.json({ ok: true });
      },
    )
    .delete(
      "/:id",
      validator("json", (v: z.input<typeof versionInput>) => versionInput.parse(v)),
      async (c) => {
        const id = c.req.param("id"),
          { expectedVersion } = c.req.valid("json");
        if (kind === "models") {
          try {
            const removed = await c.env.DB.prepare(
              `UPDATE models SET enabled=0,deleted_at=?,management_version=management_version+1
               WHERE id=? AND management_version=? AND owner_user_id IS NULL AND deleted_at IS NULL
               AND EXISTS(SELECT 1 FROM model_profile_versions v WHERE v.id=models.id AND v.version=models.current_version AND v.connection_id IS NOT NULL)
               RETURNING id`,
            )
              .bind(dbTime(Date.now()), id, expectedVersion)
              .first();
            if (!removed) return c.json({ error: "RESOURCE_VERSION_CONFLICT" }, 409);
            return c.json({ ok: true });
          } catch (error) {
            if (String(error).includes("MODEL_DISABLE_BEFORE_DELETE"))
              return c.json({ error: "MODEL_DISABLE_BEFORE_DELETE" }, 409);
            throw error;
          }
        }
        const args = [id, expectedVersion, c.get("userId")];
        const row = await c.env.DB.prepare(
          "SELECT id FROM accounts WHERE id=? AND management_version=? AND user_id=?",
        )
          .bind(...args)
          .first();
        if (!row) return c.json({ error: "RESOURCE_VERSION_CONFLICT" }, 409);
        // 账号的任务、登录态和锁仍按原归属检查；新出现的引用由同一事务与外键裁决。
        const eligible = `SELECT id FROM accounts WHERE id=? AND management_version=? AND user_id=?
          AND NOT EXISTS(SELECT 1 FROM task_versions t WHERE json_extract(t.definition,'$.accountId')=accounts.id OR EXISTS(SELECT 1 FROM json_each(t.definition,'$.accountIds') WHERE value=accounts.id))
          AND NOT EXISTS(SELECT 1 FROM runs WHERE account_id=accounts.id)
          AND NOT EXISTS(SELECT 1 FROM account_dispatch_members WHERE account_id=accounts.id)
          AND NOT EXISTS(SELECT 1 FROM account_cards WHERE account_id=accounts.id OR result_account_id=accounts.id)
          AND NOT EXISTS(SELECT 1 FROM account_locks WHERE account_key=accounts.id)
          AND state_object_key IS NULL AND previous_state_object_key IS NULL
          AND NOT EXISTS(SELECT 1 FROM browser_state_candidates WHERE account_id=accounts.id)`;
        try {
          const results = await c.env.DB.batch([
            // 延迟外键允许在同一事务删除版本和空资源；其他引用存在时整笔回滚。
            c.env.DB.prepare(
              `DELETE FROM account_credential_versions WHERE account_id IN(${eligible})`,
            ).bind(...args),
            c.env.DB.prepare(`DELETE FROM accounts WHERE id IN(${eligible})`).bind(...args),
          ]);
          if (!results[1].meta.changes) return c.json({ error: "RESOURCE_IN_USE" }, 409);
        } catch (error) {
          if (/FOREIGN KEY|constraint/i.test(String(error)))
            return c.json({ error: "RESOURCE_IN_USE" }, 409);
          throw error;
        }
        return c.json({ ok: true });
      },
    );
}
export const accountManagement = routes("accounts");
export const modelManagement = routes("models");
