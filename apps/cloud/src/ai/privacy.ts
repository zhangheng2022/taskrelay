import { getEnvironmentVariable } from "@langchain/core/utils/env";

/** Deployment configuration cannot silently enable a second outbound data path. */
export function assertPrivateAI() {
  for (const name of [
    "LANGSMITH_TRACING",
    "LANGCHAIN_TRACING_V2",
    "LANGCHAIN_TRACING",
    "LANGCHAIN_VERBOSE",
  ]) {
    const value = getEnvironmentVariable(name);
    if (value && value !== "false" && value !== "0")
      throw new Error("AI_EXTERNAL_TRACING_DISABLED");
  }
}
