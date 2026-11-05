import type {Page} from '@browserbasehq/stagehand';
import {Buffer} from 'node:buffer';
import sharp from 'sharp';

export function redactSnapshot(value:string,secrets:Iterable<string>){
  for(const secret of secrets)if(secret)value=value.split(secret).join('[已隐藏]');
  return value.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,'[已隐藏邮箱]');
}

/** 固定遮蔽控件与媒体；敏感文本仅在执行进程中匹配和涂色，秘密不进入网页执行环境。 */
export async function maskedScreenshot(page:Page,secrets:string[]){
  const marker='taskrelay-mask-'+crypto.randomUUID();
  try{
    const layout = await page.evaluate((marker)=>{
      const cover=(rect:DOMRect)=>{
        if(!rect.width||!rect.height)return;
        const mask=document.createElement('div');mask.setAttribute('data-taskrelay-mask',marker);
        Object.assign(mask.style,{position:'fixed',left:rect.left+'px',top:rect.top+'px',width:rect.width+'px',height:rect.height+'px',background:'#777',zIndex:'2147483647',pointerEvents:'none'});
        document.documentElement.appendChild(mask);
      };
      document.querySelectorAll('input,textarea,select,[contenteditable]').forEach(e=>cover(e.getBoundingClientRect()));
      // Hide media in its own paint layer: a full-page background image must not
      // place an opaque overlay over unrelated text and controls above it.
      document.querySelectorAll<HTMLElement>('iframe,canvas,video,img').forEach(e=>{
        e.setAttribute('data-taskrelay-media-mask',marker);
        e.setAttribute('data-taskrelay-media-visibility',JSON.stringify([e.style.getPropertyValue('visibility'),e.style.getPropertyPriority('visibility')]));
        e.style.setProperty('visibility','hidden','important');
      });
      const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT),nodes:Node[]=[];
      for(let n=walker.nextNode();n;n=walker.nextNode())nodes.push(n);
      const blocks=new Map<Element,number>();
      const text = nodes.flatMap(n=>{
        const range=document.createRange();range.selectNodeContents(n);
        const rects=Array.from(range.getClientRects(),r=>({left:r.left,top:r.top,width:r.width,height:r.height})).filter(r=>r.width>0&&r.height>0);
        if(!rects.length)return [];
        // 块间保留分隔；同一块内的相邻 span 属于连续可见文本。
        let block=n.parentElement!;
        while(block.parentElement){
          const display=getComputedStyle(block).display;
          if(display&&display!=='contents'&&!display.startsWith('inline'))break;
          block=block.parentElement;
        }
        if(!blocks.has(block))blocks.set(block,blocks.size);
        return [{value:n.textContent??'',rects,block:blocks.get(block)!}];
      });
      return {width:innerWidth,height:innerHeight,text};
    },marker);
    if(!Number.isFinite(layout.width)||!Number.isFinite(layout.height)||layout.width<=0||layout.height<=0)throw Error('SNAPSHOT_LAYOUT_INVALID');
    // No secret-dependent selectors, rectangles or matching results go back to the
    // page. Even a hostile page overriding native prototypes cannot observe them.
    const capture=await page.screenshot({type:'png',fullPage:false,scale:'css'});
    const {data,info}=await sharp(Buffer.from(capture),{limitInputPixels:16_000_000}).toColourspace('srgb').ensureAlpha().raw().toBuffer({resolveWithObject:true});
    const sx=info.width/layout.width,sy=info.height/layout.height;
    // 在执行进程拼接文本并映射命中区间，避免秘密被 span 拆开后漏遮蔽。
    // 区间和命中节点只用于本地像素处理，不能回传网页。
    let joined='';
    const spans=layout.text.map((text,index)=>{
      if(index&&layout.text[index-1].block!==text.block)joined+='\n';
      const start=joined.length;joined+=text.value;
      return {text,start,end:joined.length};
    });
    const matches:Array<{start:number;end:number}>=[];
    for(const secret of new Set(secrets))if(secret){
      for(let start=joined.indexOf(secret);start!==-1;start=joined.indexOf(secret,start+1))matches.push({start,end:start+secret.length});
    }
    for(const match of joined.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi))matches.push({start:match.index,end:match.index+match[0].length});
    matches.sort((a,b)=>a.start-b.start);
    let matchIndex=0;
    for(const {text,start,end} of spans){
      while(matchIndex<matches.length&&matches[matchIndex].end<=start)matchIndex++;
      if(!matches[matchIndex]||matches[matchIndex].start>=end)continue;
      for(const rect of text.rects){
        if(![rect.left,rect.top,rect.width,rect.height].every(Number.isFinite)||rect.width<=0||rect.height<=0)continue;
        const left=Math.max(0,Math.floor(rect.left*sx)-1),top=Math.max(0,Math.floor(rect.top*sy)-1);
        const right=Math.min(info.width,Math.ceil((rect.left+rect.width)*sx)+1),bottom=Math.min(info.height,Math.ceil((rect.top+rect.height)*sy)+1);
        for(let y=top;y<bottom;y++)for(let x=left;x<right;x++)data.writeUInt32BE(0x777777ff,(y*info.width+x)*4);
      }
    }
    return (await sharp(data,{raw:{width:info.width,height:info.height,channels:4}}).png().toBuffer()).toString('base64');
  }finally{await page.evaluate(marker=>{
    document.querySelectorAll('[data-taskrelay-mask]').forEach(e=>{if(e.getAttribute('data-taskrelay-mask')===marker)e.remove();});
    document.querySelectorAll<HTMLElement>('[data-taskrelay-media-mask]').forEach(e=>{
      if(e.getAttribute('data-taskrelay-media-mask')!==marker)return;
      const [value,priority]=JSON.parse(e.getAttribute('data-taskrelay-media-visibility')??'["",""]');
      if(value)e.style.setProperty('visibility',value,priority);else e.style.removeProperty('visibility');
      e.removeAttribute('data-taskrelay-media-mask');e.removeAttribute('data-taskrelay-media-visibility');
    });return true;
  },marker).catch(()=>{});}
}

export async function loadingFacts(page:Page){
  return page.evaluate(()=>({
    readyState:document.readyState,
    // 业务进度（积分、等级等）不是加载信号；aria-busy 也只是局部声明，不证明全页不可用。
    busy:!!document.querySelector('[aria-busy="true"]'),
    progressBars:document.querySelectorAll('[role="progressbar"]').length,
    disabledControls:document.querySelectorAll('button:disabled,input:disabled').length,
    resourceErrors:(typeof performance.getEntriesByType==='function'?performance.getEntriesByType('resource'):[]).filter(e=>(e as PerformanceResourceTiming).responseStatus>=400).slice(-4).map(e=>({host:new URL(e.name).hostname.slice(0,100),status:(e as PerformanceResourceTiming).responseStatus})),
    // Resource timing does not expose every failed/cross-origin request.
    networkCoverage:'resource timing only; absence of errors does not prove connectivity',
  }));
}
