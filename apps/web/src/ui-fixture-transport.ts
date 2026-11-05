import type { Snapshot, TaskDefinition, Transport, DesktopStatus } from "../../../packages/contracts/src/index";
import type { ThreadPage } from "../../../packages/ui/src/use-thread";

// 开发预览的隔离 Transport：按当前网站请求合同维护演示任务、聊天和执行器状态。
// 每次创建独立状态；只返回内存演示数据，不访问网络、模型或安装程序。
export function createFixtureTransport(options: URLSearchParams): Transport {
  const state = options.get("state") ?? "new";
  const assistance = [
    "challenge",
    "approval",
    "scan",
    "expired",
    "unsupported",
    "answered",
  ].includes(state);
  const definition: TaskDefinition = {
    id: "demo_task",
    version: 1,
    modelVersion: 1,
    status: "active",
    createdAt: new Date().toISOString(),
    nextRunAt: null,
    title: "演示 · 每日查询",
    goal: "查询 https://example.com 的信息",
    entryUrl: "https://example.com/",
    accountId: null,
    modelId: "fixture_model",
    allowedActions: ["read", "navigate"],
    verification: { kind: "goal", value: "操作成功" },
    schedule: { kind: "manual" },
  };
  const snapshot: Snapshot = {
    tasks: state === "new" ? [] : [definition],
    runs: [],
    accounts: [],
    devices: [],
    challenges: [],
    serverTime: new Date().toISOString(),
    models: [
      {
        id: "fixture_model",
        version: 1,
        name: "演示模型",
        baseUrl: "https://example.com/v1",
        model: "fixture",
        protocol: "chat",
        hasKey: true,
        inputPrice: null,
        outputPrice: null,
        capabilities: {
          connection: true,
          tools: true,
          structured: "schema",
          vision: false,
          testedAt: null,
        },
      },
    ],
  };
  if(options.has('batch'))definition.verification={kind:'batch',value:'每条普通记录标记为已处理',scope:'当前账号全部记录及其分页',eligibility:'普通记录',exclusions:['已归档记录']};
  if (state !== "new")
    snapshot.runs.push({
      id: "demo_run",userId:"demo",profileId:"profile_demo",
      taskId: definition.id,
      task: definition,
      status: assistance
        ? "waiting_user"
        : state === "failed"
          ? "unknown"
          : state === "error"
            ? "failed"
            : state === "running"
              ? "running"
              : "succeeded",
      scheduledFor: new Date().toISOString(),
      deadline: new Date(Date.now() + 3600000).toISOString(),
      deviceId: "demo_device",
      leaseEpoch: 1,
      leaseExpiresAt: null,
      cancelRequested: false,
      writePending: false,
      result:
        assistance || state === "running"
          ? null
          : {
              summary: "演示结果：页面信息已整理。",
              outcome: "reported",
              data: {
                title: "页面公告",
                content: "这是用于验证结果布局的演示数据。",
                checked: true,
              },
              ...(state === "error" ? { errorCode: "MODEL_EGRESS_TIMEOUT" } : {}),
              evidence: [
                {
                  url: "https://example.com/",
                  quote: "操作成功",
                  capturedAt: new Date().toISOString(),
                },
              ],
            },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  if(options.has('batch')&&snapshot.runs[0]?.result){
    const result=snapshot.runs[0].result;
    result.summary='批量任务尚未全部核验：本次完成 1 项，原已完成 1 项，排除 1 项，待核查 1 项。';
    delete result.data;
    result.batch={coverage:'incomplete',expected:4,reason:'最后一页仍需复核，未将已发现项目当作全部完成。',items:[
      {id:'one',label:'记录一：订单资料核对',status:'completed'},
      {id:'two',label:'记录二：供应商信息更新',status:'already_done'},
      {id:'three',label:'记录三：已归档的历史项目',status:'excluded'},
      {id:'four',label:'记录四：需要继续核查的长名称项目，用于检查手机上的换行与完整显示',status:'unknown'},
    ].map(item=>({...item,status:item.status as 'completed'|'already_done'|'excluded'|'unknown',reason:item.status==='excluded'?'已归档记录':'',evidence:{url:'https://example.com/',quote:item.status==='unknown'?'提交结果尚未确认':'已读取对应项目状态',capturedAt:new Date().toISOString()}}))};
  }
  if (assistance && state !== "answered")
    snapshot.waitingHelp = [{id:"demo_help",runId:"demo_run",taskId:definition.id}];
  const messages: { id: string; role: string; content: string; at: string }[] =
    options.has("history")
      ? Array.from({ length: 24 }, (_, i) => ({
          id: `history-${i}`,
          role: i % 2 ? "assistant" : "user",
          content:
            i % 2
              ? `第 ${i + 1} 条演示回复：这里是已记录的执行情况。\n详情会随真实事件回传更新。`
              : `第 ${i + 1} 条任务询问`,
          at: new Date().toISOString(),
        }))
      : [];
  const threads=new Map<string,ThreadPage & {kind: 'chat'}>();
  const memories=new Map<string,{key:string;value:{text:string}}>();
  let failed = false;
  let threadFailures = 0;
  const desktop: DesktopStatus = {
    update:{phase:'current',release:null,progress:null,checkedAt:null,error:null},
    paired: true,
    cloudUrl: "https://example.com",
    paused: false,
    online: state !== "offline",
    activeRunId: state === "running" ? "demo_run" : null,
    version: "演示",
    autoStart: false,
    error: null,
  };
  const updatePhase=options.get('update');
  if(updatePhase&&['available','downloading','waiting','installing','error'].includes(updatePhase)){
    desktop.version='0.4.7';desktop.update={phase:updatePhase as DesktopStatus['update']['phase'],release:{version:'0.4.8',sha1:'a'.repeat(40),sha256:'a'.repeat(64),bytes:1024,notes:'改进执行器的稳定性和更新体验。',publishedAt:new Date().toISOString()},progress:42,checkedAt:null,error:updatePhase==='error'?'更新下载或完整性校验失败，请重试。':null};
  }
  const transport: Transport = {
    async request<T>(method: string, path: string, body?: unknown): Promise<T> {
      await new Promise((r) => setTimeout(r, options.get('network')==='slow'?12000:200));
      // StrictMode probes the initial effect twice; both probes must see the outage.
      if(options.get('network')==='fail-once'&&path==='/api/user/threads'&&threadFailures++<2)throw new Error('OFFLINE');
      let result: unknown;
      if (path === "/api/user/snapshot") result = structuredClone(snapshot);
      else if(path==='/api/user/threads') {
        if(method==='GET')result=[...threads.values()].map(t=>({...t,model_id:t.modelId,task_id:t.taskId??null}));
        else {
          const input = body as {modelId:string;taskId?:string};
          const boundTask = snapshot.tasks.find(task => task.id === input.taskId);
          if (input.taskId && !boundTask) throw new Error('TASK_NOT_FOUND');
          const id=crypto.randomUUID();
          const page: ThreadPage & {kind: 'chat'} = {
            id, kind:'chat', taskId:input.taskId??null, modelId:input.modelId,
            version:0, draft:boundTask??null, partial:{}, activeTurn:null, nextCursor:null,
            messages:boundTask?messages.map((m,i)=>({...m,seq:i+1})):[],
            waiting:boundTask&&assistance&&state!=='answered'?{id:'demo_help',request:'{}'}:null,
          };
          if(page.waiting)page.messages.push({id:'help-message',seq:page.messages.length+1,role:'assistant',content:'请在同一聊天提供登录所需信息，或说明下一步要求。',at:new Date().toISOString()});
          if(boundTask&&snapshot.runs[0]?.result)page.messages.push({id:'final-message',seq:page.messages.length+1,role:'assistant',content:snapshot.runs[0].result.summary,at:new Date().toISOString()});
          threads.set(id,page);result=structuredClone(page);
        }

      } else if(path.startsWith('/api/user/threads/')) {
        const id=path.split('/')[4],page=threads.get(id);
        if (!page) throw new Error('THREAD_NOT_FOUND');
        if(method==='DELETE'){threads.delete(id);result={ok:true};}
        else if(path.endsWith('/messages')) {
          if(options.has('fail')&&!failed){failed=true;throw new Error('MODEL_EGRESS_TIMEOUT');}
          page.version++;
          const {content}=body as {content:string};
          const at=new Date().toISOString();
          page.messages.push({id:crypto.randomUUID(),seq:page.messages.length+1,role:'user',content,at},{id:crypto.randomUUID(),seq:page.messages.length+2,role:'assistant',content:'这是界面演示回复，不会执行真实任务。',at});
          page.waiting=null;snapshot.waitingHelp=[];
          result={...structuredClone(page),status:'done'};
        }
        else result=structuredClone(page);
      } else if(path==='/api/user/memories')result=[...memories.values()];
      else if(path.startsWith('/api/user/memories/')){const key=path.split('/').at(-1)!;if(method==='DELETE')memories.delete(key);else memories.set(key,{key,value:{text:(body as {text:string}).text}});result={ok:true};}
   else if (path.endsWith("/cancel")) {
        snapshot.runs[0].cancelRequested = true;
        result = { ok: true };

      } else if (path.startsWith("/api/user/runs/"))
        result = {
          events: [
            {
              id: "demo_event",
              runId: "demo_run",
              sequence: 1,
              kind: "observed",
              message: "已打开授权网站并读取页面。",
              at: new Date().toISOString(),
            },
            ...(state === "error"
              ? [
                  {
                    id: "demo_error",
                    runId: "demo_run",
                    sequence: 2,
                    kind: "error",
                    message: "模型请求未在允许时间内完成；未执行写操作。",
                    at: new Date().toISOString(),
                  },
                ]
              : []),
          ],
          usage: [{ input: 11, output: 7, cost: null }],
        };
      else if (path === "/api/user/settings") result = { retentionDays: 30 };
      else result = { ok: true };
      return result as T;
    },
  };
  if (options.has("desktop") || options.has('executor') || state === "offline")
    transport.desktop = {
      status: async () => ({ ...desktop }),
      configure: async () => ({ url: "https://example.com", code: "DEMO" }),
      pairPoll: async () => true,
      pause: async (v) => {
        desktop.paused = v;
      },
      autoStart: async (v) => {
        desktop.autoStart = v;
      },
      stop: async () => {
        desktop.activeRunId = null;
      },
      diagnostics: async () => "演示诊断，不含敏感信息",
      checkUpdate: async () => {},
      downloadUpdate: async () => {},
      subscribe: () => () => {},
    };

  return transport;
}
