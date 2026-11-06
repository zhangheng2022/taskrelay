import './ui-dom';
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { Settings } from '../packages/ui/src/settings';
import { ChatAttachments } from '../packages/ui/src/chat-attachments';
import { Conversation } from '../packages/ui/src/conversation';
import { conversationRows } from '../packages/ui/src/execution-progress';
import type { SiteAccount } from '../packages/contracts/src/index';
import type { AccountCardDetail } from '../packages/contracts/src/accounts';
import { run, snapshot, task, threadPage, transportWith } from './ui-fixtures';

afterEach(() => { cleanup(); localStorage.clear(); });
const account: SiteAccount = { id: 'account_one', name: '工作账号', origin: 'https://example.com', usernameHint: 'al***', createdAt: new Date().toISOString(), businessDomains: ['example.com'], loginOrigins: ['https://login.example.com'], credentialVersion: 3, stateEpoch: 5, credentialStatus: 'valid', syncStatus: 'synced' };
const card: AccountCardDetail = { id: 'card_one', kind: 'save', status: 'pending', accountId: null, credentialVersion: null, verified: true, canResume: false, name: '工作账号', origin: 'https://example.com', businessDomains: ['example.com'], loginOrigins: ['https://login.example.com'], username: 'alice', password: 'fixture-password', expiresAt: new Date(Date.now() + 60000).toISOString() };

test('账号同步失败原因只展示固定中文映射，不透传任意响应内容', () => {
  const transport = transportWith(async () => ({})), refresh = async () => {};
  const renderState = (syncError: SiteAccount['syncError'], syncStatus: SiteAccount['syncStatus'] = 'failed') => <Settings transport={transport} refresh={refresh} snapshot={{ ...snapshot, accounts: [{ ...account, syncStatus, syncError }] }}/>;
  const view = render(renderState('TOO_LARGE'));
  assert.ok(view.getByText('登录状态超过 2 MB，已跳过同步'));
  view.rerender(renderState('UNSUPPORTED_COOKIE'));
  assert.ok(view.getByText('部分 Cookie 无法迁移，已跳过同步'));
  for (const reason of ['SYNC_FAILED', undefined, null, 'constructor', '__proto__', '<script>private-token</script>']) {
    view.rerender(renderState(reason));
    assert.ok(view.getByText('同步未完成，后续任务将重试'));
    if (reason) assert.equal(view.queryByText(reason), null);
  }
  view.rerender(renderState('TOO_LARGE', 'synced'));
  assert.equal(view.queryByText('登录状态超过 2 MB，已跳过同步'), null);
});

test('账号设置按精确域名分组，不合并同域的两个账号；编辑不回填密码', async () => {
  const writes: { method: string; path: string; body: any }[] = [];
  const transport = transportWith(async (method, path, body) => {
    if (method === 'GET') return { account, username: 'alice', password: 'existing-secret' };
    writes.push({ method, path, body }); return {};
  });
  const view = render(<Settings transport={transport} snapshot={{ ...snapshot, accounts: [account, { ...account, id: 'account_two', name: '个人账号', usernameHint: 'bo***', credentialStatus: 'invalid' }] }} refresh={async () => {}}/>);
  const group = view.getByRole('region', { name: 'example.com 的账号' });
  assert.ok(within(group).getByText('工作账号')); assert.ok(within(group).getByText('个人账号'));
  assert.ok(view.getByText('凭据已验证')); assert.ok(view.getByText('需要修改凭据')); assert.equal(view.queryByText('已登录'), null);
  fireEvent.click(view.getByRole('button', { name: '编辑工作账号' }));
  await waitFor(() => assert.equal((view.getByLabelText('账号', {exact:true}) as HTMLInputElement).value, 'alice'));
  assert.equal((view.getByLabelText('域名') as HTMLInputElement).value, 'example.com');
  assert.deepEqual([...view.getByRole('dialog').querySelectorAll('label')].map(label=>label.textContent), ['账号名称','域名','账号','密码']);
  assert.equal((view.getByLabelText('密码') as HTMLInputElement).value, '');
  assert.equal(document.body.textContent?.includes('existing-secret'), false);
  fireEvent.change(view.getByLabelText('账号名称'), { target: { value: '新的名称' } });
  fireEvent.click(view.getByRole('button', { name: '保存账号' }));
  await waitFor(() => assert.equal(writes.length, 1));
  assert.equal(writes[0].method, 'PATCH'); assert.equal(writes[0].body.expectedCredentialVersion, 3);
  assert.equal(writes[0].body.password, undefined); assert.equal(writes[0].body.name, '新的名称');
  assert.deepEqual(writes[0].body.loginOrigins, ['https://login.example.com']); assert.equal(localStorage.length, 0);
});

test('新增账号只填域名即可生成精确关联，清除状态绑定当前版本', async () => {
  const writes: { path: string; body: any }[] = [];
  const transport = transportWith(async (_method, path, body) => { writes.push({ path, body }); return {}; });
  const view = render(<Settings transport={transport} snapshot={{ ...snapshot, accounts: [account] }} refresh={async () => {}}/>);
  fireEvent.click(view.getByRole('button', { name: '清除工作账号的登录状态' }));
  await view.findByText('已清除“工作账号”的登录状态，下次使用时重新登录。');
  assert.deepEqual(writes[0], { path: '/api/user/accounts/account_one/clear-state', body: { expectedStateEpoch: 5 } });
  fireEvent.click(view.getByRole('button', { name: '添加账号' }));
  fireEvent.change(view.getByLabelText('账号名称'), { target: { value: '新账号' } });
  fireEvent.change(view.getByLabelText('域名'), { target: { value: 'sub.example.com' } });
  fireEvent.click(view.getByRole('button', { name: '保存账号' }));
  await waitFor(() => assert.equal(writes.length, 2));
  assert.equal(writes[1].body.origin, 'https://sub.example.com');
  assert.deepEqual(writes[1].body.businessDomains, ['sub.example.com']); assert.deepEqual(writes[1].body.loginOrigins, ['https://sub.example.com']);
});

test('账号卡片仅展示四项信息且密码遮蔽；修改后提示重新验证，保存期间防重', async () => {
  const writes: any[] = []; let resolve!: (value: unknown) => void;
  const transport = transportWith(async (method, path, body) => {
    if (method === 'GET') { assert.equal(path, '/api/user/account-cards/card_one'); return card; }
    writes.push({ path, body }); return new Promise(done => { resolve = done; });
  });
  const view = render(<ChatAttachments transport={transport} parts={[{ type: 'account-card', cardId: card.id }]}/>);
  await view.findByRole('button',{name:'修改信息'});
  assert.equal(view.queryByLabelText('密码'),null,'紧凑卡片不把密码输入框挂入聊天');
  assert.deepEqual([...view.container.querySelectorAll('dt')].map(label=>label.textContent), ['账号名称','域名','账号','密码']);
  assert.equal(view.queryByText(/登录地址|业务网站|业务域名|本次凭据已验证/),null);
  assert.ok(view.getByText('••••••••'));
  fireEvent.click(view.getByRole('button',{name:'修改信息'}));
  const password = view.getByLabelText('密码') as HTMLInputElement;
  assert.equal(password.type, 'password'); assert.equal(password.value, 'fixture-password');
  assert.equal(view.queryByText('fixture-password'), null);
  fireEvent.click(view.getByRole('button', { name: '显示密码' })); assert.equal(password.type, 'text');
  fireEvent.change(password, { target: { value: 'replacement' } });
  assert.ok(view.getByText('修改的凭据需要重新验证。'));
  fireEvent.click(view.getByRole('button', { name: '保存账号' })); fireEvent.click(view.getByRole('button', { name: '保存账号' }));
  assert.equal(writes.length, 1); assert.equal(writes[0].body.password, 'replacement');
  await act(async () => resolve({ accountId: 'saved', status: 'saved', resumed: false }));
  await view.findByText('账号已保存，后续任务可使用。'); assert.equal(view.queryByLabelText('密码'), null); assert.equal(localStorage.length, 0);
});

test('卡片通知不会覆盖正在编辑的密码，改名称不会取消原验证状态', async () => {
  let notify = () => {}, reads = 0;
  const transport = transportWith(async () => { reads++; return card; });
  transport.subscribe = fn => { notify = fn; return () => {}; };
  const view = render(<ChatAttachments transport={transport} parts={[{ type: 'account-card', cardId: card.id }]}/>);
  await view.findByRole('button',{name:'修改信息'});
  fireEvent.click(view.getByRole('button',{name:'修改信息'}));
  fireEvent.change(view.getByLabelText('账号名称'), { target: { value: '更好识别的名称' } });
  assert.equal(view.queryByText('修改的凭据需要重新验证。'),null);
  fireEvent.change(view.getByLabelText('密码'), { target: { value: 'edited-on-device' } });
  await act(async () => notify()); await waitFor(() => assert.equal(reads, 2));
  assert.equal((view.getByLabelText('密码') as HTMLInputElement).value, 'edited-on-device');
});

test('修改卡片保存并继续只采用后端恢复结果；结束任务不显示已恢复', async () => {
  const transport = transportWith(async method => method === 'GET' ? { ...card, kind: 'update', canResume: true, verified: false } : { accountId: account.id, status: 'saved', resumed: false });
  const view = render(<ChatAttachments transport={transport} parts={[{ type: 'account-card', cardId: card.id, kind: 'update' }]}/>);
  fireEvent.click(await view.findByRole('button', { name: '保存并继续' }));
  await view.findByText('账号已保存，后续任务可使用。'); assert.equal(view.queryByText('账号已保存，正在继续当前任务。'), null);
});

test('失效卡片没有敏感表单；加载失败仅重读，不自动保存', async () => {
  const methods: string[] = []; let fail = true;
  const transport = transportWith(async method => { methods.push(method); if (fail) throw Error('OFFLINE'); return { ...card, status: 'expired', username: undefined, password: undefined }; });
  const view = render(<ChatAttachments transport={transport} parts={[{ type: 'account-card', cardId: card.id }]}/>);
  fireEvent.click(await view.findByRole('button', { name: '重新加载' }));
  await waitFor(() => assert.equal(methods.length, 2)); fail = false;
  fireEvent.click(await view.findByRole('button', { name: '重新加载' }));
  await view.findByText('这张卡片已失效，请在聊天中重新提供需要保存的信息。');
  assert.equal(view.queryByRole('button', { name: '保存账号' }), null); assert.equal(view.queryByLabelText('密码'), null); assert.ok(methods.every(method => method === 'GET'));
});

test('已打开卡片收到失效通知立即清除敏感表单，不继续提供保存按钮', async () => {
  let stale = false, notify = () => {};
  const transport = transportWith(async () => { if (stale) throw Error('ACCOUNT_CARD_NOT_FOUND'); return card; });
  transport.subscribe = fn => { notify = fn; return () => {}; };
  const view = render(<ChatAttachments transport={transport} parts={[{ type: 'account-card', cardId: card.id }]}/>);
  fireEvent.click(await view.findByRole('button',{name:'修改信息'}));
  await view.findByLabelText('密码'); stale = true;
  await act(async () => notify());
  await view.findByText('这张卡片已失效，请在聊天中重新提供需要保存的信息。');
  assert.equal(view.queryByLabelText('密码'), null); assert.equal(view.queryByRole('button', { name: '保存账号' }), null);
});

test('卡片切换忽略旧请求，离线禁止确认；暂不保存不发送凭据', async () => {
  let resolveOld!: (value: unknown) => void; const writes: any[] = [];
  const transport = transportWith(async (method, path, body) => {
    if (method === 'POST') { writes.push({ path, body }); return {}; }
    if (path.endsWith('/old')) return new Promise(done => { resolveOld = done; });
    return { ...card, id: 'new', username: 'new-user' };
  });
  const view = render(<ChatAttachments transport={transport} parts={[{ type: 'account-card', cardId: 'old' }]}/>);
  view.rerender(<ChatAttachments transport={transport} parts={[{ type: 'account-card', cardId: 'new' }]}/>);
  fireEvent.click(await view.findByRole('button',{name:'修改信息'}));
  await waitFor(() => assert.equal((view.getByLabelText('账号', {exact:true}) as HTMLInputElement).value, 'new-user'));
  await act(async () => resolveOld({ ...card, username: 'old-user' }));
  assert.equal((view.getByLabelText('账号', {exact:true}) as HTMLInputElement).value, 'new-user');
  fireEvent.click(view.getByRole('button',{name:'收起'}));
  view.rerender(<ChatAttachments transport={transport} offline parts={[{ type: 'account-card', cardId: 'new' }]}/>);
  assert.ok(view.getByRole('button', { name: '保存账号' }).hasAttribute('disabled')); assert.equal(writes.length, 0);
  view.rerender(<ChatAttachments transport={transport} parts={[{ type: 'account-card', cardId: 'new' }]}/>);
  fireEvent.click(await view.findByRole('button', { name: '暂不保存' }));
  await view.findByText('本次未保存账号。'); assert.deepEqual(writes, [{ path: '/api/user/account-cards/new/dismiss', body: {} }]);
});

test('账号卡片保持在原聊天可操作，独立于过程折叠；未知组可以停止剩余账号', async () => {
  const message = { id: 'progress_card', seq: 1, role: 'assistant', source: 'executor', run_id: run.id, content: '可以保存账号', at: new Date().toISOString(), parts: [{ type: 'account-card' as const, cardId: card.id }] };
  assert.equal(conversationRows([message])[0].events, undefined);
  const writes: string[] = [], page = { ...threadPage, taskId: task.id, messages: [message] };
  const transport = transportWith(async (method, path) => {
    if (path === '/api/user/threads') return [{ id: page.id, model_id: task.modelId, task_id: task.id }];
    if (path.includes('/account-cards/')) return card;
    if (method === 'POST') writes.push(path); return page;
  });
  const view = render(<Conversation transport={transport} task={task} run={{ ...run, status: 'unknown', accountName: '工作账号', dispatchGroupActive: true, dispatchIndex: 1, dispatchTotal: 3 }} offline={false} refresh={async () => {}}/>);
  await view.findByRole('button', { name: '保存账号' }); assert.ok(view.getByText('执行器 · 工作账号'));
  assert.ok(view.getByText('工作账号 · 2/3')); assert.ok(view.getByText('本次操作结果待核查，后续账号已暂停'));
  assert.equal(view.getByText('本次操作结果待核查，后续账号已暂停').closest('[role="status"]')?.querySelector('.chat-status-spinner'), null);
  fireEvent.click(view.getByRole('button', { name: '停止执行' })); await waitFor(() => assert.deepEqual(writes, [`/api/user/runs/${run.id}/cancel`]));
});

test('紧凑卡片可直接保存，编辑收起后密码控件移除',async()=>{
  let savedBody:unknown;
  const transport=transportWith(async(method,_path,body)=>method==='GET'?card:(savedBody=body,{accountId:account.id,status:'saved'}));
  const view=render(<ChatAttachments transport={transport} parts={[{type:'account-card',cardId:card.id}]}/>);
  fireEvent.click(await view.findByRole('button',{name:'修改信息'}));
  fireEvent.change(view.getByLabelText('账号名称'),{target:{value:'简短名称'}});
  fireEvent.click(view.getByRole('button',{name:'收起'}));
  assert.equal(view.queryByLabelText('密码'),null);
  fireEvent.click(view.getByRole('button',{name:'保存账号'}));
  await view.findByText('账号已保存，后续任务可使用。');
  assert.equal((savedBody as {name:string;password:string}).name,'简短名称');assert.equal((savedBody as {password:string}).password,card.password);
});

test('已归并卡片和空引用消息不再展示',async()=>{
  const duplicate=render(<ChatAttachments transport={transportWith(async()=>({...card,status:'expired',supersededBy:'canonical',password:undefined}))} parts={[{type:'account-card',cardId:card.id}]}/>);
  await waitFor(()=>assert.ok(!duplicate.queryByText('正在加载账号卡片…')));
  assert.equal(duplicate.container.textContent,'');
  assert.deepEqual(conversationRows([{id:'retired_card',seq:1,role:'assistant',content:'',at:new Date().toISOString(),parts:[]}]),[]);
});

test('修改账号域名不沿用旧登录关联，未改域名时保留原协议端口及关联',async()=>{
  const writes: {body:Record<string,unknown>}[]=[];
  const original={...account,origin:'https://example.com:8443',loginOrigins:['https://login.example.com:9443']};
  const transport=transportWith(async(method,_path,body)=>method==='GET'?{account:original,username:'alice'}:(writes.push({body:body as Record<string,unknown>}),{}));
  const view=render(<Settings transport={transport} snapshot={{...snapshot,accounts:[original]}} refresh={async()=>{}}/>);
  fireEvent.click(view.getByRole('button',{name:'编辑工作账号'}));
  await waitFor(()=>assert.equal((view.getByLabelText('域名') as HTMLInputElement).value,'example.com:8443'));
  fireEvent.click(view.getByRole('button',{name:'保存账号'}));
  await waitFor(()=>assert.equal(writes.length,1));
  assert.equal(writes[0].body.origin,original.origin);assert.deepEqual(writes[0].body.loginOrigins,original.loginOrigins);
  await waitFor(()=>assert.ok(!view.queryByRole('dialog')));
  fireEvent.click(view.getByRole('button',{name:'编辑工作账号'}));
  fireEvent.change(await view.findByLabelText('域名'),{target:{value:''}});
  assert.equal((view.getByLabelText('域名') as HTMLInputElement).value,'');
  fireEvent.change(view.getByLabelText('域名'),{target:{value:'other.example.com:8443'}});
  fireEvent.click(view.getByRole('button',{name:'保存账号'}));
  await waitFor(()=>assert.equal(writes.length,2));
  assert.equal(writes[1].body.origin,'https://other.example.com:8443');
  assert.deepEqual(writes[1].body.businessDomains,['other.example.com']);assert.deepEqual(writes[1].body.loginOrigins,['https://other.example.com:8443']);
});
