# 部署与恢复

## 当前资源

- Cloudflare account：`b3a410496c5e49e582b4af19d2f2eec6`
- Worker：`taskrelay`，每分钟 Cron
- Durable Object：`ModelEgress`，SQLite 后端，`MODEL_EGRESS` 绑定，`model-egress-v1` 迁移；每次模型调用一个短期对象，限制在 `us` jurisdiction
- D1：`taskrelay` / `9d387f48-6e34-4af4-a2a0-10f958d65a16`
- 私有 R2：`taskrelay-evidence`，不启用公开访问
- Access：`TaskRelay` / `6cd2c9dc-ba3c-4969-9aaf-83ea360c398f`
- 站点：`https://taskrelay.zhangheng.workers.dev`

Access 保护网站及 owner API。`/api/runner/*`、`/api/device/*`、`/api/pair/*`、`/api/health` 允许到达 Worker；设备接口仍强制验证可吊销的随机令牌。配对仅在 owner 已通过 Access 时批准。预览 URL 关闭。

## 发布

```powershell
cd apps/web
npx wrangler d1 migrations apply taskrelay --remote
npm run deploy
```

`MASTER_KEY` 已配置为 Workers Secret。**不要再次执行初次密钥生成脚本，不要覆盖现有主密钥。** 现有模型密钥、账号密码和短期回复都依赖它解密。迁移/恢复时必须同时保留该密钥和 D1 数据。仓库及诊断包不保存主密钥；需要持有者从自己的秘密管理设施维护备份和轮换策略。

新部署到另一账号时，先创建空 D1 / 私有 R2 / Access 应用，替换 wrangler 配置，再对该全新空库执行一次 `node scripts/provision-secret.mjs --initial-empty-database`。脚本通过标准输入传递随机密钥，不输出或落盘。

模型地址先校验 HTTPS、域名、IP 和 DNS 结果，拒绝私网及带 URL 凭据的地址。Workers 使用 `redirect: manual`，显式拒绝重定向，避免将 Authorization 转发到别的地址。不能使用 Workers 不支持的 `redirect: error`。

`GET /api/user/settings/check` 是经过身份验证的有限自检，只返回数据库、加密和固定模型域名 DNS 校验结果，不返回密钥。`node scripts/cloud-self-check.mjs` 会短暂创建隔离诊断设备和无效的测试模型配置，验证生产保存接口后删除这些测试数据，不发起模型推理。

## 模型出站地区

## 工作空间域名

主入口为 `https://tr.zhangheng.eu.org`，原 `https://taskrelay.zhangheng.workers.dev` 保留。自定义域名已在 `apps/web/wrangler.jsonc` 的 `routes` 中声明为 `custom_domain: true`，指向同一 `taskrelay` Worker；不创建另一套 D1/R2/模型配置。

两个主机名纳入同一个 TaskRelay Access application，保留原 owner 策略与 AUD。`/api/runner/*`、`/api/device/*`、`/api/pair/*`、`/api/health` 使用与原地址相同的路径例外；设备/执行接口仍由 Worker 验证设备令牌。2026-11-03 已验证新旧首页匿名访问跳转 Access，新域名 health 返回 200，设备 snapshot 无令牌返回 401。HTTPS 验证使用正常证书校验。

已配对客户端可继续使用原地址；新配对可填写新域名。回退域名时只撤下自定义域名绑定/配置并保留原地址，不轮换 MASTER_KEY、不重建 Access 应用或数据存储。

## 模型出站实现

所有能力测试、任务解析、Stagehand 模型回调及人工协助解析统一经过 `MODEL_EGRESS`，由美国区域 Durable Object 的 alarm 发起上游请求。网页和设备请求只提交加密的推理作业，不转发原始 Request、IP 或地区头。API Key 仍由云端从 D1 解密，网站和客户端均拿不到明文。缺少出站绑定会明确失败，不回退到带访问者上下文的直接请求。

普通 Worker 即使指定美国 placement，实际测试仍可能向 OpenAI 保留访问者的地区上下文：2026-11-03 实测执行位置 `remote-IAD`，但 OpenAI trace 的 `loc=HK`，模型返回 `unsupported_country_region_territory`。改为独立 alarm 后，同次诊断分别显示普通请求 `HK/HKG`、后台请求 `US/IAD`（另一次为 `US/ATL`），现有 `gpt-6-luna / Responses` 的连接、工具和严格 Schema 测试全部通过。因此没有保留无效的全站 placement 提示，也没有伪造地区头。

作业及结果短期加密并分块保存；领取结果确认后删除密文，未确认的记录在 3 分钟后清理。alarm 在上游请求前持久化 running 状态；中断后返回 `MODEL_CALL_OUTCOME_UNKNOWN`，不会自动再次调用供应商。任务状态和调度仍以 D1 为权威。

诊断命令：`node scripts/cloud-self-check.mjs --egress --probe-existing`。`--egress` 只从固定官方 trace 地址保留状态、国家和机房，不保留 IP 或完整响应；`--probe-existing` 会通过云端使用已有模型配置进行真实能力测试，可能产生供应商用量。原始密钥不离开 Workers。

参考：[Cloudflare 数据区域约束](https://developers.cloudflare.com/durable-objects/reference/data-location/)、[alarm 执行语义](https://developers.cloudflare.com/durable-objects/api/alarms/)。区域出站不能替代供应商的账号、项目或模型权限检查。

## 数据与执行恢复

云端为任务和调度权威，D1 事务完成领取、设备并发和账号锁。模型配置更新生成新版本，运行持有任务/模型版本快照。

Main 在产生浏览器副作用前记录 SQLite 检查点。云端也先记录动作意图，再让执行器执行。事件及终结事实放入持久化 outbox；旧代次和旧租约不能推进新运行。已执行写入但最终结果不明时保留账号锁，失败或租约到期不会触发盲目重放。只读核查成功后才释放锁。

默认心跳 15 秒、租约 90 秒、自动执行 5 分钟/40 个动作、人工等待 5 分钟，全机同时执行一个任务。调度最多补最近一小时内最后一次。停止本机执行先关闭自有浏览器和执行进程，不等待网络请求。

未知结果可能长期阻止账号继续运行，这是保守恢复的预期行为；首版没有绕过核查的强制解锁入口。复杂 iframe/新标签页工作流、不能通过输入/扫码/确认完成的验证可能不受支持，并应保留明确失败记录。

升级通过新安装包，保留 userData。客户端拒绝读取高于自身支持版本的 SQLite。首版不含自动更新。常规卸载是否保留用户数据、干净机器升级及代码签名状态必须按验收表实际记录。
