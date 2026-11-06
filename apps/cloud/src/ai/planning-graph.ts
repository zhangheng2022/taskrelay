/**
 * 交办图按“理解意图 → 可选任务交接 → 回复”推进；明确交办时产出可调整的大步骤。
 * 检查点保存图状态，命令模块承担任务交接的幂等性，不在此规划页面控件操作。
 */
import { Annotation, StateGraph, START, END } from "@langchain/langgraph";
import { z } from "zod";
import type { Message } from "../../../../packages/model/src/index";
import type { Row } from "../store";
import { compactMessages } from "../model-context";
import { commitDecision } from "./commands";
import { GRAPH_VERSION, openGraph, type GraphScope } from "./graph";
import { RelayChatModel } from "./model";
import { toLangChainMessages } from "../../../../packages/model/src/langchain";

const decisionSchema = z.object({
  reply: z.string(),
  start: z.boolean(),
  title: z.string().nullable(),
  goal: z.string().nullable(),
  entryUrl: z.string().nullable(),
  accountId: z.string().nullable(),
  accountIds: z.array(z.string()).default([]),
  executionOutline: z.array(z.string().min(1)),
});
type Decision = z.infer<typeof decisionSchema>;
const State = Annotation.Root({
  messages: Annotation<Message[]>(),
  decision: Annotation<Decision>(),
  reply: Annotation<string>(),
});

/** A handoff is a graph branch with its own durable, idempotent outbox effect. */
export async function planConversation(
  scope: GraphScope,
  thread: Row,
  messages: Message[],
) {
  const { env, id } = scope;
  const runtime = await openGraph(scope, {
    modelId: thread.model_id,
    version: thread.model_version,
    messages,
  });
  const graph = new StateGraph(State)
    .addNode("understand", async (state) => {
      await runtime.guard();
      const input = await compactMessages(
        env,
        thread.model_id,
        thread.model_version,
        state.messages,
        null,
        id,
        runtime.guard,
        { id, generation: runtime.generation },
      );
      const model = new RelayChatModel(
        env,
        thread.model_id,
        thread.model_version,
        `${id}:understand:${GRAPH_VERSION}`,
        null,
        id,
        runtime.generation,
      );
      const decision = await model
        .withStructuredOutput<Decision>(decisionSchema)
        .invoke(toLangChainMessages(input));
      await runtime.guard();
      if (
        decision.start &&
        (!decision.goal ||
          !decision.entryUrl ||
          !decision.executionOutline.length)
      )
        throw Error("HANDOFF_INCOMPLETE");
      return { decision };
    })
    .addNode("handoff", async (state) => {
      await runtime.guard();
      const d = state.decision;
      await commitDecision(
        env,
        thread,
        id,
        {
          title: d.title ?? d.goal!.slice(0, 100),
          goal: d.goal!,
          entryUrl: d.entryUrl!,
          accountId: d.accountId,
          allowedActions: ["read", "navigate", "fill", "submit", "publish"],
          verification: { kind: "goal", value: d.goal!.slice(0, 2000) },
          schedule: { kind: "manual" },
        },
        { executionOutline: d.executionOutline, graphVersion: GRAPH_VERSION, accountIds:d.accountIds },
      );
      return {};
    })
    .addNode("respond", (state) => ({
      reply: state.decision.start
        ? `${state.decision.reply}\n\n执行步骤（可随时在聊天中调整）：\n${state.decision.executionOutline.map((step, i) => `${i + 1}. ${step}`).join("\n")}`
        : state.decision.reply,
    }))
    .addEdge(START, "understand")
    .addConditionalEdges(
      "understand",
      (state) => (state.decision.start ? "handoff" : "respond"),
      ["handoff", "respond"],
    )
    .addEdge("handoff", "respond")
    .addEdge("respond", END)
    .compile({ checkpointer: runtime.saver });
  const prior = await runtime.saver.getTuple(runtime.config);
  return runtime.run(() =>
    graph.invoke(prior ? null : { messages }, runtime.config),
  );
}
