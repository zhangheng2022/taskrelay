import {hash} from '../../../../packages/contracts/src/security';
import type {ChatPart} from '../../../../packages/contracts/src/execution';

/** 聊天截图的捕获与上传所有者；事件只捕获一次，脱敏后的图片按内容复用。
 * 只管理聊天证据，不缓存 Stagehand 视觉输入，也不参与动作准入或业务成功判断。
 */
export function chatSnapshots(scope:string,capture:()=>Promise<string>,save:(captureId:string,image:string)=>Promise<{id:string}>){
  const attempted=new Set<string>(),images=new Map<string,string>(),published=new Set<string>();
  const take=async(event:string):Promise<{parts:ChatPart[];reused:boolean;available:boolean}>=>{
    if(attempted.has(event))return {parts:[],reused:false,available:false};
    attempted.add(event);
    try{
      const image=await capture(),digest=await hash(image);
      const prior=images.get(digest);
      if(prior&&published.has(prior))return {parts:[],reused:true,available:true};
      const saved=prior?{id:prior}:await save(await hash(`${scope}:${digest}`),image);
      images.set(digest,saved.id);
      return {parts:[{type:'image',artifactId:saved.id,alt:'当前页面'}],reused:false,available:true};
    }catch{return {parts:[],reused:false,available:false};}
  };
  // 上传成功不等于聊天已发布；发布失败后下个节点仍须附图，不能声称“沿用此前”。
  return {take,published:(parts:ChatPart[])=>{for(const part of parts)if(part.type==='image')published.add(part.artifactId);}};
}
