
if(import.meta.env.DEV){
  const state=new URLSearchParams(location.search).get('state')??'network';
  const entries=state==='loading'
    ?[['手机 · 慢速首次加载',390,760,'?state=new&network=slow'],['窄桌面 · 慢速首次加载',768,760,'?state=new&network=slow']]
    :state==='auth'
    ?[['手机 · 登录主题',390,760,'?auth'],['窄桌面 · 登录主题',768,760,'?auth']]
    :state==='conversation'
    ?[['手机 · 人工协助',390,760,'?state=challenge&history#demo_task'],['窄桌面 · 未知结果',768,760,'?state=failed&history#demo_task']]
    :[['手机 · 联网失败后重新加载',390,760,'?state=new&network=fail-once'],['执行器 · 连接中断',520,640,'?executor&state=offline']];
  for(const [title,width,height,query] of entries){
    const section=document.createElement('section'),heading=document.createElement('h2'),frame=document.createElement('iframe');
    heading.textContent=String(title);frame.title=String(title);frame.width=String(width);frame.height=String(height);
    const url=new URL('./ui-fixture.html'+query,location.href);url.searchParams.set('reviewWidth',String(width));frame.src=url.href;
    section.appendChild(heading);section.appendChild(frame);document.getElementById('frames')!.appendChild(section);
  }
}
