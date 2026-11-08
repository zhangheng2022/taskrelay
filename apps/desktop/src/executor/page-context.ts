/** 模型现场的无损去重：标签页引用本对象已出现的网址，当前现场可引用同次消息中的完整工具现场。
 * 浏览器保留原始 URL；这里只创建展示副本，不登记动作、不判断成功、不保存跨请求引用或隐藏历史。 */
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";

export const pageContextGuide =
  "页面 tabs 的 urlRef=current 指该对象的 url，urlRef=tab:N 指同一 tabs 中 index=N 的完整 url。untrustedPage 若为 source=tool-result，则完整现场在同次消息中 tool_call_id=toolCallId 的工具结果里，field=observation 指该字段，field=$ 指整个结果；引用只表示数据相同，不证明业务成功。";

/** 仅对逐字相等的 URL 建引用，保留不同参数、片段、标签页索引和全部其他现场字段。 */
export function compactPageUrls<T extends { url: string; tabs: { index: number; url: string }[] }>(
  snapshot: T,
): Omit<T, "tabs"> & {
  tabs: Array<{ index: number; url: string } | { index: number; urlRef: string }>;
} {
  const seen = new Map<string, string>([[snapshot.url, "current"]]);
  return {
    ...snapshot,
    tabs: snapshot.tabs.map((tab) => {
      const urlRef = seen.get(tab.url);
      if (urlRef !== undefined) {
        const { url: _url, ...rest } = tab;
        return { ...rest, urlRef };
      }
      seen.set(tab.url, `tab:${tab.index}`);
      return { ...tab };
    }),
  };
}

function record(content: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(content);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      return parsed as Record<string, unknown>;
  } catch {
    // 普通文本、未知格式和框架摘要保持原样。
  }
}
function isPageSnapshot(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const object = value as Record<string, unknown>;
  return (
    typeof object.url === "string" &&
    typeof object.title === "string" &&
    Array.isArray(object.tabs) &&
    Object.hasOwn(object, "loading")
  );
}

/** 每次以实际待发送的历史重新解析引用。摘要移走目标、页面改变或观察失败时回退到完整当前现场。
 * 不修改 Agent 的消息、工具结果或用户原文，预算检查与实际决策必须调用同一投影。 */
export function referencePageContext(protectedMessages: BaseMessage[], history: BaseMessage[]) {
  const index = protectedMessages.findLastIndex((m) => m instanceof HumanMessage);
  const message = protectedMessages[index];
  if (!message || typeof message.content !== "string") return protectedMessages;
  const payload = record(message.content);
  if (!payload || !isPageSnapshot(payload.untrustedPage)) return protectedMessages;
  const target = JSON.stringify(payload.untrustedPage);
  const names = new Map<string, string>();
  for (const item of history)
    if (item instanceof AIMessage)
      for (const call of item.tool_calls ?? []) if (call.id) names.set(call.id, call.name);
  for (let position = history.length - 1; position >= 0; position--) {
    const item = history[position];
    if (!(item instanceof ToolMessage) || typeof item.content !== "string") continue;
    const name = names.get(item.tool_call_id);
    const field =
      name === "act" || name === "navigate"
        ? "observation"
        : name === "wait" || name === "switchPage"
          ? "$"
          : undefined;
    if (!field) continue;
    const result = record(item.content);
    const snapshot = field === "$" ? result : result?.observation;
    if (!isPageSnapshot(snapshot) || JSON.stringify(snapshot) !== target) continue;
    const projected = new HumanMessage({
      ...message.toDict().data,
      id: message.id,
      content: JSON.stringify({
        ...payload,
        untrustedPage: { source: "tool-result", toolCallId: item.tool_call_id, field },
      }),
    });
    return protectedMessages.map((value, i) => (i === index ? projected : value));
  }
  return protectedMessages;
}
