/**
 * 建立云端图的运行作用域：固定输入摘要、图版本及代次，统一提供存储与有效性校验。
 * 运行依赖留在闭包中，检查点只保存业务状态；独立异步上下文防止嵌套调用串用图状态。
 */
import type { AppEnv } from "../env";
import { hash } from "../../../../packages/contracts/src/security";
import { EXECUTION_GRAPH_VERSION } from "../../../../packages/contracts/src/index";
import { D1Checkpointer } from "./checkpointer";
import { assertPrivateAI } from "./privacy";
import { AsyncLocalStorageProviderSingleton } from "@langchain/core/singletons";
import { AsyncLocalStorage } from "node:async_hooks";

// LangGraph's browser/workerd export does not install the Node ALS singleton.
// Workers supports AsyncLocalStorage through nodejs_compat; register it explicitly
// so interrupt() can read its graph task context across D1 and alarm awaits.
AsyncLocalStorageProviderSingleton.initializeGlobalInstance(new AsyncLocalStorage());

export const GRAPH_VERSION = EXECUTION_GRAPH_VERSION;
export interface GraphScope {
  env: AppEnv;
  owner: string;
  id: string;
  threadId: string;
  kind: "chat" | "help";
  turnId?: string;
  runId?: string;
  epoch?: number;
  guard: () => Promise<void>;
}

/** The persisted index fences every graph write; runtime dependencies never enter state. */
export async function openGraph(scope: GraphScope, input: unknown) {
  assertPrivateAI();
  await scope.guard();
  const { env, owner, id } = scope;
  const digest = await hash(JSON.stringify({ version: GRAPH_VERSION, input }));
  await env.DB.prepare(
    `INSERT OR IGNORE INTO ai_graph_inputs
    (owner,id,digest,parent_thread,parent_turn,created_at,graph_version,kind,run_id,lease_epoch)
    SELECT ?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM ai_threads WHERE id=? AND user_id=? AND closed=0)`,
  )
    .bind(
      owner,
      id,
      digest,
      scope.threadId,
      scope.turnId ?? null,
      new Date().toISOString(),
      GRAPH_VERSION,
      scope.kind,
      scope.runId ?? null,
      scope.epoch ?? null,
      scope.threadId,
      owner,
    )
    .run();
  const saved = await env.DB.prepare(
    "SELECT digest,active,graph_version,generation FROM ai_graph_inputs WHERE owner=? AND id=?",
  )
    .bind(owner, id)
    .first<{
      digest: string;
      active: number;
      graph_version: string;
      generation: number;
    }>();
  if (!saved?.active || saved.graph_version !== GRAPH_VERSION) throw Error("GRAPH_VERSION_RETIRED");
  if (saved.digest !== digest) throw Error("GRAPH_INPUT_CONFLICT");
  const generation = saved.generation;
  const guard = async () => {
    await scope.guard();
    if (
      !(await env.DB.prepare(
        "SELECT id FROM ai_graph_inputs WHERE owner=? AND id=? AND active=1 AND generation=? AND graph_version=?",
      )
        .bind(owner, id, generation, GRAPH_VERSION)
        .first())
    )
      throw Error("GRAPH_STALE");
  };
  return {
    guard,
    generation,
    saver: new D1Checkpointer(env.DB, owner, env.MASTER_KEY, guard, true, generation),
    config: {
      configurable: { thread_id: id, checkpoint_ns: "" },
      callbacks: [],
      durability: "sync" as const,
      recursionLimit: Infinity,
    },
    // RPC adapters can execute in-process in tests/local hosts. Never inherit a
    // caller's graph scratchpad and accidentally become its resumable subgraph.
    run: <T>(operation: () => Promise<T>) =>
      AsyncLocalStorageProviderSingleton.runWithConfig(
        { callbacks: [], configurable: {} },
        operation,
        true,
      ),
  };
}
