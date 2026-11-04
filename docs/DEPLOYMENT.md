# 部署与恢复

## 版本与验收入口

客户端源码版本以 `apps/desktop/package.json` 为准，当前为 0.4.11 更新候选；最近已公开预览及确认系统安装为 0.4.10，Cloudflare 更新目录已启用。0.4.11 本次打包、安装和发布进度以验收台账为准。本节依据仓库记录，不代表重新查询了线上或本机安装状态。

历史部署版本、哈希、测试数量和失败过程统一见 [ACCEPTANCE](ACCEPTANCE.md)，界面证据见 [UI-REVIEW](UI-REVIEW.md)。本文件维护操作与恢复规则，避免多个“最新补充”覆盖不同版本。

- 已有 D1 迁移至 `0008_report_run.sql`；报告必须绑定用户选中的 runId。协议与本地 SQLite schema 保持 3。
- 常规发布先应用 additive 迁移，再部署已构建的 Web/Worker，最后安装递增版本客户端。不能重复执行已完成的 epoch 3 历史清理。
- 保留 Free、美国模型出站、生产无 R2、`REGISTRATION_OPEN=0` 和 `DEV_MODE=0`；不得重新生成 MASTER_KEY、模型密钥或设备令牌。
- 回滚保留新增列与密文，不能退回普通 Worker 同步图计算、旧协议或旧出站链路。异常时先暂停领取，保留 unknown 与账号锁，不重放未知提交。
- Forge 使用同版本 Electron 包中的 `checksums.json` 校验缓存 ZIP，不关闭下载完整性检查。正式启动与 smoke 共用哈希校验的运行扩展目录，流程见下方 Windows 更新交付。

## 认证与迁移记录（2026-11-03）

本轮认证邮件改用 Brevo。Resend 添加 `mail.zhangheng.eu.org` 时拒绝免费公共域名；用户选择保留现有域名，`huiyunda.pl` 不用于 TaskRelay。

- Brevo 已认证 `mail.zhangheng.eu.org`，发件人 `TaskRelay <noreply@mail.zhangheng.eu.org>` 已验证。Cloudflare 配置了域名验证码、两条 DKIM CNAME（仅 DNS）及独立子域 DMARC。
- `BREVO_API_KEY` 必须为 Worker 的加密 Secret，不是普通文本变量；`MAIL_FROM` 为上述发件地址。已核对 `AUTH_SECRET`、`TURNSTILE_SECRET`、`MASTER_KEY` 仍保留，不重新生成主密钥。
- `identity.ts` 的邮箱验证及密码重置统一调用 `mail.ts` 的 Brevo HTTP API。只发送纯文本认证邮件，15 秒超时，拒绝重定向，不记录密钥、链接或上游响应，不自动重试未知结果。
- `REGISTRATION_OPEN=0` 保持不变。多人网站已发布，当前 Worker 版本 `4c9080de-673d-4d2a-bfd1-0fd781667c5d`（包含配对链接残留与任务域名识别修复）。生产迁移 `0005_multiuser.sql` 已执行，旧模型配置与密文保留。部署前任务、账号、运行、设备均为 0，账号锁为 0；数据库导出保存在忽略目录 `.cache/deploy-20261103/taskrelay-before-multiuser.sql`，不是交付附件。
- 远程邮件验收使用 `wrangler dev --remote` 的短期预览，仅继承 `BREVO_API_KEY`，绑定发件地址，不绑定生产数据库、证据存储或模型出站。Access 登录正常验证，没有关闭保护。检查返回 Brevo 账号 HTTP 200、`relay.enabled=true`；向用户指定邮箱仅提交一封测试邮件。Brevo 日志在北京时间 2026-11-03 18:27 显示 `Sent`、`Delivered`，确认收件服务器已接收；未据此推断收件箱分类。临时预览已关闭。

原 owner 已在正式网站注册并完成真实邮箱验证，绑定 `legacy_owner` 管理员，已建立正常会话。独立临时 D1 验证了真实 adapter 登录、角色隔离、并发模型额度、并发重置令牌单次消费、会话失效、密码写入中断保留旧密码且令牌不可重放，以及两个设备并发领取/重复领取单次计费；临时预览与测试库已清理。正式网站模型能力复验 2026-11-03 10:42 UTC 通过连接、工具和严格 Schema，3 次请求归属 owner 配额。真实密码重置邮件链接、完整多用户/双设备/故障流程仍按验收台账继续，不能由这些检查替代。

首次真实 D1 迁移被拒绝（已有数据表不能新增带非空默认值的 REFERENCES 列），D1 整体回滚后修复为兼容归属列与成员完整性触发器，重新迁移成功，`foreign_key_check` 无异常；新增带旧数据的回归测试。

## 资源配置与已记录部署

- Cloudflare account：`b3a410496c5e49e582b4af19d2f2eec6`
- Worker：`taskrelay`，每分钟 Cron
- Durable Objects：`ModelEgress`、`RequestCoordinator`、`Scheduler`、`AiTurn`、`Evidence`、`NotificationHub`，均为 SQLite 后端。ModelEgress 每次模型调用一个短期对象，限制在 `us` jurisdiction；迁移依次为 `model-egress-v1`、`free-runtime-v1`、`free-turn-v1`。
- D1：`taskrelay` / `9d387f48-6e34-4af4-a2a0-10f958d65a16`
- 旧私有 R2：`taskrelay-evidence` 保留，但生产不再绑定或使用；短期图片改为加密 DO。
- Access：`TaskRelay` / `6cd2c9dc-ba3c-4969-9aaf-83ea360c398f`
- 主站：`https://tr.zhangheng.eu.org`；旧入口：`https://taskrelay.zhangheng.workers.dev`

两个域名统一通过应用自身会话认证。原 Access 应用与 owner allow 策略保留，新增 `TaskRelay application authentication` bypass 策略 `1ad2c9f8-cee7-427a-8f9e-39409a68422b` 允许到达 Worker；它不是 Worker 内部权限旁路。切换后两个域名均验证：匿名 user/admin 为 401，Bearer 访问 user/admin 为 403，旧 device/user 为 403，无令牌 device/status 为 401。当前设备协议 3 仍校验令牌和租约；配对批准只允许应用管理员。预览 URL 关闭。

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

多人切换前的历史部署版本为 `9ab1a0cb-49d9-474b-9956-dc2cbd5384d0`（AI Elements 界面源码 `99c265b`）。新域名和原 workers.dev 使用同一 Worker、D1 和模型配置；新域名已登录网页再次通过真实模型生成待确认任务卡。2026-11-03 08:31 UTC 能力复验通过，后台出站 trace 为 `US/DFW`，详见 [ACCEPTANCE.md](ACCEPTANCE.md)。本轮 UI 改造未修改美国出站实现。

所有能力测试、任务解析、Stagehand 模型回调及人工协助解析统一经过 `MODEL_EGRESS`，由美国区域 Durable Object 的 alarm 发起上游请求。网页和设备请求只提交加密的推理作业，不转发原始 Request、IP 或地区头。API Key 仍由云端从 D1 解密，网站和客户端均拿不到明文。缺少出站绑定会明确失败，不回退到带访问者上下文的直接请求。

普通 Worker 即使指定美国 placement，实际测试仍可能向 OpenAI 保留访问者的地区上下文：2026-11-03 实测执行位置 `remote-IAD`，但 OpenAI trace 的 `loc=HK`，模型返回 `unsupported_country_region_territory`。改为独立 alarm 后，同次诊断分别显示普通请求 `HK/HKG`、后台请求 `US/IAD`（另一次为 `US/ATL`），现有 `gpt-6-luna / Responses` 的连接、工具和严格 Schema 测试全部通过。因此没有保留无效的全站 placement 提示，也没有伪造地区头。

作业及结果短期加密并分块保存；领取结果确认后删除密文，未确认的记录在 3 分钟后清理。alarm 在上游请求前持久化 running 状态；中断后返回 `MODEL_CALL_OUTCOME_UNKNOWN`，不会自动再次调用供应商。任务状态和调度仍以 D1 为权威。

2026-11-03 修复自定义域名地区拒绝：旧实现先 `submit`，再由访客请求反复 RPC `wait`。Durable Object 共享 I/O 上下文，后进入的等待请求会成为当前入站请求；在模型配置/DNS 异步准备期间可能重新带入访客上下文。现在 `submitAndWait` 一次 RPC 同时提交并等待，内部最多等待 90 秒；alarm 期间没有新的读取 RPC，终态才 ack。没有新增 Worker、改动 DNS/Access、伪造地区头或更换密钥/模型。不要恢复外部 RPC 轮询，也不要仅凭独立 trace 判定真实推理成功。

诊断命令：`node scripts/cloud-self-check.mjs`，对照原地址加 `--origin=https://taskrelay.zhangheng.workers.dev`。旧 `--egress` / `--probe-existing` 参数已拒绝，避免恢复设备管理通道。管理员网站的能力测试继续经美国 alarm 链路，会产生实际模型用量，原始密钥不离开 Workers。

参考：[Cloudflare 数据区域约束](https://developers.cloudflare.com/durable-objects/reference/data-location/)、[alarm 执行语义](https://developers.cloudflare.com/durable-objects/api/alarms/)、[workerd I/O 上下文实现](https://github.com/cloudflare/workerd/blob/main/src/workerd/io/io-context.h)（`getIoChannelFactory` 使用当前入站请求，`incomingRequests` 按最近开始排序）。区域出站不能替代供应商的账号、项目或模型权限检查。

## 数据与执行恢复

云端为任务和调度权威，D1 事务完成领取、设备并发和账号锁。模型配置更新生成新版本，运行持有任务/模型版本快照。

Main 在产生浏览器副作用前记录 SQLite 检查点。云端也先记录动作意图，再让执行器执行。事件及终结事实放入持久化 outbox；旧代次和旧租约不能推进新运行。已执行写入但最终结果不明时保留账号锁，失败或租约到期不会触发盲目重放。只读核查成功后才释放锁。

默认心跳 15 秒、租约 90 秒、自动执行 5 分钟/40 个动作、人工等待 5 分钟，全机同时执行一个任务。调度最多补最近一小时内最后一次。停止本机执行先关闭自有浏览器和执行进程，不等待网络请求。

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

2026-11-04 已公开 [0.4.10 预览版](https://github.com/zhangheng2022/taskrelay/releases/tag/v0.4.10)，生产更新目录已指向该版本；包的校验值与实际验证范围见 [验收记录](ACCEPTANCE.md)。仍为未签名的开发预览，不代表干净 Windows 和长期运行验收完成。

- 执行器启动 15 秒后及每 6 小时检查一次，也可从窗口或托盘“检查更新”。更新地址固定为 `https://tr.zhangheng.eu.org/api/updates/windows-x64/latest.json`，不随配对的工作空间地址变化。只有 Windows x64 Squirrel 安装版启用；开发及解压运行明确显示不可用。
- 新版本显示更新说明并发 Windows 通知。用户确认“下载并安装”后才下载完整 nupkg。下载仅请求同一 Cloudflare 域名，拒绝重定向，不发送设备令牌。大小、SHA-256 和 SHA-1 均验证后生成只含本地文件名的 RELEASES；Squirrel 仅使用该本地目录，没有第二条网络链路。
- 下载期间原任务继续运行。下载完成后自动暂停新增领取，等待正在领取的请求、执行/人工等待、浏览器与子进程清理、RPC 和结果回传结束，再安装重启。原“暂停领取”偏好不变；回传失败则继续等待，不强停任务或清空 outbox。更新不解锁 unknown 账号、不重放写入。确认不跨应用重启保存；中途关闭后须重新确认，失败支持重试，新下载会清理应用自有旧下载缓存。
- Worker 只对目录中固定版本/哈希/文件路径提供流式下载。源限定为 `zhangheng2022/taskrelay` 的 `v<版本>` Release；仅在 CF 内跟随 GitHub 的指定资产域名，绝不向客户端返回 Location，不转发用户的 Cookie/Authorization，不启用 R2 或付费服务。

发布步骤：

1. 提升桌面版本并同步锁文件，完成 make、包内/实际安装 smoke 和系统入口/ASAR 核验，执行 `node scripts/release-manifest.mjs`。
2. 将简短更新说明保存为本地文本，执行 `node scripts/prepare-update.mjs <更新说明文件>`。脚本核对当前版本、验收清单和包哈希，只生成 `out/desktop-release.json`，不上传、不启用通道；不能使用旧版清单。
3. 将本次 `TaskRelay-<版本>-full.nupkg` 与 Setup 发布到上述仓库可公开下载的 `v<版本>` Release。私有仓库/未发布草稿不能作为此通道来源；不得把 GitHub token 配到客户端。已发布版本的包不可替换，修复必须提升版本。
4. 将生成条目追加到 `apps/cloud/src/desktop-releases.json` 的 `releases`，更新 `latest`，保留历史条目供已确认的下载继续使用，然后构建并部署 Cloudflare Worker。源码目录初始 `latest:null`，表示尚未发布，客户端不会误报“已是最新版”。
5. 从 CF 地址检查 latest 和 nupkg：应直接返回 JSON/文件字节，无外部重定向；核对包 SHA-256。在测试安装上检查拒绝更新、确认下载、正在执行/人工等待/断网回传下不重启，以及空闲升级后的系统入口、版本、ASAR、配对和自启动。隔离 adapter 测试、包内 smoke 均不替代此真实升级验证。

实现依据：[Electron autoUpdater](https://www.electronjs.org/docs/latest/api/auto-updater)、[Squirrel 本地更新源](https://github.com/Squirrel/Squirrel.Windows/blob/develop/src/Squirrel/UpdateManager.DownloadReleases.cs)、[Cloudflare Streams](https://developers.cloudflare.com/workers/runtime-apis/streams/)。

## 0.2.0 历史安装与单域名 DNS 记录

安装包位于 `apps/desktop/out/make/squirrel.windows/x64/TaskRelay Setup.exe`，实际安装于 `C:/Users/96227/AppData/Local/TaskRelay/app-0.2.0`。桌面快捷方式启动、安装/构建 ASAR 哈希、两份新 smoke 均已核对；具体哈希和真实执行证据见 [验收](ACCEPTANCE.md)。不将本机安装证明当作干净 Windows 验收。

本机 Clash Fake-IP 会触发执行器非公网地址保护。经用户许可，本次仅将 `example.com` 加入全局扩展脚本 `profiles/Script.js` 的 `dns.fake-ip-filter`，保留 blacklist 模式和其他条目；通过正在运行的服务模式本机接口重载，未放宽 TaskRelay 的 DNS/IP 检查。原文件备份为 Clash 配置目录中的 `profiles/Script.taskrelay-before-20261103.js.bak` 与 `clash-verge.taskrelay-before-20261103.yaml.bak`。如需撤销，恢复原全局脚本并在 Clash 中重新应用配置；不要把完整代理配置或订阅密钥复制进 TaskRelay 仓库。扩展语义参考 [Clash Verge 官方说明](https://www.clashverge.dev/guide/script.html)。其他任务站点未自动加入真实 DNS 名单。

以上为 0.2.0 当时的安装与 DNS 调整记录，不代表当前安装或领取开关。后续客户端已改用固定 HTTPS DNS；保留此处的外部配置撤销说明。


## LangChain 0.3.0 一次性切换

此为已完成的一次性切换流程，保留用于恢复与审计；现有部署不得再次执行 apply。该版本不迁移旧会话内容。清理范围包括任务/版本、运行/动作/事件/报告/证据、协助、旧聊天、新 AI 会话/摘要/记忆/检查点/结果缓存和任务幂等记录。保留登录用户/角色/会话、站点账号及密文/设备绑定/Profile、模型配置及密钥、设备及 token、MASTER_KEY、认证/邮件/Turnstile 等部署密钥。当天已消费的模型/聊天额度保留，运行次数转存 `quota_carry`，不因清理返还额度。

切换必须按以下顺序，不能先删数据库再处理执行器：

1. 旧版本仍可连接时暂停领取，停止所有执行器；确认每台本地 outbox 已发送、journal 没有未终结记录。所有 unknown 写入必须先只读核查，不能删锁代替核查。保存各设备版本/路径、数量和验收证据，不导出密钥或凭据。
2. 完成源码测试、Web 构建、0.3.0 打包 smoke、隔离 D1 迁移与部署环境验收。真实地区/模型联调只能在部署环境完成；本机 workerd 的 region 错误不得绕过。
3. 应用 additive `0006_ai.sql`，进入维护并保持领取暂停，再发布新 Worker。先完成新生产构建的真实 D1 并发、鉴权与模型链路检查，再执行清理。不要通过重新运行 setup-local 或生成 MASTER_KEY 修复密文错误。
4. 安装 0.3.0，核对系统入口与 ASAR。设备以旧 token 请求 `/api/device/upgrade`，必须报告本地已无未完成记录，云端也无进行中/unknown 运行，才更新协议及就绪时间。所有未吊销设备均需在最近 10 分钟内就绪；不自动吊销离线设备。
5. 使用现有管理员登录会话操作 `scripts/ai-cutover.mjs`。Cookie 只从 `TASKRELAY_ADMIN_COOKIE` 环境变量读取，不把值放进命令行、仓库或日志。`--phase=check` 返回数量、阻断项及 digest；`--phase=prepare` 进入维护并暂停领取。
6. 核对预览后执行 `node scripts/ai-cutover.mjs --phase=apply --digest=<核对后的摘要> --deployment-validated --executors-stopped --outboxes-drained`。服务端再次检查运行、锁、设备、AI 活动回合及维护状态；仅删除 D1 明确记录的 R2 对象，不清空整个桶。D1 批处理内的 guard 防止并发状态变化后仍执行删除。R2 清理与 D1 不支持跨存储事务；D1 清理失败时维持维护，可在重新核查后重试。
7. D1 写入 `historyEpoch=3` 后，客户端才清空 cache/已结束 journal；有 outbox 或未结束 journal 时拒绝清理。config、safeStorage token 和浏览器 profiles 不变。高版本 SQLite 拒绝打开，不能覆盖重建。
8. 核对保留项、空历史、既有登录与设备授权、两种模型协议、创建/多轮恢复/确认/报告和真实浏览器流程后，运行 `--phase=finish --post-cutover-validated` 退出维护。此操作仍不自动开启领取或公开注册。

清理不可逆，发布回退只能回到协议 3 的安全版本；不得把旧协议 Worker 覆盖回来后继续执行。`ai_cutovers` 保存本次数量凭据，不包含凭据明文。本次交付是否已执行以上步骤以验收文档为准。

### 0.3.0 现场阻断记录（历史）

2026-11-03 现场发现 Workers Free 的请求 CPU 限制会中断本次 LangGraph 业务链路（1102 / exceededCpu）。`limits.cpu_ms=1000` 的发布被 Cloudflare 以 100328 拒绝，只有升级 Workers Paid 后才能重新发布该配置；不能通过删除限制配置声称业务已恢复。该历史阻断已由后续 DO 架构处理，当前约束仍为 Free，不能自动购买。官方说明：[CPU 限制](https://developers.cloudflare.com/workers/platform/limits/)、[套餐费用](https://developers.cloudflare.com/workers/platform/pricing/)。

历史切换已执行为 epoch 3，不应再次执行 apply，也不能降回协议 2。CPU 优化复测移除了从未生效的 `cpu_ms=1000` 配置，以便在现有 Free 套餐发布；这本身不增加额度。后续以 Free 架构的真实请求和任务闭环记录为准，不能把历史 CPU 优化当作验收通过。为测试用户写操作，切换后核对数据与设备即可退出维护，但领取仍需保持关闭；完成试运行前不得当作全量上线通过。

本机从 Codex 重定向目录迁到系统 Roaming 时，既有 safeStorage 密文依赖原 Local State 的 OS 加密上下文。仅复制 SQLite 会导致 decryptString 失败。应停机检查无 outbox/未完成 journal，保留原数据与 Profile，迁移完整的同应用加密上下文，保持数据库版本不回退；不能重新生成令牌或修改 MASTER_KEY 代替恢复。实际系统入口、ASAR 和目录 evidence 见验收台账。

## Cloudflare Free 运行架构

按用户要求，Cloudflare 不开通付费套餐，保留现有模型 API。普通 Worker 仅路由，Hono 在 RequestCoordinator DO 中运行；异步 AI 回合、调度、通知、证据各有独立 DO。`limits.cpu_ms` 不能在 Free 中提高，配置中没有该字段。SQLite DO 在 Free 可用，但不等于无限资源；到免费额度上限会失败/暂停，不能自动扩容或切换付费存储。

本次发布顺序：先保持领取关闭，应用 additive `0007_free_runtime.sql`，发布含三个 DO migration tag 的配置，退出维护验证网站，再安装 0.4.1 并完成只读试运行后恢复领取。已完成 epoch 3 历史切换，不重新执行 cutover，不改主密钥、模型密钥或设备令牌。原 R2 桶不删除，但绑定已移除；不存在生产 R2 回退。不能回退到同步 LangGraph 普通 Worker 请求路径。

项目平台预算按 UTC 日（北京时间 08:00）重置：模型 100、AI 回合 50、短期证据 100；8 个请求分片各 8000，运行恢复接口留至 9600。单证据最大 2 MB、最长 10 分钟。个人运行/对话额度仍按上海日重置。这些值限制业务规模，不能精确覆盖所有 DO 内部请求、D1 行读写或账户内其他应用；需查看 Cloudflare 实际用量。Free 不会自动转为付费，平台硬限额仍可能早于应用预算耗尽。该方案适合个人小规模，不能保证任意流量下连续可用。

网站和设备通过休眠 WebSocket 接收变化通知，断开时指数退避重连，站点隐藏时关闭连接；60 秒低频读取兜底，活动 AI 回合 15 秒兜底。客户端常驻的单个分片预算容纳每日约 2880 次状态/领取兜底及运行流量；租约心跳仍 15 秒，不以省额度牺牲运行恢复。

验证入口：`npm test`、`npm run typecheck`、`npm run check:repo`、`node scripts/test-free-runtime.mjs`、`npm run build`；Windows 还需新版本 make、包内/安装 smoke、系统快捷方式和 ASAR 对照。正式网站测试需记录请求状态与 outcome，不能用 Worker 启动时间或本地 CPU profile 替代真实 Free 运行结果。

执行器在 TUN fake-IP 环境使用固定 `https://cloudflare-dns.com/dns-query` 获取公网 DNS 答案。不能关闭 TUN/安全软件来通过验收，不能放行 198.18.0.0/15 或私网地址；DNS 答案不安全、证书错误和网络失败均保持拒绝。安装新客户端后再重试已明确失败且未产生写入的验收任务，unknown 写入仍须先核查。
