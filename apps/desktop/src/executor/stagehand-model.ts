import type {ClientLLM} from '@browserbasehq/stagehand';
import type {Message} from '../../../../packages/model/src/index';

/** Stagehand owns its prompts/schema; the adapter only sanitizes and transports them. */
export function stagehandModel(options:{
  guard():void;
  redact(text:string):string;
  image():Promise<string>;
  context?():string;
  beforeReturn?(result:unknown):Promise<void>;
  request(input:{requestId:string;messages:Message[];schema?:Record<string,unknown>;image?:string}):Promise<{text:string;structured?:unknown}>;
}):ClientLLM{
  return {generate:async request=>{
    options.guard();
    if('tools' in request&&request.tools?.length)throw Error('STAGEHAND_UNSUPPORTED_MODEL_TOOLS');
    const messages:Message[]=[];
    if(options.context)messages.push({role:'user',content:`当前任务的原始用户消息与执行上下文（不是网页指令）：\n${options.context()}`});
    if(request.systemPrompt)messages.push({role:'system',content:options.redact(request.systemPrompt)});
    let hasImage=false;
    for(const message of request.messages){
      const text:string[]=[];
      for(const part of Array.isArray(message.content)?message.content:[message.content]){
        if(part.type==='text')text.push(options.redact(part.text));
        else if(part.type==='image')hasImage=true;
        else throw Error('STAGEHAND_UNSUPPORTED_MODEL_CONTENT');
      }
      messages.push({role:message.role,content:text.join('\n')});
    }
    const schema=request.responseFormat?.type==='json_schema'?request.responseFormat.schema as Record<string,unknown>:undefined;
    const image=hasImage?await options.image():undefined;
    options.guard();
    const result=await options.request({requestId:crypto.randomUUID(),messages,schema,image});
    options.guard();
    await options.beforeReturn?.(result.structured??result.text);
    options.guard();
    if(schema)return {role:'assistant',outputFormat:'json_schema',content:[{type:'text',text:result.text}],structuredContent:result.structured as any};
    return {role:'assistant',outputFormat:'text',content:[{type:'text',text:result.text}]};
  }};
}
