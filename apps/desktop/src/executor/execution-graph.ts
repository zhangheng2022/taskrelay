import {Annotation,Command,END,START,StateGraph,interrupt} from '@langchain/langgraph';
import {AIMessage,ToolMessage,type BaseMessage} from '@langchain/core/messages';
import {tool} from '@langchain/core/tools';
import {getEnvironmentVariable} from '@langchain/core/utils/env';
import {z} from 'zod';
import type {Message,ModelResponse} from '../../../../packages/model/src/index';
import {fromLangChainMessages,modelResponseToAIMessage} from '../../../../packages/model/src/langchain';
import {executorArguments,executorTools,type ExecutionHelp,type HelpResponse} from '../../../../packages/contracts/src/execution';
import {SessionCheckpointer} from './session-checkpointer';

export type ExecutorCall=ModelResponse['calls'][number];
export interface ExecutionGraphPort {
  guard():void;
  observe():Promise<{messages:Message[];userSeq:number}>;
  decide(messages:Message[]):Promise<{response:ModelResponse;compacted:boolean}>;
  changed(userSeq:number):Promise<boolean>;
  perform(call:ExecutorCall,args:Record<string,unknown>,userSeq:number):Promise<unknown>;
  registerHelp(args:Record<string,unknown>,call:ExecutorCall):Promise<{request:ExecutionHelp;answer:HelpResponse}>;
  pollHelp(request:ExecutionHelp):Promise<HelpResponse>;
  consumeHelp(request:ExecutionHelp,answer:HelpResponse):Promise<unknown>;
  record(call:ExecutorCall,result:unknown):void;
  error(call:ExecutorCall,error:Error):Promise<void>;
  say(text:string,eventId:string):Promise<unknown>;
  finish(text:string,userSeq:number):Promise<boolean>;
}
const State=Annotation.Root({
  input:Annotation<Message[]>({reducer:(_,v)=>v,default:()=>[]}),
  transcript:Annotation<BaseMessage[]>({reducer:(_,v)=>v,default:()=>[]}),
  calls:Annotation<ExecutorCall[]>({reducer:(_,v)=>v,default:()=>[]}),
  index:Annotation<number>({reducer:(_,v)=>v,default:()=>0}),
  userSeq:Annotation<number>({reducer:(_,v)=>v,default:()=>0}),
  text:Annotation<string>({reducer:(_,v)=>v,default:()=>''}),
  route:Annotation<'observe'|'dispatch'|'finish'|'registerHelp'|'tools'|'awaitHelp'|'consumeHelp'|'feedback'>({reducer:(_,v)=>v,default:()=> 'observe'}),
  result:Annotation<unknown>(),
  help:Annotation<ExecutionHelp|null>({reducer:(_,v)=>v,default:()=>null}),
  answer:Annotation<HelpResponse|null>({reducer:(_,v)=>v,default:()=>null}),
});
const resultMessage=(call:ExecutorCall,result:unknown)=>new ToolMessage({tool_call_id:call.id,name:call.name,content:JSON.stringify(result)??'null'});

/** LC validates every browser tool at the same seam used by the graph. */
async function invokeTool(call:ExecutorCall,perform:(args:Record<string,unknown>)=>Promise<unknown>){
  if(!Object.hasOwn(executorArguments,call.name))throw Error('TOOL_NOT_AVAILABLE');
  const schema:z.ZodObject=executorArguments[call.name as keyof typeof executorArguments];
  const definition=executorTools.find(t=>t.name===call.name)!;
  let result:unknown;
  const browserTool=tool(async args=>{result=await perform(args);return JSON.stringify(result)??'null';},{name:call.name,description:definition.description,schema});
  await browserTool.invoke(JSON.parse(call.arguments));
  return result;
}

/** The graph owns inference, ordering, error feedback and completion. The outer
 * driver below only delivers an existing assistance reply to a pure interrupt.
 */
export async function runExecutionGraph(port:ExecutionGraphPort){
  for(const name of ['LANGSMITH_TRACING','LANGCHAIN_TRACING_V2','LANGCHAIN_TRACING','LANGCHAIN_VERBOSE']){
    const value=getEnvironmentVariable(name);if(value&&value!=='false'&&value!=='0')throw Error('AI_EXTERNAL_TRACING_DISABLED');
  }
  const saver=new SessionCheckpointer(),threadId=crypto.randomUUID();
  const config={configurable:{thread_id:threadId},recursionLimit:Infinity,callbacks:[],durability:'sync' as const};
  const graph=new StateGraph(State)
    .addNode('observe',async()=>{port.guard();const observed=await port.observe();return {input:observed.messages,userSeq:observed.userSeq};})
    .addNode('decide',async state=>{
      port.guard();const reply=await port.decide([...state.input,...fromLangChainMessages(state.transcript)]);port.guard();
      if(await port.changed(state.userSeq))return {transcript:reply.compacted?[]:state.transcript,route:'observe' as const};
      const response=reply.response;
      if(!response.calls.length){
        if(!response.text.trim()){port.record({id:'empty',name:'model',arguments:'{}'},{error:'MODEL_EMPTY_REPLY'});return {route:'observe' as const};}
        return {text:response.text,route:'finish' as const};
      }
      // ask 的问题只由云端协助图发布，模型随工具附带的提问不再先行回显。
      if(response.text.trim()&&!response.calls.some(call=>call.name==='ask'))await port.say(response.text,response.calls[0].id);
      const message:AIMessage=modelResponseToAIMessage(response);
      return {transcript:[...(reply.compacted?[]:state.transcript),message],calls:response.calls,index:0,help:null,route:'dispatch' as const};
    })
    .addNode('dispatch',async state=>{
      port.guard();
      if(await port.changed(state.userSeq))return {transcript:[...state.transcript,...state.calls.slice(state.index).map(call=>resultMessage(call,{error:'INSTRUCTIONS_CHANGED',executed:false}))],route:'observe' as const};
      return {route:state.calls[state.index].name==='ask'?'registerHelp' as const:'tools' as const};
    })
    .addNode('tools',async state=>{
      const call=state.calls[state.index];
      try{return {result:await invokeTool(call,args=>port.perform(call,args,state.userSeq))};}
      catch(error){port.guard();await port.error(call,error as Error);return {result:{error:(error as Error).message}};}
    })
    .addNode('registerHelp',async state=>{
      const call=state.calls[state.index];
      try{const registered=await invokeTool(call,args=>port.registerHelp(args,call)) as {request:ExecutionHelp;answer:HelpResponse};return {help:registered.request,answer:registered.answer,route:registered.answer.ready?'consumeHelp' as const:'awaitHelp' as const};}
      catch(error){port.guard();await port.error(call,error as Error);return {result:{error:(error as Error).message},route:'feedback' as const};}
    })
    // No network, browser, messages, IDs or credentials before interrupt: this
    // node is re-entered from the beginning when Command.resume is delivered.
    .addNode('awaitHelp',state=>({answer:interrupt<{helpId:string},HelpResponse>({helpId:state.help!.id})}))
    .addNode('consumeHelp',async state=>{
      port.guard();const call=state.calls[state.index];
      try{return {result:await port.consumeHelp(state.help!,state.answer!)};}
      catch(error){port.guard();await port.error(call,error as Error);return {result:{error:(error as Error).message}};}
    })
    .addNode('feedback',state=>{
      const call=state.calls[state.index];port.record(call,state.result);
      const transcript=[...state.transcript,resultMessage(call,state.result)];
      // Assistance may change intent. Return to observation instead of running
      // stale calls from the same model batch, preserving native message pairs.
      if(call.name==='ask')return {transcript:[...transcript,...state.calls.slice(state.index+1).map(next=>resultMessage(next,{error:'REPLAN_AFTER_HELP',executed:false}))],route:'observe' as const};
      return {transcript,index:state.index+1,route:state.index+1<state.calls.length?'dispatch' as const:'observe' as const};
    })
    .addNode('finish',async state=>{
      port.guard();if(await port.changed(state.userSeq))return {route:'observe' as const};
      const finished=await port.finish(state.text,state.userSeq);
      return {route:finished?'finish' as const:'observe' as const};
    })
    .addEdge(START,'observe').addEdge('observe','decide')
    .addConditionalEdges('decide',s=>s.route,['observe','dispatch','finish'])
    .addConditionalEdges('dispatch',s=>s.route,['observe','registerHelp','tools'])
    .addEdge('tools','feedback')
    .addConditionalEdges('registerHelp',s=>s.route,['awaitHelp','consumeHelp','feedback'])
    .addEdge('awaitHelp','consumeHelp').addEdge('consumeHelp','feedback')
    .addConditionalEdges('feedback',s=>s.route,['observe','dispatch'])
    .addConditionalEdges('finish',s=>s.route==='finish'?END:'observe',[END,'observe'])
    .compile({checkpointer:saver});
  try{
    let input:typeof State.Update|Command<HelpResponse,typeof State.Update,never>={};
    for(;;){
      await graph.invoke(input,config);
      const state=await graph.getState(config);
      if(!state.next.length)return;
      if(!state.tasks.some(task=>task.interrupts?.length)||!state.values.help)throw Error('GRAPH_UNEXPECTED_PAUSE');
      const request=state.values.help as ExecutionHelp;
      port.guard();const answer=await port.pollHelp(request);port.guard();
      input=new Command<HelpResponse,typeof State.Update,never>({resume:answer});
    }
  }finally{await saver.deleteThread(threadId);}
}
