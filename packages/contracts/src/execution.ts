import {z} from 'zod';

// These are browser/SDK mechanics, not a task form or a business action plan.
const instruction={type:'object',properties:{instruction:{type:'string'}},required:['instruction'],additionalProperties:false};
export const executorTools=[
  {name:'act',description:'让 Stagehand 根据当前页面执行一个自然语言操作。它会收到同一任务的原始用户消息。',parameters:instruction},
  {name:'observe',description:'让 Stagehand 查找当前页面可操作的控件。',parameters:instruction},
  {name:'extract',description:'让 Stagehand 读取当前页面信息，不拍摄聊天截图。',parameters:instruction},
  {name:'screenshot',description:'用户明确需要查看当前页面时，保存一张脱敏截图到聊天。常规读取和操作无需调用。',parameters:{type:'object',properties:{},required:[],additionalProperties:false}},
  {name:'navigate',description:'打开任务相关的公开 HTTPS 页面。',parameters:{type:'object',properties:{url:{type:'string'}},required:['url'],additionalProperties:false}},
  {name:'switchPage',description:'切换到当前页面列表中的标签。',parameters:{type:'object',properties:{index:{type:'integer'}},required:['index'],additionalProperties:false}},
  {name:'wait',description:'等待页面变化后重新观察。',parameters:{type:'object',properties:{},required:[],additionalProperties:false}},
  {name:'ask',description:'向云端求助。云端先查已有信息，必要时在同一聊天询问用户，原始回复交回执行器。',parameters:{type:'object',properties:{message:{type:'string'}},required:['message'],additionalProperties:false}},
  {name:'offerAccountSave',description:'本次实际提交用户提供的账号密码且页面明确登录成功后，发送待用户确认的保存账号卡片。已有会话不证明密码正确；不要在普通文字复述密码。',parameters:{type:'object',properties:{name:{type:'string'},username:{type:'string'},password:{type:'string'},loginOrigins:{type:'array',items:{type:'string'}},evidence:{type:'string'}},required:['name','username','password','loginOrigins','evidence'],additionalProperties:false}},
  {name:'requestAccountUpdate',description:'当前绑定账号的凭据实际被网站拒绝时，发送修改卡片并等待用户。会话过期、验证码或设备验证不表示密码错误。',parameters:{type:'object',properties:{evidence:{type:'string'}},required:['evidence'],additionalProperties:false}},
  {name:'confirmAccountLogin',description:'使用当前绑定账号这一版凭据实际完成登录后，记录凭据验证成功。不能仅因为原会话仍有效就调用。',parameters:{type:'object',properties:{evidence:{type:'string'}},required:['evidence'],additionalProperties:false}},
];
export const executorArguments={
  act:z.object({instruction:z.string().min(1)}),observe:z.object({instruction:z.string()}),extract:z.object({instruction:z.string()}),
  navigate:z.object({url:z.url()}),switchPage:z.object({index:z.number().int().nonnegative()}),wait:z.object({}),screenshot:z.object({}),ask:z.object({message:z.string().min(1)}),
  offerAccountSave:z.object({name:z.string().min(1).max(80),username:z.string().max(200),password:z.string().max(2000),loginOrigins:z.array(z.url()).min(1).max(20),evidence:z.string().min(1).max(2000)}),
  requestAccountUpdate:z.object({evidence:z.string().min(1).max(2000)}),confirmAccountLogin:z.object({evidence:z.string().min(1).max(2000)}),
};
export type ChatPart={type:'image';artifactId:string;alt:string}|{type:'tool';name:string;result:string}|{type:'account-card';cardId:string;kind?:'save'|'update'};
export interface ExecutionHelp {id:string;message:string;origin:string;cardId?:string;userSeq?:number;}
export interface HelpResponse {ready:boolean;message?:string;accountId?:string;questionRound?:number;}
