// Isolated, synthetic acceptance website. Never bind production data or secrets.
const cases = new Set(['form', 'assist', 'approval', 'cancel']);
const headers = {'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'"};
const page = (body, status=200) => new Response(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TaskRelay 虚构数据验收站</title><style>body{font:18px system-ui;max-width:740px;margin:50px auto;padding:20px;line-height:1.8}label,input,button{display:block;margin:16px 0}input,button{font:inherit;padding:10px}aside{background:#eee;padding:16px}</style><h1>TaskRelay 虚构数据验收站</h1><aside>本网站仅含虚构数据。提交不发送邮件、不付款、不修改任何真实业务账号。</aside>${body}</html>`,{status,headers});
export default {
 async fetch(request,env) {
  const url=new URL(request.url), key=url.pathname.slice(1);
  if(request.method==='GET' && url.pathname==='/')return page('<h2>验收目录</h2><p>只读标记：QA1103-READ-42</p><ul>'+[...cases].map(k=>`<li><a href="/${k}">${k}</a></li>`).join('')+'</ul>');
  if(!cases.has(key))return page('<p>不存在</p>',404);
  if(request.method==='POST'){
   if(Date.now()>Date.parse('2026-11-05T00:00:00Z'))return page('<p>验收写入已关闭</p>',410);
   if(request.headers.get('origin')!==url.origin)return page('<p>来源无效</p>',403);
   if(Number(request.headers.get('content-length')??0)>1024)return page('<p>表单过大</p>',413);
   const reader=request.body?.getReader();let length=0,parts=[];
   if(reader)for(;;){const {value,done}=await reader.read();if(done)break;length+=value.length;if(length>1024){await reader.cancel();return page('<p>表单过大</p>',413);}parts.push(value);}
   const bytes=new Uint8Array(length);let offset=0;for(const p of parts){bytes.set(p,offset);offset+=p.length;}
   const form=new URLSearchParams(new TextDecoder().decode(bytes));
   if(form.get('value')!=='QA1103'||(key==='assist'&&form.get('code')!=='0012aB'))return page('<p>测试值错误；未提交。</p>',400);
   const result=await env.DB.prepare('UPDATE cases SET submissions=submissions+1 WHERE id=? AND submissions<10').bind(key).run();
   if(!result.meta.changes)return page('<p>本用例提交额度已用完</p>',429);
   // Synthetic fault window: the counter is committed before the response.
   // Stop only the test executor during this wait to verify unknown + read-only recovery.
   if(key==='cancel')await new Promise(resolve=>setTimeout(resolve,15000));
   return Response.redirect(url.origin+'/'+key,303);
  }
  if(request.method!=='GET')return page('<p>方法不支持</p>',405);
  const row=await env.DB.prepare('SELECT submissions FROM cases WHERE id=?').bind(key).first();
  const count=Number(row?.submissions??0);
  return page(`<h2>用例 ${key}</h2><p>已提交次数：${count}</p><p>状态：${count?'QA1103-SUBMITTED':'尚未提交'}</p>${key==='assist'?'<p>本用例需要人工提供测试确认码。该值不在此页面公开；这不是验证码或真实认证。</p>':''}${key==='approval'?'<p>此表单模拟需人工确认的操作，仅写入虚构计数器。</p>':''}<form method="post"><label>测试值<input name="value" required maxlength="20"></label>${key==='assist'?'<label>人工提供的测试确认码<input name="code" required maxlength="20"></label>':''}<button type="submit">提交虚构测试记录</button></form><a href="/">返回目录</a>`);
 }
};
