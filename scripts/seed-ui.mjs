// Explicitly synthetic local-only UI fixtures. This never connects to production.
import { writeFile, mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
const root = path.resolve(import.meta.dirname, "..");
const now = new Date().toISOString(),
  later = new Date(Date.now() + 3600000).toISOString();
const quote = (v) => "'" + String(v).replaceAll("'", "''") + "'";
const base = {
  version: 1,
  goal: "演示数据，用于检查界面，不会访问真实网站。",
  entryUrl: "https://example.com/",
  accountId: null,
  modelId: "ui_demo_model",
  modelVersion: 1,
  allowedActions: ["read", "navigate", "fill", "submit"],
  verification: { kind: "goal", value: "操作成功" },
  schedule: { kind: "manual" },
  status: "paused",
  createdAt: now,
  nextRunAt: null,
};
const rows = [
  ["query", "演示 · 每日信息查询", "succeeded"],
  ["signin", "演示 · 站点登录签到", "waiting_user"],
  ["form", "演示 · 表单提交", "unknown"],
];
const statements = [];
for (const [id, title, status] of rows) {
  const task = { ...base, id: `ui_demo_${id}`, title };
  statements.push(
    `INSERT OR REPLACE INTO tasks(id,version,definition,status,created_at,updated_at) VALUES(${quote(task.id)},1,${quote(JSON.stringify(task))},'paused',${quote(now)},${quote(now)});`,
  );
  const result =
    status === "waiting_user"
      ? null
      : {
          summary:
            status === "unknown"
              ? "提交后连接中断，请先只读核查实际结果。"
              : "已读取页面信息，成功判据通过核验。",
          outcome: status === "unknown" ? "unconfirmed" : "read_result",
          evidence:
            status === "unknown"
              ? []
              : [
                  {
                    url: base.entryUrl,
                    quote: "此结果为界面演示数据：操作成功。",
                    capturedAt: now,
                  },
                ],
        };
  statements.push(
    `INSERT OR REPLACE INTO runs(id,task_id,task_snapshot,status,scheduled_for,deadline,account_key,idempotency_key,created_at,updated_at,device_id,lease_epoch,lease_expires_at,result) VALUES('ui_run_${id}',${quote(task.id)},${quote(JSON.stringify(task))},${quote(status)},${quote(now)},${quote(later)},'ui_account_${id}','ui_fixture_${id}',${quote(now)},${quote(now)},'ui_device',1,${quote(later)},${result ? quote(JSON.stringify(result)) : "NULL"});`,
  );
  statements.push(
    `INSERT OR REPLACE INTO run_events(id,run_id,sequence,kind,message,at) VALUES('ui_event_${id}','ui_run_${id}',1,'started','演示：已加载账号环境并观察页面',${quote(now)});`,
  );
}
statements.push(
  `INSERT OR REPLACE INTO challenges(id,run_id,lease_epoch,version,step_id,kind,instruction,target,status,expires_at) VALUES('ui_challenge','ui_run_signin',1,1,'ui_step','code','演示：请输入本次登录收到的验证码。请保留前导零和大小写。','#code','pending',${quote(later)});`,
);
await mkdir(path.join(root, ".cache"), { recursive: true });
const file = path.join(root, ".cache/ui-fixtures.sql");
await writeFile(file, statements.join("\n"));
const cli = path.join(root, "node_modules/wrangler/bin/wrangler.js");
const result = spawnSync(
  process.execPath,
  [cli, "d1", "execute", "taskrelay", "--local", "--file", file],
  { cwd: path.join(root, "apps/web"), stdio: "inherit", windowsHide: true },
);
process.exit(result.status ?? 1);
