import {z} from 'zod';

// These are browser/SDK mechanics, not a task form or a business action plan.
const instruction={type:'object',properties:{instruction:{type:'string'}},required:['instruction'],additionalProperties:false};
export const executorTools=[
  {name:'act',description:'让 Stagehand 根据当前页面执行一个自然语言操作。它会收到同一任务的原始用户消息。',parameters:instruction},
  {name:'observe',description:'让 Stagehand 查找当前页面可操作的控件。',parameters:instruction},
  {name:'extract',description:'让 Stagehand 读取当前页面信息。截图会自动进入聊天，不需要用此工具拍照。',parameters:instruction},
  {name:'navigate',description:'打开任务相关的公开 HTTPS 页面。',parameters:{type:'object',properties:{url:{type:'string'}},required:['url'],additionalProperties:false}},
  {name:'switchPage',description:'切换到当前页面列表中的标签。',parameters:{type:'object',properties:{index:{type:'integer'}},required:['index'],additionalProperties:false}},
  {name:'wait',description:'等待页面变化后重新观察。',parameters:{type:'object',properties:{},required:[],additionalProperties:false}},
  {name:'ask',description:'向云端求助。云端先查已有信息，必要时在同一聊天询问用户，原始回复交回执行器。',parameters:{type:'object',properties:{message:{type:'string'}},required:['message'],additionalProperties:false}},
];
export const executorArguments={
  act:z.object({instruction:z.string().min(1)}),observe:z.object({instruction:z.string()}),extract:z.object({instruction:z.string()}),
  navigate:z.object({url:z.url()}),switchPage:z.object({index:z.number().int().nonnegative()}),wait:z.object({}),ask:z.object({message:z.string().min(1)}),
};
export type ChatPart={type:'image';artifactId:string;alt:string}|{type:'tool';name:string;result:string};
export interface ExecutionHelp {id:string;message:string;origin:string;}
export interface HelpResponse {ready:boolean;message?:string;accountId?:string;}
