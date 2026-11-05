import {BaseCheckpointSaver,WRITES_IDX_MAP,compareWritesSortKeys,writesSortKey,type Checkpoint,type CheckpointMetadata,type CheckpointTuple,type CheckpointListOptions,type PendingWrite} from '@langchain/langgraph-checkpoint';
import type {RunnableConfig} from '@langchain/core/runnables';

type Serialized=[string,Uint8Array];
type SavedWrite={task:string;channel:string;value:Serialized;path:string;index:number};
type Saved={config:RunnableConfig;checkpoint:Serialized;metadata:Serialized;parent?:RunnableConfig;writes:Map<string,SavedWrite>};

/** Full-state checkpoints for one live execution, never a browser recovery log.
 * Only the latest checkpoint and its parent survive. Delta channels and time
 * travel are deliberately unsupported; Main's journal remains the crash owner.
 */
export class SessionCheckpointer extends BaseCheckpointSaver {
  private rows=new Map<string,Saved>();
  private key(config:RunnableConfig){
    const c=config.configurable;
    if(typeof c?.thread_id!=='string')throw Error('GRAPH_THREAD_REQUIRED');
    return JSON.stringify([c.thread_id,c.checkpoint_ns??'',c.checkpoint_id??'']);
  }
  private sameThread(a:RunnableConfig,b:RunnableConfig){return a.configurable?.thread_id===b.configurable?.thread_id&&(a.configurable?.checkpoint_ns??'')===(b.configurable?.checkpoint_ns??'');}
  async getTuple(config:RunnableConfig):Promise<CheckpointTuple|undefined>{
    const row=config.configurable?.checkpoint_id?this.rows.get(this.key(config)):[...this.rows.values()].reverse().find(r=>this.sameThread(r.config,config));
    if(!row)return;
    const writes=[...row.writes.values()].sort((a,b)=>compareWritesSortKeys(writesSortKey(a.path,a.task,a.index),writesSortKey(b.path,b.task,b.index)));
    return {config:row.config,checkpoint:await this.serde.loadsTyped(...row.checkpoint) as Checkpoint,
      metadata:await this.serde.loadsTyped(...row.metadata) as CheckpointMetadata,parentConfig:row.parent,
      pendingWrites:await Promise.all(writes.map(async w=>[w.task,w.channel,await this.serde.loadsTyped(...w.value)] as [string,string,unknown]))};
  }
  async *list(config:RunnableConfig,options?:CheckpointListOptions){
    let count=0;
    for(const row of [...this.rows.values()].reverse()){
      if(!this.sameThread(row.config,config))continue;
      if(options?.before?.configurable?.checkpoint_id&&String(row.config.configurable?.checkpoint_id)>=String(options.before.configurable.checkpoint_id))continue;
      const tuple=await this.getTuple(row.config);
      if(!tuple||options?.filter&&Object.entries(options.filter).some(([key,value])=>tuple.metadata?.[key as keyof CheckpointMetadata]!==value))continue;
      if(options?.limit!==undefined&&count>=options.limit)return;
      count++;yield tuple;
    }
  }
  async put(config:RunnableConfig,checkpoint:Checkpoint,metadata:CheckpointMetadata){
    const savedConfig={configurable:{thread_id:config.configurable?.thread_id,checkpoint_ns:config.configurable?.checkpoint_ns??'',checkpoint_id:checkpoint.id}};
    const [body,meta]=await Promise.all([this.serde.dumpsTyped(checkpoint),this.serde.dumpsTyped(metadata)]);
    const key=this.key(savedConfig),parent=config.configurable?.checkpoint_id?{configurable:{...savedConfig.configurable,checkpoint_id:config.configurable.checkpoint_id}}:undefined;
    this.rows.set(key,{config:savedConfig,checkpoint:body,metadata:meta,parent,writes:this.rows.get(key)?.writes??new Map()});
    const parentKey=parent?this.key(parent):null;
    for(const [oldKey,row] of this.rows)if(this.sameThread(row.config,config)&&oldKey!==key&&oldKey!==parentKey)this.rows.delete(oldKey);
    return savedConfig;
  }
  async putWrites(config:RunnableConfig,writes:PendingWrite[],task:string,path=''){
    const row=this.rows.get(this.key(config));
    if(!row)throw Error('GRAPH_CHECKPOINT_MISSING');
    for(const [position,[channel,value]] of writes.entries()){
      const index=WRITES_IDX_MAP[channel]??position,key=JSON.stringify([task,index]);
      if(index>=0&&row.writes.has(key))continue;
      const serialized=await this.serde.dumpsTyped(value);
      row.writes.set(key,{task,channel,value:serialized,path,index});
    }
  }
  async deleteThread(threadId:string){for(const [key,row] of this.rows)if(row.config.configurable?.thread_id===threadId)this.rows.delete(key);}
}
