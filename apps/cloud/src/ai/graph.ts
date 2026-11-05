import { assertPrivateAI } from "./privacy";
import { jsonSchema } from "./schema";
import { Annotation, StateGraph, START, END } from "@langchain/langgraph";
import { z } from "zod";
import type { AppEnv } from "../env";
import type { Inference } from "../../../../packages/model/src/index";
import { RelayChatModel } from "./model";
import { D1Checkpointer } from "./checkpointer";
import { D1MemoryStore } from "./memory";
import { hash } from "../../../../packages/contracts/src/security";

export const GRAPH_VERSION = "relay-2";
const State = Annotation.Root({
  output: Annotation<unknown>({ reducer: (_, v) => v, default: () => null }),
});
/** Runtime dependencies and raw page/challenge inputs stay outside persisted graph state. */
export async function structuredGraph<T>(args: {
  env: AppEnv;
  owner: string;
  id: string;
  kind: "chat";
  modelId: string;
  version: number;
  schema: z.ZodType<T>;
  messages: Inference["messages"];
  runId?: string;
  guard?: () => Promise<void>;
  threadFence?: { id: string; version: number; turnId: string };
}) {
  assertPrivateAI();
  const { env, owner, id, kind, modelId, version, schema, messages, runId } =
    args;
  const guard = args.guard ?? (async () => {});
  await guard();
  // UTF-8 bytes are not model tokens. The caller compacts its context; the
  // configured provider determines whether the resulting request fits its
  // tokenizer and actual context window. Do not reject pages by a byte guess.
  const digest = await hash(
    JSON.stringify({
      kind,
      modelId,
      version,
      messages,
      runId: runId ?? null,
      graph: GRAPH_VERSION,
      schema:jsonSchema(schema),
    }),
  );
  const fence = args.threadFence;
  await env.DB.prepare(
    `INSERT OR IGNORE INTO ai_graph_inputs(owner,id,digest,parent_thread,parent_turn,created_at) SELECT ?,?,?,?,?,? ${fence ? "WHERE EXISTS(SELECT 1 FROM ai_threads WHERE id=? AND user_id=? AND version=? AND active_turn=? AND closed=0)" : ""}`,
  )
    .bind(
      owner,
      id,
      digest,
      fence?.id ?? null,
      fence?.turnId ?? null,
      new Date().toISOString(),
      ...(fence ? [fence.id, owner, fence.version, fence.turnId] : []),
    )
    .run();
  const saved = await env.DB.prepare(
    "SELECT digest,active FROM ai_graph_inputs WHERE owner=? AND id=?",
  )
    .bind(owner, id)
    .first<{ digest: string; active: number }>();
  if (!saved?.active) throw new Error("TURN_STALE");
  if (saved.digest !== digest) throw new Error("GRAPH_INPUT_CONFLICT");
  const saver = new D1Checkpointer(env.DB, owner, env.MASTER_KEY, guard, true);
  const model = new RelayChatModel(
    env,
    modelId,
    version,
    `${id}:${kind}:${GRAPH_VERSION}`,
    runId ?? null,
    id,
  );
  const graph = new StateGraph(State)
    .addNode("generate", async () => {
      // Keep the fence at the actual side-effect boundary. Empty check/validate
      // nodes created extra checkpoints without adding another external action.
      await guard();
      const output = await model.structured(schema, messages);
      await guard();
      return { output };
    })
    .addEdge(START, "generate")
    .addEdge("generate", END)
    .compile({
      checkpointer: saver,
      store: new D1MemoryStore(env.DB, owner, env.MASTER_KEY),
    });
  const config = {
    configurable: { thread_id: id, checkpoint_ns: "" },
    recursionLimit: 6,
    callbacks: [],
  };
  const prior = await saver.getTuple(config);
  const result = await graph.invoke(prior ? null : { output: null }, {
    ...config,
    durability: "sync",
  });
  return schema.parse(result.output);
}
