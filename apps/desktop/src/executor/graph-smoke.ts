import {runExecutionGraph} from './execution-graph';
import type {ModelResponse} from '../../../../packages/model/src/index';

/** Installed-runtime probe: deterministic graph/tools/interrupts, no provider or
 * website calls. This does not claim to exercise runtime.execute or Host leases.
 */
export async function smokeExecutionGraph(){
  let decisions=0,actions=0,registered=0,resumed=0,consumed=0,finished=false,paired=false;
  const calls:ModelResponse['calls']=[
    {id:'smoke_action',name:'act',arguments:JSON.stringify({instruction:'验证串行工具调度'})},
    {id:'smoke_help',name:'ask',arguments:JSON.stringify({message:'验证同代协助恢复'})},
  ];
  await runExecutionGraph({
    guard:()=>{},
    observe:async()=>({userSeq:1,messages:[{role:'system',content:'确定性安装运行探针'},{role:'user',content:JSON.stringify({userMessages:[{content:'执行安装探针'}]})}]}),
    decide:async messages=>{
      decisions++;
      if(decisions>1){
        const ids=messages.filter(m=>m.role==='tool').map(m=>m.tool_call_id);
        paired=ids.length===2&&ids[0]==='smoke_action'&&ids[1]==='smoke_help';
      }
      return {compacted:false,response:{text:decisions===1?'':'安装探针已完成',calls:decisions===1?calls:[],usage:{input:null,output:null}}};
    },
    changed:async()=>false,
    perform:async(call,args)=>{if(call.name!=='act'||args.instruction!=='验证串行工具调度')throw Error('GRAPH_SMOKE_TOOL_INVALID');actions++;return {observed:true};},
    registerHelp:async args=>{registered++;return {request:{id:'smoke_help_request',message:String(args.message),origin:'https://example.com'},answer:{ready:false}};},
    pollHelp:async request=>{if(request.id!=='smoke_help_request')throw Error('GRAPH_SMOKE_HELP_ID');resumed++;return {ready:true,message:'确定性回复'};},
    consumeHelp:async(_request,answer)=>{consumed++;return answer.message;},
    record:()=>{},error:async(_call,error)=>{throw error;},say:async()=>{},
    finish:async text=>{finished=text==='安装探针已完成';return finished;},
  });
  if(actions!==1||registered!==1||resumed!==1||consumed!==1||decisions!==2||!paired||!finished)throw Error('GRAPH_SMOKE_FAILED');
  return {langgraphExecution:true,langchainToolMessages:true,graphInterruptResume:true,graphToolExecutions:actions,graphHelpRegistrations:registered};
}
