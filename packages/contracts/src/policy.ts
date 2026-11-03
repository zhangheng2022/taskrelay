import {
  browserActionSchema,
  type BrowserAction,
  type TaskDefinition,
} from "./index";
import { allowedNavigation } from "./security";
export interface TargetFacts {
  tag: string;
  type: string;
  text: string;
  href: string | null;
  formDigest?: string;
}
const highImpact =
  /支付|付款|转账|购买|下单|订阅|删除|注销|销毁|退款|提现|pay|purchase|checkout|subscribe|delete|remove|transfer|withdraw/i;
export function actionPolicy(
  task: TaskDefinition,
  input: BrowserAction,
  pageUrl: string,
  facts?: TargetFacts,
): { action: BrowserAction; write: boolean; approval: boolean } {
  const action = browserActionSchema.parse(input);
  allowedNavigation(pageUrl, task.allowedOrigins);
  if (action.kind === "navigate") {
    if (!task.allowedActions.includes("navigate") || !action.target)
      throw new Error("NAVIGATION_NOT_AUTHORIZED");
    allowedNavigation(action.target, task.allowedOrigins);
  }
  if (
    ["fill", "credential"].includes(action.kind) &&
    !task.allowedActions.includes("fill")
  )
    throw new Error("FILL_NOT_AUTHORIZED");
  let write = false,
    approval = false;
  if (action.kind === "click") {
    if (!facts) throw new Error("TARGET_INSPECTION_REQUIRED");
    const link = facts.tag === "A" && facts.href;
    if (link) {
      allowedNavigation(facts.href!, task.allowedOrigins);
      if (!task.allowedActions.includes("navigate"))
        throw new Error("NAVIGATION_NOT_AUTHORIZED");
    }
    write = true; // Unspecified buttons can submit. Never trust a model's "read" label.
    approval =
      highImpact.test(`${facts.text} ${action.instruction}`) ||
      action.effect === "high_impact";
    if (
      write &&
      !approval &&
      !task.allowedActions.includes("submit") &&
      !task.allowedActions.includes("publish")
    )
      throw new Error("SUBMIT_NOT_AUTHORIZED");
  }
  if (action.effect === "publish" && !task.allowedActions.includes("publish"))
    throw new Error("PUBLISH_NOT_AUTHORIZED");
  if (["fill", "credential"].includes(action.kind) && !action.target)
    throw new Error("TARGET_REQUIRED");
  // Filling may trigger autosave; treat it as potentially mutating for crash recovery too.
  write ||= ["fill", "credential"].includes(action.kind);
  return { action, write, approval };
}
export function verifyPage(
  kind: string,
  value: string,
  page: { url: string; text: string },
) {
  if (kind === "text_present") return page.text.includes(value);
  if (kind === "text_absent")
    return page.text.length > 0 && !page.text.includes(value);
  if (kind === "url") return page.url === value;
  if (kind === "extraction") return page.text.includes(value);
  return false;
}
