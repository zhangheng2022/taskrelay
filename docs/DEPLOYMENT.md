# 部署与恢复

2026-11-06 CDP 批次源码 0e40975 已推送，CI 42198300218 的 Windows／Ubuntu 检查通过；Worker 29a285ee-3fc7-4f44-9e01-bc0a8918e76e 已部署，D1 仍为 0027。暂停领取并确认无活动／未清理运行和推理作业后发布；系统实际安装 0.17.0，经桌面快捷方式启动，安装与构建 ASAR 哈希一致。包内、实际安装 smoke 和 release-manifest 通过，真实路径不是 Codex LocalCache。随后连续五次 Microsoft 只读验证通过（3 次原 Profile、2 次独立 Profile 云端恢复），均自主收尾、关闭确认、释放账号并同步新状态。最终领取开启、维护关闭、设备就绪，状态版本 11；详见 [验收记录](ACCEPTANCE.md#连续五次-microsoft-登录状态复用)。两台物理设备验证尚未完成。

0.17.0 接入 CRI 并修正运行依赖版本报告，包含此前未实际安装的 0.16.0 前端更新。协议仍为 17、D1 保持 0027，不新增 SQL。npm postinstall 与精选生产依赖暂存均校验并应用 scripts/cdp-policy.mjs；不得通过 ignore-scripts 绕过后直接交付。打包和实际安装 smoke 必须报告实际 Stagehand／CRI 版本、加载路径、连接策略与状态往返通过，release-manifest 拒绝旧字段或缺失证据。系统安装及五次真实验证结果见验收记录。

2026-11-06 前端批次 b7a0774 已部署 Worker 60f073b2-fb82-417c-a2f4-a32d392ed07b，D1 保持 0027。0.16.0 包内 smoke 通过；系统安装前用户按 Esc 停止界面控制，实际本机仍 0.15.0／协议 17，领取已恢复，后续从实际安装核验继续。

2026-11-06 官方 SDK 源码 a05ab00 已部署 Worker e0cf3891-6cf0-4dc1-821b-30c673e49af1，生产只读复验成功并恢复领取。前端类型／缓存批次提升桌面至 0.16.0，仅 Renderer 数据读取变化，协议仍为 17，无新增 SQL；按暂停领取、排空、云端网页、安装核验、恢复领取顺序发布。

## 账号状态版本的发布要求（0.13.0）

新增 D1 迁移 `0024_browser_state.sql`、`0025_account_dispatch.sql`、`0026_account_cards.sql`，以及 `browser-state-v1` SQLite DO migration 和 `BROWSER_STATES` 绑定。保留现有账号、Profile 和 MASTER_KEY，不重新初始化凭据。执行协议为 16，图为 relay-graph-2；旧版本不领取新协议任务。

上线顺序：先暂停新增领取，等待旧执行终态并核实浏览器退出；备份数据库后应用增量迁移和新云端，再升级执行器并验证设备就绪，最后恢复领取。旧运行若在迁移时仍 active/unknown，会保留 cleanup_pending；不得为恢复调度直接删除未知结果锁。未获得关闭确认的非 unknown 账号可走管理员“已确认旧设备停止”入口，旧候选状态同时退休。

2026-11-06 已按上述顺序完成生产迁移、云端部署与本机执行器升级，恢复领取。真实账号与双设备网站验证另见 ACCEPTANCE；不能把安装 smoke 当作真实网站免登录证据。

## 最近已记录部署

2026-11-06 工具 Schema 修复 `662d9a7` 部署 Worker `7b046e11-febd-4b73-ba16-83bf3cae60c2`，保持数据库 0027、执行器 0.15.0。暂停领取并确认无活动／未清理运行及推理后部署，健康和权限检查通过，恢复领取；新的 Microsoft 只读复验自主结束，详情见验收记录。后续模型 SDK 批次只改云端，无新增 SQL 或桌面版本，仍须暂停领取、排空并按相同步骤发布。

2026-11-06 官方 Agent 批次源码 `976f4ef` 部署 Worker `038a3ad6-814b-4450-9d3f-369ba004653d`，本机实际安装 0.15.0／协议 17。维护窗口无活动运行、未确认清理和推理作业；无新增 SQL。包内与实际安装 smoke、桌面快捷方式启动、ASAR 哈希核对通过，领取已恢复。真实网站结果另记。

2026-11-06 依赖基线源码 `df34a73` 已部署 Worker `32a8bb89-39a1-4ae6-b2a3-e8adcc4ef7dd`，本机实际安装 0.14.0 且安装 smoke 通过；D1 无新增迁移（0027），领取已恢复。完整安装哈希及证据边界见 ACCEPTANCE。

0.15.0 协议提升为 17、图版本 relay-graph-3。发布前暂停新领取，确认旧执行、未确认浏览器、模型作业及聊天推理清理后再部署；本批没有结构变更，不运行多余 SQL。旧图由版本检查拒绝恢复，不重放未知操作。云端部署后安装新版执行器，在维护窗口通过原设备 token 升级协议，核对实际版本与 ASAR 后恢复领取。

2026-11-06 四项账号界面从源码 `2f852684342c3074dc0725658a530efd5fd6e3d5` 上线，Worker `3cd368fb-b697-4b8a-914e-448afd0f2fca` 承接 100% 流量。无新增迁移，D1 保持 0027、执行器保持 0.13.0／协议 16。两域健康与权限检查、跨平台 CI、线上四项卡片核对通过；`maintenance=0`、`claimsEnabled=1`、设备 claim_ready=1。用户随后自行确认保存账号，本机实际安装执行器在新的独立 Profile 中恢复云端状态，再复用同一 Profile 完成第二轮 Microsoft 只读免登录验证；两轮浏览器关闭均确认，状态版本由 1 经 2 更新为 3，账号锁和本机 outbox 清零。第二轮需要提醒结束重复导航，详细证据和双设备等未验收边界见 [ACCEPTANCE](ACCEPTANCE.md#用户确认后的真实登录状态复用)。此验证未重新部署或覆盖安装包。

2026-11-06 卡片紧凑化与重复提示修复从源码 `94b5c98cfa93d7a893dc467c1837edb4ce025875` 上线。先应用 D1 0027，再部署 Worker `487b9e41-dc31-4e55-9bb5-7b4b31f4849a`，API 确认 100% 流量；两个域名健康与权限检查通过，恢复 `maintenance=0`、`claimsEnabled=1`，本机设备协议 16、claim_ready=1。生产原聊天的三张待确认卡片已归并为一张，其余两张失效，静态入口引用 `index-DhS33mzA.js`。本轮不更换执行器安装包。

卡片重复修复需先应用 `0027_account_card_identity.sql`，再部署对应云端/Web。该增量迁移只增加身份摘要、归并引用和部分唯一索引；旧待确认密文由鉴权接口按需解密归并，不在 SQL 中写入明文或删除聊天游标。保留原 MASTER_KEY，协议 16 和已安装 0.13.0 不变。发布前暂停新增领取、确认无活动运行及待关闭浏览器，记录 Time Travel bookmark；健康及权限检查通过后恢复原开关。

2026-11-06 从源码 `cabdee8d9f8866ec42cd9def67e5647c359e7155` 部署账号管理与登录状态复用，Worker `96067a0d-ddc1-4398-8cc0-35b44de57881` 已承接 100% 流量，D1 0024–0026 与 `BROWSER_STATES` SQLite DO 已上线。迁移前暂停领取、确认无活动或未知运行，并记录 D1 Time Travel bookmark；云端部署后安装 Windows 0.13.0，确认协议 16、设备就绪和数据保留，再恢复 `maintenance=0`、`claimsEnabled=1`。两个域名健康与权限自检、Windows / Ubuntu CI、包内及系统实际安装 smoke 通过。保留原 MASTER_KEY，未发布 GitHub Release 或切换自动更新目录。

2026-11-05 聊天滚动与 iPhone Loading 兼容修复已从 `1777a1daca056d55a68f61733157c1141e9d81f2` 上线，活动 Worker 版本 `24ce3fa3-484b-4eb3-a06a-cf8312860257`（Cloudflare API 确认 100%）。主域健康、权限、JS/CSS 构建哈希及跨平台 CI 通过。CLI 上传成功后 Cron 核对遇网络错误；API 确认原定时配置正常，无需重复迁移或重建。备用 workers.dev 复检因本机网络连接重置未完成。桌面仍为 0.12.5；iPhone 真机验收未完成，详见 [ACCEPTANCE](ACCEPTANCE.md)。

2026-11-05 网站发送即时反馈已从源码 `3fa4d7161ac9df3b1322fd747ccb093a7bb29c66` 部署，Worker 版本 `198a7751-901d-4ef6-a17e-357f1a5e65c6`。两个域名健康与权限自检通过，主域引用新资源 `index-BGoiEkHm.js`。发布前活动运行 0，本轮无数据库结构或桌面执行器改动，Windows 实际安装仍为 0.12.5。

此前消息防重与按需截图修复：源码 `9ba3d511e6819ead7839c00fac073cc5b472f513`，Worker 版本 `f6f7a752-5348-4899-b1c8-57508a94c080`，Windows 实际安装版本 **0.12.5**。两域名健康及权限自检、Windows / Ubuntu CI、包内与实际安装 smoke 均通过；该轮无 SQL 结构迁移，沿用协议 15 和迁移 0022。系统快捷方式启动、配置保留与 ASAR 哈希证据见 [ACCEPTANCE](ACCEPTANCE.md)。未发布 GitHub Release 或切换自动更新目录。

以下为 0.12.2 的迁移部署基线：

2026-11-05 从干净源码提交 `05789de81dc377510536249a45abac4705f24254` 部署云端/Web，版本为 `ad3876af-4ada-4a2c-891f-f08eb55d5232`，协议 15，生产 D1 已迁移至 `0022_checkpoint_chunks.sql`。两个生产域名的健康、权限拒绝与静态资源哈希检查通过；领取恢复为 1、维护恢复为 0，设备心跳正常。该源码的 Ubuntu / Windows、Node 24 [远程 CI](https://github.com/zhangheng2022/taskrelay/actions/runs/42019037637) 均通过。

同一提交已生成并实际安装 Windows **0.12.2**。从桌面快捷方式启动的进程位于系统 `C:/Users/96227/AppData/Local/TaskRelay/app-0.12.2/TaskRelay.exe`，安装与构建 ASAR SHA-256 均为 `29b98cfb520fba6877c0c532700e1303b7c46015d283b309d8d2b1d6e29d9b17`；包内 smoke、实际安装 smoke 与 release-manifest 均通过。本地配置及 23 个 Profile 目录保留，没有清空历史或更改 MASTER_KEY；未发布 GitHub Release 或切换自动更新目录。证据与未验证范围见 [ACCEPTANCE](ACCEPTANCE.md)。

本次先暂停领取并确认无活动运行，保存 D1 Time Travel bookmark，再应用 `0021_context_withdrawal.sql`、`0022_checkpoint_chunks.sql` 并部署匹配代码。0021 会停止含历史已撤回消息的旧运行，以阻止继续使用已缓存内容；本次生产库没有此类旧记录。0022 增加检查点密文分块表，保留旧格式读取。不要直接用旧服务代码读取新分块格式；回退须评估新格式数据，不能只切换 Worker 版本。此次为常规升级，未重做此前的历史重置。

## 资源配置与已记录部署

- Cloudflare account：`b3a410496c5e49e582b4af19d2f2eec6`
- Worker：`taskrelay`，每分钟 Cron
- Durable Objects：`ModelEgress`、`RequestCoordinator`、`Scheduler`、`AiTurn`、`Evidence`、`NotificationHub`、`BrowserStateStore`，均为 SQLite 后端。ModelEgress 每次模型调用一个短期对象，限制在 `us` jurisdiction；迁移依次为 `model-egress-v1`、`free-runtime-v1`、`free-turn-v1`、`browser-state-v1`。
- D1：`taskrelay` / `9d387f48-6e34-4af4-a2a0-10f958d65a16`
- 旧私有 R2：`taskrelay-evidence` 保留，但生产不再绑定或使用；当前聊天图片使用加密 DO，随聊天删除。
- Access：`TaskRelay` / `6cd2c9dc-ba3c-4969-9aaf-83ea360c398f`
- 主站：`https://tr.zhangheng.eu.org`；旧入口：`https://taskrelay.zhangheng.workers.dev`

两个域名统一通过应用自身会话认证。原 Access 应用与 owner allow 策略保留，新增 `TaskRelay application authentication` bypass 策略 `1ad2c9f8-cee7-427a-8f9e-39409a68422b` 允许到达 Worker；它不是 Worker 内部权限旁路。切换后两个域名均验证：匿名 user/admin 为 401，Bearer 访问 user/admin 为 403，旧 device/user 为 403，无令牌 device/status 为 401。当前设备协议 16 仍校验令牌和租约；配对批准只允许应用管理员。预览 URL 关闭。

故障时首先保持 `REGISTRATION_OPEN=0`、将 D1 settings 的 `claimsEnabled` 设为 `0`；如需外层收紧，删除上述新增 bypass 策略即可恢复原 Access owner 限制。不要回退到旧设备管理接口，也不要重新生成 `MASTER_KEY`。

## 发布

```powershell
cd apps/web
npx wrangler d1 migrations apply taskrelay --remote
npm run deploy
```

`MASTER_KEY` 已配置为 Workers Secret。**不要再次执行初次密钥生成脚本，不要覆盖现有主密钥。** 现有模型密钥、账号密码和短期回复都依赖它解密。迁移/恢复时必须同时保留该密钥和 D1 数据。仓库及诊断包不保存主密钥；需要持有者从自己的秘密管理设施维护备份和轮换策略。

新部署到另一账号时，先创建空 D1 / Access 应用，替换 wrangler 配置，保留 SQLite DO 迁移，再对该全新空库执行一次 `node scripts/provision-secret.mjs --initial-empty-database`。不创建 R2。脚本通过标准输入传递随机密钥，不输出或落盘。

模型地址先校验 HTTPS、域名、IP 和 DNS 结果，拒绝私网及带 URL 凭据的地址。Workers 使用 `redirect: manual`，显式拒绝重定向，避免将 Authorization 转发到别的地址。不能使用 Workers 不支持的 `redirect: error`。

`GET /api/admin/settings/check` 是管理员有限自检，只返回数据库、加密和固定模型域名 DNS 校验结果，不返回密钥。`node scripts/cloud-self-check.mjs` 仅检查协议、匿名拒绝、Bearer 管理权限拒绝，不再创建诊断设备或借用设备令牌管理模型。真实模型测试在管理员网站执行。

## 工作空间域名

主入口为 `https://tr.zhangheng.eu.org`，原 `https://taskrelay.zhangheng.workers.dev` 保留。自定义域名已在 `apps/web/wrangler.jsonc` 的 `routes` 中声明为 `custom_domain: true`，指向同一 `taskrelay` Worker；不创建另一套 D1/R2/模型配置。

两个主机名纳入同一个 TaskRelay Access application，当前通过上述 bypass 切换到应用认证；旧入口也没有保留 owner JWT 或设备管理权限。网站注册、发信及重置回调以新主域名为准，用户应使用主入口；原地址继续支持 v2 设备执行接口。HTTPS 验证使用正常证书校验。

已配对客户端可继续使用原地址；新配对可填写新域名。回退域名时只撤下自定义域名绑定/配置并保留原地址，不轮换 MASTER_KEY、不重建 Access 应用或数据存储。

## 模型出站实现

所有能力测试、任务解析、Stagehand 模型回调及人工协助解析统一经过 `MODEL_EGRESS`，由美国区域 Durable Object 的 alarm 发起上游请求。网页和设备请求只提交加密的推理作业，不转发原始 Request、IP 或地区头。API Key 仍由云端从 D1 解密，网站和客户端均拿不到明文。缺少出站绑定会明确失败，不回退到带访问者上下文的直接请求。

普通 Worker 即使指定美国 placement，实际测试仍可能向 OpenAI 保留访问者的地区上下文：2026-11-03 实测执行位置 `remote-IAD`，但 OpenAI trace 的 `loc=HK`，模型返回 `unsupported_country_region_territory`。改为独立 alarm 后，同次诊断分别显示普通请求 `HK/HKG`、后台请求 `US/IAD`（另一次为 `US/ATL`），现有 `gpt-6-luna / Responses` 的连接、工具和严格 Schema 测试全部通过。因此没有保留无效的全站 placement 提示，也没有伪造地区头。

作业及结果短期加密并分块保存；领取结果确认后删除密文，未确认的记录在 3 分钟后清理。alarm 在上游请求前持久化 running 状态；中断后返回 `MODEL_CALL_OUTCOME_UNKNOWN`，不会自动再次调用供应商。任务状态和调度仍以 D1 为权威。

2026-11-03 修复自定义域名地区拒绝：旧实现先 `submit`，再由访客请求反复 RPC `wait`。Durable Object 共享 I/O 上下文，后进入的等待请求会成为当前入站请求；在模型配置/DNS 异步准备期间可能重新带入访客上下文。现在 `submitAndWait` 一次 RPC 同时提交并等待，内部最多等待 90 秒；alarm 期间没有新的读取 RPC，终态才 ack。没有新增 Worker、改动 DNS/Access、伪造地区头或更换密钥/模型。不要恢复外部 RPC 轮询，也不要仅凭独立 trace 判定真实推理成功。

诊断命令：`node scripts/cloud-self-check.mjs`，对照原地址加 `--origin=https://taskrelay.zhangheng.workers.dev`。旧 `--egress` / `--probe-existing` 参数已拒绝，避免恢复设备管理通道。管理员网站的能力测试继续经美国 alarm 链路，会产生实际模型用量，原始密钥不离开 Workers。

参考：[Cloudflare 数据区域约束](https://developers.cloudflare.com/durable-objects/reference/data-location/)、[alarm 执行语义](https://developers.cloudflare.com/durable-objects/api/alarms/)、[workerd I/O 上下文实现](https://github.com/cloudflare/workerd/blob/main/src/workerd/io/io-context.h)（`getIoChannelFactory` 使用当前入站请求，`incomingRequests` 按最近开始排序）。区域出站不能替代供应商的账号、项目或模型权限检查。

## 数据与执行恢复

云端为任务和调度权威，D1 事务完成领取、设备并发和账号锁。模型配置更新生成新版本，运行持有任务/模型版本快照。

0.12.0 使用协议 15 / `relay-graph-1`。先应用 `0020_graph_orchestration.sql`，再部署云端并安装桌面；迁移将旧 dispatch 记录退休，不会删除任务历史或将旧 checkpoint 恢复到新图。云端规划和协助通过 D1 事件与 AiTurn alarm 推进，纯等待节点由绑定当前问题的回复恢复。桌面只恢复同一 utilityProcess 内的等待，不跨进程重播浏览器动作。

本次已授权历史重置使用 `historyEpoch=4`。执行维护前暂停领取并确认无活动运行，先关闭旧聊天和图写入，再清理图片正文、任务及派生数据；保留用户、账号、模型、设备、密钥、登录 Profile 与独立用量。新桌面空闲且没有未决 journal/outbox 时才能升级设备协议并接受历史代次。一般版本升级不再次清空历史；不能把此次维护方式作为异常任务的自动恢复策略。

Main 在产生浏览器副作用前记录 SQLite 检查点。云端也先记录动作意图，再让执行器执行。事件及终结事实放入持久化 outbox；旧代次和旧租约不能推进新运行。已执行写入但最终结果不明时保留账号锁，失败或租约到期不会触发盲目重放。未决写入保留账号锁；历史 unknown 不自动恢复。

默认心跳 15 秒、租约 90 秒，全机同时执行一个任务。0.9.0 取消固定执行时长、动作数和人工等待业务期限。调度最多补最近一小时内最后一次。停止本机执行先关闭自有浏览器和执行进程，不等待网络请求。

未知结果可能长期阻止账号继续运行，这是保守恢复的预期行为；首版没有绕过核查的强制解锁入口。复杂 iframe/新标签页工作流、不能通过输入/扫码/确认完成的验证可能不受支持，并应保留明确失败记录。

升级保留 userData。0.4.7 起安装版支持版本检查、提醒、确认后下载及空闲安装，旧客户端首次启用仍需新安装包。客户端拒绝读取高于自身支持版本的 SQLite。常规卸载是否保留用户数据、干净机器升级及代码签名状态必须按验收表实际记录。

## Windows 更新交付

依赖清单固定经过验证的解析版本；Dependabot 每周一北京时间 09:00 创建更新 PR，不自动合并或部署。框架与桌面依赖升级须重新运行生产入口回归、浏览器资源准备、打包及实际安装验证。`prepare:browser`、资源校验和发布清单共同读取桌面清单的 Stagehand 版本；不在脚本中另外固定旧版本。Cloudflare 工具链现有 Miniflare beta、Hono CLI next 通道保持显式版本，其他直接依赖使用正式 release。

桌面生产依赖另由 `scripts/runtime-package-lock.json` 锁定；依赖更新后执行 `node scripts/stage-runtime.mjs --update-lock` 并审查该锁文件，普通打包只执行 `npm ci`。每个 Stagehand release 的公开扩展标识保存在 `resources/stagehand-<版本>-public-key.txt`，新增版本须一同提交；它只固定 Chromium 扩展身份，不是账号加密密钥。启动时仅启用当前版本扩展，避免旧 Profile 的扩展运行缓存与新 SDK 混用，保留站点存储。

先提升 `apps/desktop/package.json` 版本并同步锁文件，再运行 `npm run make` 和本次产物的 smoke。暂存运行时包使用桌面应用版本，Squirrel 的版本目录和 nupkg 必须一致。交付不能停留在直接运行 `out/TaskRelay-win32-x64/TaskRelay.exe`。

安装前保存本地数据并检查未完成运行；安装后从桌面或开始菜单的实际入口启动，核对进程路径、版本和 `resources/app.asar` 的 SHA-256，再验证安装目录 smoke。`node scripts/release-manifest.mjs` 会拒绝旧报告、错误版本或不匹配的 ASAR；安装路径取自实际自检报告，不按环境变量猜测。报告同时记录执行程序、资源目录与运行扩展路径。0.4.6 起扩展从应用自有内容寻址目录加载，文件集合和字节哈希必须与安装资源一致，不修改原始安装文件或系统访问控制。

在 Codex MSIX 环境中，逻辑上的 `%LOCALAPPDATA%/TaskRelay` 可能实际位于 Codex 的 `LocalCache/Local/TaskRelay`；Roaming 数据也可能重定向。该副本的安装成功不证明 Windows 桌面快捷方式对应的系统安装已更新。若清单出现重定向路径，应从 Windows 的运行/资源管理器入口执行同一安装包，并单独验证系统安装与快捷方式。不要把另一数据目录的备份或配置一致性结论套用到系统目录。

## GitHub 源码检查与发布边界

`.github/workflows/ci.yml` 在 PR、master 推送与手动触发时运行 Ubuntu / Windows、Node.js 24 的矩阵检查。使用 npm ci、完整测试、类型检查、Web 构建与仓库检查；Actions 固定提交 SHA，GITHUB_TOKEN 仅 contents:read，检出后不保留凭据。CI 不生成本地开发密钥、不迁移生产、不请求真实模型、不自动安装客户端或发布 Release。跨平台源码检查不是干净 Windows 安装验收。

README 负责使用入口与状态，CHANGELOG 记录客户端版本的变更，ACCEPTANCE 保留逐项证据。需要发布时从明确、干净的源码提交构建，先完成 make，再取得本次打包/实际安装 smoke 和系统入口证明，整理脱敏附件后发布预览版。不得将含本机绝对路径的原始清单、Profile 或诊断数据库上传为公开附件，也不得复用另一版本的报告。自动更新通道的实际发布状态见验收台账。

### 自动更新通道（0.4.7 起）

公开更新版本以 apps/cloud/src/desktop-releases.json 与生产更新目录为准，不能用源码版本或本机安装版本推断。历史公开预览和升级检查不代表当前版本已发布，也不代表干净 Windows 和长期运行验收完成。

- 执行器启动 15 秒后及每 6 小时检查一次，也可从窗口或托盘“检查更新”。更新地址固定为 `https://tr.zhangheng.eu.org/api/updates/windows-x64/latest.json`，不随配对的工作空间地址变化。只有 Windows x64 Squirrel 安装版启用；开发及解压运行明确显示不可用。
- 新版本显示更新说明并发 Windows 通知。用户确认“下载并安装”后才下载完整 nupkg。下载仅请求同一 Cloudflare 域名，拒绝重定向，不发送设备令牌。大小、SHA-256 和 SHA-1 均验证后生成只含本地文件名的 RELEASES；Squirrel 仅使用该本地目录，没有第二条网络链路。
- 下载期间原任务继续运行。下载完成后自动暂停新增领取，等待正在领取的请求、执行/人工等待、浏览器与子进程清理、RPC 和结果回传结束，再安装重启。原“暂停领取”偏好不变；回传失败则继续等待，不强停任务或清空 outbox。更新不解锁 unknown 账号、不重放写入。确认不跨应用重启保存；中途关闭后须重新确认，失败支持重试，新下载会清理应用自有旧下载缓存。
- Worker 只对目录中固定版本/哈希/文件路径提供流式下载。源限定为 `zhangheng2022/taskrelay` 的 `v<版本>` Release；仅在 CF 内跟随 GitHub 的指定资产域名，绝不向客户端返回 Location，不转发用户的 Cookie/Authorization，不启用 R2 或付费服务。

发布步骤：

1. 提升桌面版本并同步锁文件，完成 make、包内/实际安装 smoke 和系统入口/ASAR 核验，执行 `node scripts/release-manifest.mjs`。
2. 将简短更新说明保存为本地文本，执行 `node scripts/prepare-update.mjs <更新说明文件>`。脚本核对当前版本、验收清单和包哈希，只生成 `out/desktop-release.json`，不上传、不启用通道；不能使用旧版清单。
3. 将本次 `TaskRelay-<版本>-full.nupkg` 与 Setup 发布到上述仓库可公开下载的 `v<版本>` Release。私有仓库/未发布草稿不能作为此通道来源；不得把 GitHub token 配到客户端。已发布版本的包不可替换，修复必须提升版本。
4. 将生成条目追加到 `apps/cloud/src/desktop-releases.json` 的 `releases`，更新 `latest`，保留历史条目供已确认的下载继续使用，然后构建并部署 Cloudflare Worker。`latest:null` 表示尚未发布，客户端不会误报“已是最新版”。
5. 从 CF 地址检查 latest 和 nupkg：应直接返回 JSON/文件字节，无外部重定向；核对包 SHA-256。在测试安装上检查拒绝更新、确认下载、正在执行/人工等待/断网回传下不重启，以及空闲升级后的系统入口、版本、ASAR、配对和自启动。隔离 adapter 测试、包内 smoke 均不替代此真实升级验证。

实现依据：[Electron autoUpdater](https://www.electronjs.org/docs/latest/api/auto-updater)、[Squirrel 本地更新源](https://github.com/Squirrel/Squirrel.Windows/blob/develop/src/Squirrel/UpdateManager.DownloadReleases.cs)、[Cloudflare Streams](https://developers.cloudflare.com/workers/runtime-apis/streams/)。

## 历史外部配置撤销说明

本机 Clash Fake-IP 会触发执行器非公网地址保护。经用户许可，本次仅将 `example.com` 加入全局扩展脚本 `profiles/Script.js` 的 `dns.fake-ip-filter`，保留 blacklist 模式和其他条目；通过正在运行的服务模式本机接口重载，未放宽 TaskRelay 的 DNS/IP 检查。原文件备份为 Clash 配置目录中的 `profiles/Script.taskrelay-before-20261103.js.bak` 与 `clash-verge.taskrelay-before-20261103.yaml.bak`。如需撤销，恢复原全局脚本并在 Clash 中重新应用配置；不要把完整代理配置或订阅密钥复制进 TaskRelay 仓库。扩展语义参考 [Clash Verge 官方说明](https://www.clashverge.dev/guide/script.html)。其他任务站点未自动加入真实 DNS 名单。

以上为 0.2.0 当时的安装与 DNS 调整记录，不代表当前安装或领取开关。后续客户端已改用固定 HTTPS DNS；保留此处的外部配置撤销说明。


## 历史数据维护边界

一次性的 0.3.0 cutover 管理接口和 scripts/ai-cutover.mjs 已从源码移除，不再作为维护入口。历史 SQL 迁移、已安装数据兼容和正常保留期清理继续保留。

删除任务、聊天、运行或图片前，应按用户指定环境核对活动运行、未决结果、设备 outbox 与 journal；暂停新领取并先关闭聊天，阻止旧写入。图片须通过 Evidence 删除后再清索引，不能只删任务表。保留账号、模型、设备及 MASTER_KEY 的授权不可扩大为整库或整个 userData 删除。删除完成后核对数量与配置，按原状态恢复领取。浏览器 Profile 属于独立本地存储，删除数据库不表示 Profile 已删除。

## 聊天清理迁移（0023）

`0023_history_cleanup.sql` 新增任务删除/运行历史清理标记、持久清理作业与目标、旧请求迟到写入触发器和模型调用运行索引；不改 MASTER_KEY、账号、模型配置或设备。旧无归属模型响应缓存只保留防重摘要，已知执行调用回填 run_id，聊天消息和图片不由迁移删除。

发布前保存 maintenance/claimsEnabled 原值，开启维护并暂停领取，确认运行、聊天推理及模型调用均无活动项，再执行 `npx wrangler d1 migrations apply taskrelay --remote`。SQL 自带活动窗口校验，失败应排查并恢复开关，不绕过校验。随后部署新的 Web/Worker，检查服务、认证边界、schema 和资源文件，再恢复原开关。桌面协议 15、安装版本 0.12.5 保持兼容，本功能无需重装桌面。

2026-11-05 已按上述顺序完成生产迁移与部署：源码 `f96ca08`，Worker `dedc1df5-7075-4974-a86a-a096b023e04c`，Wrangler 上传与 triggers 均成功。主域资源哈希、健康与认证检查通过，原开关已恢复；生产未执行聊天清理。具体测试数量和边界见 [ACCEPTANCE](ACCEPTANCE.md#2026-11-05-聊天清理交付)。
