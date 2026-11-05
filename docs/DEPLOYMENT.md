# 部署与恢复

## 最近已记录部署

依据 [验收记录](ACCEPTANCE.md)，2026-11-05 最近已记录的云端/Web 部署版本为 `e15c198a-968f-430a-a368-c4ee994923e3`，协议 15，生产 D1 迁移至 `0020_graph_orchestration.sql`。最近已记录的系统安装为 0.12.0，实际路径 `C:/Users/96227/AppData/Local/TaskRelay/app-0.12.0/TaskRelay.exe`；安装与构建 ASAR SHA-256 均为 `d09ce5aadff134d73f1bb8a2b77a5a01cb29f15118864318fa346d4b9b7dc1f8`。这是历史验收事实，本轮未查询线上或系统安装的当前状态。

0.12.2 为本轮本地修复版本，尚未部署或替换系统安装。新增 `0021_context_withdrawal.sql` 与 `0022_checkpoint_chunks.sql` 只在隔离测试库验证；上线须先应用迁移，再部署匹配代码。0021 会停止含历史已撤回消息的旧运行，以阻止继续使用已缓存内容；0022 增加检查点密文分块表，保留旧格式读取。不要直接用旧服务代码读取新分块格式。此前卸载、重新安装及历史清理的顺序与剩余项以 [ACCEPTANCE](ACCEPTANCE.md) 为准。

## 资源配置与已记录部署

- Cloudflare account：`b3a410496c5e49e582b4af19d2f2eec6`
- Worker：`taskrelay`，每分钟 Cron
- Durable Objects：`ModelEgress`、`RequestCoordinator`、`Scheduler`、`AiTurn`、`Evidence`、`NotificationHub`，均为 SQLite 后端。ModelEgress 每次模型调用一个短期对象，限制在 `us` jurisdiction；迁移依次为 `model-egress-v1`、`free-runtime-v1`、`free-turn-v1`。
- D1：`taskrelay` / `9d387f48-6e34-4af4-a2a0-10f958d65a16`
- 旧私有 R2：`taskrelay-evidence` 保留，但生产不再绑定或使用；当前聊天图片使用加密 DO，随聊天删除。
- Access：`TaskRelay` / `6cd2c9dc-ba3c-4969-9aaf-83ea360c398f`
- 主站：`https://tr.zhangheng.eu.org`；旧入口：`https://taskrelay.zhangheng.workers.dev`

两个域名统一通过应用自身会话认证。原 Access 应用与 owner allow 策略保留，新增 `TaskRelay application authentication` bypass 策略 `1ad2c9f8-cee7-427a-8f9e-39409a68422b` 允许到达 Worker；它不是 Worker 内部权限旁路。切换后两个域名均验证：匿名 user/admin 为 401，Bearer 访问 user/admin 为 403，旧 device/user 为 403，无令牌 device/status 为 401。当前设备协议 15 仍校验令牌和租约；配对批准只允许应用管理员。预览 URL 关闭。

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
