import { assertPrivateAI } from "./privacy";
import { jsonSchema } from "./schema";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { z } from "zod";
import type { AppEnv } from "../env";
import { generateStructured, invoke } from "../models";
import type { Inference } from "../../../../packages/model/src/index";

export class RelayChatModel extends BaseChatModel {
  lc_serializable = false;
  constructor(
    private env: AppEnv,
    private modelId: string,
    private version: number,
    private operationId: string,
    private runId: string | null = null,
    private graphId?: string,
  ) {
    super({ maxRetries: 0, disableStreaming: true });
    assertPrivateAI();
  }
  _llmType() {
    return "taskrelay-us-egress";
  }
  private messages(messages: BaseMessage[]): Inference["messages"] {
    return messages.map((m) => {
      const type = m.type;
      if (
        typeof m.content !== "string" ||
        !["system", "human", "ai"].includes(type)
      )
        throw new Error("MODEL_MODALITY_UNSUPPORTED");
      return {
        role:
          type === "human" ? "user" : type === "ai" ? "assistant" : "system",
        content: m.content,
      };
    });
  }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const response = await invoke(
      this.env,
      this.modelId,
      this.version,
      { messages: this.messages(messages) },
      this.runId,
      this.operationId,
      this.graphId,
    );
    return {
      generations: [
        {
          text: response.text,
          message: new AIMessage({
            content: response.text,
            response_metadata: { usage: response.usage },
          }),
        },
      ],
    };
  }
  async structured<T>(
    schema: z.ZodType<T>,
    messages: Inference["messages"],
  ): Promise<T> {
    return (
      await generateStructured(
        this.env,
        this.modelId,
        this.version,
        jsonSchema(schema),
        (v) => schema.parse(v),
        messages,
        this.runId,
        "MODEL_INVALID_JSON",
        this.operationId,
        this.graphId,
      )
    ).data;
  }
}
