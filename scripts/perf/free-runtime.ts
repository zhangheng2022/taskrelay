// Isolated workerd fixture. No network provider and no production secrets.
import worker from '../../apps/cloud/src/worker';
export {RequestCoordinator,Scheduler,AiTurn,Evidence,NotificationHub,ModelEgress} from '../../apps/cloud/src/worker';
import {hash} from '../../packages/contracts/src/security';
import {seal} from '../../apps/cloud/src/crypto';
import type {AppEnv} from '../../apps/cloud/src/env';
import {app} from '../../apps/cloud/src/index';
import {stagehandSchema} from '../../apps/cloud/src/ai/stagehand-schema';
import {z} from 'zod';
app.onError((e,c)=>{console.error('fixture error',e.message);return c.json({error:e.message},500);});
export default {async fetch(req:Request,env:AppEnv,ctx:ExecutionContext){
 if(!['localhost','127.0.0.1'].includes(new URL(req.url).hostname))return new Response(null,{status:403});
 const path=new URL(req.url).pathname;
 if(path==='/_schema'){
   const validate=stagehandSchema(z.toJSONSchema(z.strictObject({extraction:z.string()})));
   const valid=validate({extraction:'fixture'});
   let rejected=false;try{validate({extraction:3});}catch{rejected=true;}
   return Response.json({valid,rejected});
 }
 if(path==='/_init'){
   await env.DB.prepare("INSERT INTO devices(id,name,token_hash,protocol_version) VALUES('fixture','fixture',?,3)").bind(await hash('d'.repeat(64))).run();
   await env.DB.prepare('INSERT INTO model_profiles(id,version,config,secret,capabilities,created_at) VALUES(?,1,?,?,?,?)').bind('fixture',JSON.stringify({name:'fixture',baseUrl:'https://provider.example/v1',model:'fixture',protocol:'chat',inputPrice:null,outputPrice:null}),await seal('fixture-only',env.MASTER_KEY,'model:fixture:1'),JSON.stringify({connection:true,tools:true,structured:'schema',vision:false}),new Date().toISOString()).run();
   return Response.json({ok:true});
 }
 if(path==='/_evidence'){
   const store=env.EVIDENCE_STORE.getByName('fixture');
   const bytes=new Uint8Array(1_100_000).fill(51).buffer;
   await store.put('fixture',bytes,Date.now()+60000);
   const result=await store.get('fixture');
   const other=await store.get('other');
   await store.remove();
   return Response.json({size:result?.byteLength,first:result?new Uint8Array(result)[0]:null,other,removed:await store.get('fixture')});
 }
 if(path==='/_publish'){await env.NOTIFICATIONS.getByName('device:fixture').publish();return Response.json({ok:true});}
 return worker.fetch(req,env,ctx);
}};
