import "./ui-dom";
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { useState } from "react";
import { render, fireEvent, cleanup, waitFor, act } from "@testing-library/react";
import { Composer } from "../packages/ui/src/chat-parts";
import { TaskCompose } from "../packages/ui/src/task-compose";
import { TaskEditor } from "../packages/ui/src/task-editor";
import { taskInputSchema } from "../packages/contracts/src/index";
import { ModelSelector } from "../packages/ui/src/model-selector";
import { snapshot, task, transportWith, threadPage } from "./ui-fixtures";

afterEach(() => {
  cleanup();
  localStorage.clear();
});
test("task editor rejects private addresses and does not silently expand allowed sites", async () => {
  const applied: unknown[]=[];
  const view=render(<TaskEditor initial={taskInputSchema.strip().parse(task)} snapshot={snapshot} onClose={()=>{}} onApply={v=>applied.push(v)}/>);
  fireEvent.change(view.getByRole('textbox',{name:'网站地址'}),{target:{value:'http://127.0.0.1'}});
  fireEvent.click(view.getByRole('button',{name:'更新确认卡'}));
  assert.match(view.getByRole('alert').textContent??'',/公网 HTTPS/);
  assert.equal(applied.length,0);
  fireEvent.change(view.getByRole('textbox',{name:'网站地址'}),{target:{value:'https://other.example.com/'}});
  fireEvent.click(view.getByRole('button',{name:'更新确认卡'}));
  assert.match(view.getByRole('alert').textContent??'',/允许访问/);
  assert.equal(applied.length,0);
  fireEvent.change(view.getByRole('textbox',{name:'网站地址'}),{target:{value:task.entryUrl}});
  fireEvent.click(view.getByRole('button',{name:'更新确认卡'}));
  assert.equal(applied.length,1);
});
test("asynchronous completion with the same version shows the draft and unlocks the next turn", async () => {
  let page: any = {...threadPage}, listener: (()=>void)|undefined;
  const sent: any[]=[];
  const transport={...transportWith(async (method,path,body)=>{
    if(path==='/api/user/threads')return [{id:threadPage.id,kind:'compose',model_id:'model-ui',task_id:null}];
    if(method==='GET')return page;
    assert.ok(path.endsWith('/messages'),'a draft must never create a task implicitly');
    sent.push(body);
    page={...page,version:sent.length,activeTurn:'turn-'+sent.length,latestTurn:{status:'running'},status:'running'};
    return page;
  }),subscribe(fn:()=>void){listener=fn;return()=>{listener=undefined;};}};
  const view=render(<TaskCompose transport={transport} snapshot={snapshot} offline={false} onSaved={async()=>{}} onSettings={()=>{}}/>);
  await waitFor(()=>assert.equal(view.getByRole('button',{name:'监测页面是否发生变化'}).hasAttribute('disabled'),false));
  fireEvent.click(view.getByRole('button',{name:'监测页面是否发生变化'}));
  await waitFor(()=>assert.ok(listener));
  assert.ok(view.getByRole('status').textContent?.includes('正在整理任务'));
  page={...page,activeTurn:null,latestTurn:{status:'done'},draft:task};
  await act(async()=>listener!());
  await view.findByRole('button',{name:'创建并试运行'});
  assert.equal(view.queryByRole('status'),null);
  fireEvent.change(view.getByRole('textbox'),{target:{value:'改成每天上午九点'}});
  fireEvent.click(view.getByRole('button',{name:'发送消息'}));
  await waitFor(()=>assert.equal(sent.length,2));
  assert.notEqual(sent[0].requestId,sent[1].requestId);
  assert.equal(sent[1].expectedVersion,1);
});
test("pending input stays focused and read-only, and accepts another message after completion", () => {
  let sends = 0;
  const props = {
    text: "任务",
    setText: () => {},
    onSend: () => sends++,
    placeholder: "任务",
  };
  const view = render(<Composer {...props} busy={false} />);
  const input = view.getByRole("textbox") as HTMLTextAreaElement;
  input.focus();
  view.rerender(<Composer {...props} busy />);
  assert.equal(document.activeElement, input);
  assert.equal(input.disabled, false);
  assert.equal(input.readOnly, true);
  fireEvent.keyDown(input, { key: "Enter" });
  assert.equal(sends, 0);
  view.rerender(<Composer {...props} busy={false} />);
  assert.equal(document.activeElement, input);
  fireEvent.keyDown(input, { key: "Enter" });
  assert.equal(sends, 1);
});
test("composer sends once on Enter; Shift+Enter and IME composition never send", () => {
  let sends = 0;
  function Input() {
    const [text, setText] = useState("任务");
    return (
      <Composer
        text={text}
        setText={setText}
        onSend={() => sends++}
        busy={false}
        placeholder="任务"
      />
    );
  }
  const view = render(<Input />),
    input = view.getByRole("textbox");
  fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
  fireEvent.keyDown(input, { key: "Enter", isComposing: true });
  fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
  assert.equal(sends, 0);
  fireEvent.keyDown(input, { key: "Enter" });
  assert.equal(sends, 1);
  fireEvent.click(view.getByRole("button", { name: "发送消息" }));
  assert.equal(sends, 2);
});

test("suggestion sends a real compose request, shows pending turn, and requires explicit creation", async () => {
  const calls: { path: string; body: any }[] = [];
  let resolve!: (value: unknown) => void;
  const transport = transportWith(async (_method, path, body) => {
    if(path==='/api/user/threads')return _method==='GET'?[]:threadPage;
    calls.push({ path, body });
    return new Promise((r) => {
      resolve = r;
    });
  });
  const view = render(
    <TaskCompose
      transport={transport}
      snapshot={snapshot}
      offline={false}
      onSaved={async () => {}}
      onSettings={() => {}}
    />,
  );
  await waitFor(()=>assert.equal(view.getByRole("button",{name:"监测页面是否发生变化"}).hasAttribute("disabled"),false));
  fireEvent.click(view.getByRole("button", { name: "监测页面是否发生变化" }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.content, "监测页面是否发生变化");
  assert.ok(view.getByRole("status"));
  assert.equal(view.queryByText("今天想交给 TaskRelay 什么任务？"), null);
  resolve({...threadPage,version:1,status:'done',draft:task,messages:[{id:'reply',seq:2,role:'assistant',content:'请确认范围'}]});
  await view.findByRole("button", { name: "创建并试运行" });
  assert.equal(calls.length, 1);
});

test("ambiguous task creation retries exactly the same payload/id and locks editing", async () => {
  const writes: unknown[] = [];
  const transport = transportWith(async (_method, path, body) => {
    if(path==='/api/user/threads')return _method==='GET'?[]:threadPage;
    if(path.endsWith('/messages'))return {...threadPage,version:1,status:'done',draft:task};
    if(path.endsWith('/draft'))return {...threadPage,version:2,draft:body.draft};
    writes.push(structuredClone(body));
    throw new Error("NETWORK_ERROR");
  });
  const view = render(
    <TaskCompose
      transport={transport}
      snapshot={snapshot}
      offline={false}
      onSaved={async () => {}}
      onSettings={() => {}}
    />,
  );
  await waitFor(()=>assert.equal(view.getByRole("button",{name:"监测页面是否发生变化"}).hasAttribute("disabled"),false));
  fireEvent.change(view.getByRole("textbox"), {
    target: { value: "检查 https://example.com" },
  });
  fireEvent.click(view.getByRole("button", { name: "发送消息" }));
  fireEvent.click(await view.findByRole("button", { name: "创建并试运行" }));
  await waitFor(() =>
    assert.equal(
      view.getByRole("button", { name: "重试确认" }).hasAttribute("disabled"),
      false,
    ),
  );
  assert.ok(
    view.getByRole("button", { name: "编辑配置" }).hasAttribute("disabled"),
  );
  fireEvent.click(view.getByRole("button", { name: "重试确认" }));
  await waitFor(() => assert.equal(writes.length, 2));
  assert.deepEqual(writes[0], writes[1]);
});

test("model selector keeps arbitrary names and disables profiles without required capabilities", async () => {
  let selected = "";
  const models = [
    snapshot.models[0],
    {
      ...snapshot.models[0],
      id: "bad",
      name: "未测试",
      capabilities: { ...snapshot.models[0].capabilities, tools: false },
    },
  ];
  const view = render(
    <ModelSelector
      models={models}
      value="model-ui"
      onChange={(id) => {
        selected = id;
      }}
    />,
  );
  fireEvent.keyDown(view.getByRole("button"), { key: "ArrowDown" });
  const items = await view.findAllByRole("menuitemradio");
  assert.match(items[0].textContent ?? "", /non-gpt/);
  assert.equal(items[1].getAttribute("aria-disabled"), "true");
  fireEvent.click(items[1]);
  assert.equal(selected, "");
});
