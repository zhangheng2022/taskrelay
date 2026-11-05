import { DurableObject } from 'cloudflare:workers';
import { Buffer } from 'node:buffer';
import { seal,unseal } from './crypto';
import type { AppEnv } from './env';

/** One object per short-lived artifact; no public URL or cross-owner lookup. */
export class Evidence extends DurableObject<AppEnv> {
  async put(key:string,bytes:ArrayBuffer,expires:number|null) {
    if(bytes.byteLength>2_000_000||(expires!==null&&(expires<=Date.now()||expires>Date.now()+600_000)))throw new Error('EVIDENCE_INVALID');
    const existing=await this.ctx.storage.get<string>('key');
    if(existing&&existing!==key)throw new Error('EVIDENCE_CONFLICT');
    const values:Record<string,unknown>={key,expires,parts:Math.ceil(bytes.byteLength/500_000)};
    const b=new Uint8Array(bytes);
    for(let i=0;i<Number(values.parts);i++)values['part'+i]=await seal(Buffer.from(b.subarray(i*500_000,(i+1)*500_000)).toString('base64'),this.env.MASTER_KEY,`evidence:${key}:${i}`);
    await this.ctx.storage.transaction(async tx=>{await tx.put(values);if(expires!==null)await tx.setAlarm(expires);else await tx.deleteAlarm();});
  }
  async get(key:string):Promise<ArrayBuffer|null> {
    const meta=await this.ctx.storage.get(['key','expires','parts']);
    if(meta.get('key')!==key||(meta.get('expires')!==null&&Number(meta.get('expires'))<=Date.now()))return null;
    const chunks:Uint8Array[]=[];
    for(let i=0;i<Number(meta.get('parts'));i++){
      const cipher=await this.ctx.storage.get<string>('part'+i);
      if(!cipher)return null;
      chunks.push(Buffer.from(await unseal<string>(cipher,this.env.MASTER_KEY,`evidence:${key}:${i}`),'base64'));
    }
    return Uint8Array.from(Buffer.concat(chunks)).buffer;
  }
  async remove(){await this.ctx.storage.deleteAlarm();await this.ctx.storage.deleteAll();}
  async alarm(){await this.ctx.storage.deleteAll();}
}
