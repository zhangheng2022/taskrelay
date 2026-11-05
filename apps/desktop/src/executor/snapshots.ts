import type {Page} from '@browserbasehq/stagehand';
import {Buffer} from 'node:buffer';

export function redactSnapshot(value:string,secrets:Iterable<string>){
  for(const secret of secrets)if(secret)value=value.split(secret).join('[已隐藏]');
  return value.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,'[已隐藏邮箱]');
}

/** Fixed visual-only masks; never changes input values or executes model scripts. */
export async function maskedScreenshot(page:Page,secrets:string[]){
  const marker='taskrelay-mask-'+crypto.randomUUID();
  try{
    await page.evaluate(({marker,secrets})=>{
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
      for(const n of nodes){const text=n.textContent??'';
        if(secrets.some(s=>s&&text.includes(s))||/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(text)){
          const range=document.createRange();range.selectNodeContents(n);for(const rect of range.getClientRects())cover(rect);
        }
      }
      return true;
    },{marker,secrets});
    return Buffer.from(await page.screenshot({type:'png'})).toString('base64');
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
    busy:!!document.querySelector('[aria-busy="true"],[role="progressbar"]'),
    disabledControls:document.querySelectorAll('button:disabled,input:disabled').length,
    resourceErrors:(typeof performance.getEntriesByType==='function'?performance.getEntriesByType('resource'):[]).filter(e=>(e as PerformanceResourceTiming).responseStatus>=400).slice(-4).map(e=>({host:new URL(e.name).hostname.slice(0,100),status:(e as PerformanceResourceTiming).responseStatus})),
    // Resource timing does not expose every failed/cross-origin request.
    networkCoverage:'resource timing only; absence of errors does not prove connectivity',
  }));
}
