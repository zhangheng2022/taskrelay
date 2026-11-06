import { z } from "zod";

/** 执行工具的唯一参数来源。模型 Schema 与本机运行校验从同一 Zod 定义生成；
 * 它描述浏览器机制，不包含业务完成门槛或任意脚本能力。 */
const schemas = {
  act: z.object({ instruction: z.string().min(1) }),
  observe: z.object({ instruction: z.string() }),
  extract: z.object({ instruction: z.string() }),
  navigate: z.object({ url: z.url() }),
  switchPage: z.object({ index: z.number().int().nonnegative() }),
  wait: z.object({}),
  screenshot: z.object({}),
  ask: z.object({ message: z.string().min(1) }),
  offerAccountSave: z.object({
    name: z.string().min(1).max(80),
    username: z.string().max(200),
    password: z.string().max(2000),
    loginOrigins: z.array(z.url()).min(1).max(20),
    evidence: z.string().min(1).max(2000),
  }),
  requestAccountUpdate: z.object({ evidence: z.string().min(1).max(2000) }),
  confirmAccountLogin: z.object({ evidence: z.string().min(1).max(2000) }),
};
const descriptions = {
  act: "让 Stagehand 根据当前页面执行一个自然语言操作。它会收到同一任务的原始用户消息。",
  observe: "让 Stagehand 查找当前页面可操作的控件。",
  extract: "让 Stagehand 读取当前页面信息，不拍摄聊天截图。",
  screenshot: "用户明确需要查看当前页面时，保存一张脱敏截图到聊天。常规读取和操作无需调用。",
  navigate: "打开任务相关的公开 HTTPS 页面。",
  switchPage: "切换到当前页面列表中的标签。",
  wait: "等待页面变化后重新观察。",
  ask: "向云端求助。云端先查已有信息，必要时在同一聊天询问用户，原始回复交回执行器。",
  offerAccountSave:
    "本次实际提交用户提供的账号密码且页面明确登录成功后，发送待用户确认的保存账号卡片。已有会话不证明密码正确；不要在普通文字复述密码。",
  requestAccountUpdate:
    "当前绑定账号的凭据实际被网站拒绝时，发送修改卡片并等待用户。会话过期、验证码或设备验证不表示密码错误。",
  confirmAccountLogin:
    "使用当前绑定账号这一版凭据实际完成登录后，记录凭据验证成功。不能仅因为原会话仍有效就调用。",
} satisfies Record<keyof typeof schemas, string>;
export const executorArguments = schemas;
export const executorTools = Object.entries(schemas).map(([name, schema]) => {
  const { $schema, ...parameters } = z.toJSONSchema(schema);
  return { name, description: descriptions[name as keyof typeof schemas], parameters };
});
export type ChatPart =
  | { type: "image"; artifactId: string; alt: string }
  | { type: "tool"; name: string; result: string }
  | { type: "account-card"; cardId: string; kind?: "save" | "update" };
export interface ExecutionHelp {
  id: string;
  message: string;
  origin: string;
  cardId?: string;
  userSeq?: number;
}
export interface HelpResponse {
  ready: boolean;
  message?: string;
  accountId?: string;
  questionRound?: number;
}
