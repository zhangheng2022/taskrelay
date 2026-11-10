# 部署与恢复

本文维护当前操作流程；发布版本、安装状态和失败记录统一见[验收索引](ACCEPTANCE.md#当前结果索引)。本文末尾保留历史章节锚点作为跳转入口。

## 2026-11-10 流式发布准备（0.21.0）

按下文固定 SHA 的 CI/Release 流程交付云端、网站和桌面；先应用增量 `0004_streaming_messages.sql` 并部署兼容旧客户端的服务，再发布 0.21.0 更新目录。旧网页只收 changed，旧执行器未声明 supportsDrafts 时不发布执行器正文草稿；固定模型版本的底层流式及完整响应返回保持兼容。没有新增付费服务、生产绑定或地区绕过。

回退由管理员 `PATCH /api/admin/streaming` 设置 `{"modelStreamingEnabled":false,"chatPreviewEnabled":false}`（需要有效管理员会话）；可分别启用。只影响随后开始的调用，不重试在途请求、不改模型、不开启旧任务恢复。读取同一路径的 GET 可查看模式、首片/完成耗时和异常计数。迁移包含新增列，回退功能不撤销数据结构；不得重建数据库或更换 MASTER_KEY。发布结果见[流式验收记录](ACCEPTANCE.md#2026-11-10-优先流式正式发布0210已完成)。

## 存储 v2 离线切换（保留数据参考流程）

以下流程仅适用于仍需保留旧结构数据的独立环境。生产已完成的全量重置是历史事件，不构成本次维护授权；一次性重置入口已退役。

存储 v2 初始切换时使用协议 18、图 relay-graph-4、桌面 SQLite 4；当前协议和版本以源码清单为准。下方既有 0001–0030 增量发布记录是历史证据，不能对旧结构直接执行新 `0001_storage_v2.sql`。常规 `release-production` 预检拒绝没有 storage_meta=2 或仍冻结的库；发布 API 的目标 ID 从唯一 Wrangler D1 配置读取。历史生产已完成独立基线切换；以下转换工具供其他仍需保留旧库的环境使用，不表示本次生产转换了历史。本机前批调试产物的包内 smoke 与本次托管正式安装证据分别记录，不混用。

1. 维护窗口先在旧代码中停接交办、暂停领取，等正在执行和浏览器清理结束，排空模型、图投递、命令、inbox、清理作业和设备待确认回执。unknown 已终态且清理确认的运行可保留，其账号锁不解锁、不重放。停止旧 Main；为源 D1 记录恢复点并导出，在受控本机完成 SQLite checkpoint。不得转换仍有非空 WAL 的文件。
2. 将 Worker 临时切换到 `scripts/db/freeze-worker.ts`，保留原 Worker、DO 类名/namespace/jurisdiction 和绑定；它对请求返回 503，alarm 只延后，不写 D1 或对象正文。必须先排空再冻结，不能用换代码中断仍有未知提交的 I/O。记录源恢复点、源文件 SHA-256、设备列表和已有 MASTER_KEY 的安全保管位置；**不得生成或覆盖 MASTER_KEY**。
3. 只读预检并核对每表数量、成员归属、密文和对象引用数量。未绑定旧成员的归属由操作者制作 `owner-bindings.json`（业务成员 ID → 已验证 auth_user ID），不能依赖首次登录接管。冻结对象正文的 GCM/分块核验在第 6 步完成；退休 checkpoint 的原格式不恢复，完整原库另行加密归档。

   ```powershell
   npm run db:convert -- --source <旧库.sqlite> --inspect
   npm run db:convert -- --source <旧库.sqlite> --target <新库.sqlite> --archive <旧库.archive.enc> --owner-bindings <owner-bindings.json>
   npm run db:convert -- --source <新库.sqlite> --target <私有导入.sql> --export
   ```

   命令从安全环境读取原 MASTER_KEY，不在参数或输出中打印密钥。转换拒绝未排空、非法归属、丢失身份、错误密钥、未映射表或缺失引用；输出 `.conversion.json` 清单和整体 AES-GCM 原库归档。历史 ID、版本和对象键保留，早期可见消息进入统一历史；旧图关闭并推进 generation，旧待确认卡失效。输入始终只读，重试核对源/目标/归档摘要；同源中断的 `.partial` 从头重建，完整归档必须通过认证，不能把部分文件当恢复点。导入文件包含私有数据，按数据库同等权限保管，禁止提交仓库。

4. 在同一账号、现有 Free 范围内另建独立 D1（仍只绑定一个业务库；若额度/资源数不够则阻断），先对**新库**应用当前基线，再以 Wrangler D1 `execute --file <私有导入.sql> --remote` 导入。导出文件只接受空新基线，延迟外键、事务内暂时移除触发器并在结束前恢复，逐表核对行数；长 JSON/密文以临时分块表组装为完整值后才写目标表。导入失败保留冻结状态，核验整次事务/恢复点后重试，不对半导入库续写或开放业务。核对 foreign_key_check、结构、数量、顺序、样本解密与对象引用；D1 行/值仍受平台 2 MB 限制。
5. 旧 Main 关闭并持有完整备份后，运行新版可执行文件的 `--taskrelay-convert-storage`，持有单实例锁，仅写独立 `taskrelay-v4.sqlite`，原 `taskrelay.sqlite` 保留。配置、generation、epoch、journal、待确认回执 ID/body 保留，时间转换为 UTC 毫秒，cache 不迁移。正常 Main 拒绝旧结构或更高版本，不重建。必须逐设备验证转换及包内/实际安装；用户无需安装 Node.js。终态/浏览器关闭回执可在升级后以原身份确认，未收尾检查点和其他旧请求仍阻止协议升级，不能为了升级清掉回执或 unknown。
6. 把唯一 D1 绑定改为已核验新库并部署匹配代码，DO 绑定及原 MASTER_KEY 保持不变；新库初始 maintenance=1、claimsEnabled=0、storageFrozen=1。通过原 Better Auth 管理员会话调用 `GET /api/admin/storage/status`，每批至多 10 个引用调用 `POST /api/admin/storage/objects/convert`，body 为 `{objects:[{kind:"evidence"或"browser-state",key:原对象键}]}`。入口只接受真实 D1 引用，逐块验证密文、键、顺序与大小后标记格式 2。缺对象/缺片/错误密钥/未来格式均阻断；pending 每次最多返回 50 条，循环至空。冻结期间仅保留必要会话登录、设备状态/升级和管理员存储控制入口；其他业务和后台写入暂停。
7. 核对全部设备、回执、对象及新库后，管理员调用 `POST /api/admin/storage/activate`，body 为 `{objectsVerified:true,clientsPrepared:true}`。数据库事务再次核对所有引用已有验证记录且无排队/活动/未清理运行，只取消 storageFrozen；维护与领取开关继续由受控发布流程恢复，不自动解锁账号。开放前可以整体退回原代码、原 D1/DO 元数据与旧 Main 恢复点；**开放写入后不得直接切回旧库**，需要新的停写与正向数据恢复方案。DO 元数据转换前也应保留对象恢复点，不能把只有 D1 备份称为完整回退。

源库、加密归档、对象恢复点和清单不自动删除。切换前还须核对清单目标字节数和导出写行估算：单库超过 500 MB 或导入所需读/写超过当日 Free 剩余额度时阻断，不在一个维护窗口内强行导入、不临时购买服务。估算不含全部 DDL、已有种子删除及并行认证活动，实际计量以 D1 meta 为准。此流程仍需匹配产物及实际源库预检通过后执行；隔离验证不证明生产 D1 并发、真实模型地区、实际 Windows 安装或网站闭环。

早期版本的图片、CDP、SDK 和安装记录见[验收索引](ACCEPTANCE.md#当前结果索引)，不属于当前离线转换步骤。

## 账号状态版本的发布要求（0.13.0）

历史 0024–0026 迁移、协议 16 与账号状态发布证据见[对应验收](ACCEPTANCE.md#2026-11-06-账号管理登录状态与串行账号组0130)。这些迁移现位于离线转换工具的旧结构目录，不是当前库待应用的迁移；常规升级按[发布流程](#发布)执行。

## 最近已记录部署

旧版部署证据见[验收索引](ACCEPTANCE.md#当前结果索引)及[历史补充证据](ACCEPTANCE.md#历史部署补充证据)。本节保留原锚点，不再重复维护版本、哈希与领取状态。

## 资源配置与已记录部署

当前部署目标以 [Wrangler 配置](../apps/web/wrangler.jsonc) 为准：Worker 为 `taskrelay`，D1 绑定名为 `DB`，数据库为 `taskrelay-v2-20261108`。配置中的数据库 ID、DO 迁移和绑定是结构权威，不在本文复制第二套清单。旧 `taskrelay` 业务 D1 已删除，不能用作当前迁移或回退目标。

Cloudflare 保持 Free，生产不绑定 R2；普通 Worker 负责轻量路由，业务与后台模型调用进入 SQLite DO。模型调用保留美国 jurisdiction 与 alarm，详见[模型出站实现](#模型出站实现)。不得自动切换付费服务。

主站与 workers.dev 使用应用会话认证；设备 bearer 只访问设备接口。历史 Access 配置标识及当时权限验证收录于[历史补充证据](ACCEPTANCE.md#历史部署补充证据)，不作为当前外部配置的实时保证。故障处理遵循[发布恢复](#发布)，不得更换 MASTER_KEY 或恢复旧设备管理接口。

## 发布

生产使用 **Release · 生产发布** 手动工作流；合并不自动发布。本机构建只用于开发，生产迁移、云端部署及正式 Windows 包由 GitHub 托管 Runner 完成。

1. PR 通过 `CI Gate · 合并检查` 后合并 master，等待合并提交自己的 **CI · 持续集成** 通过。仓库规则绑定该检查，不再生成旧的 quality-gate。
2. 在 master 运行 Release · 生产发布，通常选择 `scope=auto`、`mode=publish`；可指定完整 `source-sha`。预检核验同 SHA 的 master push，不接受 PR、其他提交或旧门槛；遗漏必要范围、桌面修改未提升版本、已公开版本均拒绝发布。CI 编排修改需要验收，但不会单独要求产品发版。
3. 优先复用 master 的 Web/Windows 候选；缺失、已过期或当时未生成的产品在生产写入前补建。Windows 始终完成真实 Chromium 状态测试、make、包内 smoke、实际安装、系统快捷方式启动和 ASAR 校验。PR 仍执行完整验收，只是不保存安装包。
4. Artifacts 作业核验来源、文件哈希和验收后，将选定文件和 release-plan 归档到本次运行。发布前审计一次根依赖和桌面 runtime 锁。production 作业重新校验清单与来源，D1 productionRelease 保存 bundleId、planHash、源 SHA、原开关、恢复点和阶段；恢复禁止重新构建替换。
5. 先暂停领取并等待清理，保存 Time Travel bookmark，再迁移和部署。GitHub Release 文件不可覆盖；更新目录登记后经 Cloudflare 下载验证大小/哈希才切换 latest。校验完成后恢复发布前的网页维护和领取开关，不等待或查询执行器在线就绪状态。没有可用执行器时任务仍须等待正常调度；设备授权、协议和领取校验保持不变。

production Environment 仅允许 master。Cloudflare 凭据和 Release 写权限仅授予 production 作业，不读取或覆盖 MASTER_KEY。控制脚本固定本次工作流提交，业务源码和依赖固定 source-sha；两者身份分别核对。

失败后保持现场，不能直接打开领取或回滚数据库。确认原运行结束后，以 `mode=resume`、原 `source-sha`、`recovery-run=首次发布运行 ID` 恢复。D1 阶段决定所需附件：迁移/部署前需要 Web 文件，桌面启用前需要安装包；旧 awaiting-device 记录只恢复原开关，不下载附件或查询设备。部署结果未知只核对 health，不再次部署。旧发布记录仍读取原附件和旧门槛；新发布必须使用新门槛和发布清单。

普通报告保留 7 天，master 候选及发布恢复归档保留 30 天。新发布可对缺失候选补建；恢复所需的原附件缺失则明确失败。运行摘要包含源提交、范围及恢复参数，`awaiting-device` 仅用于兼容旧记录，新发布不再进入此阶段。

### 合并门槛名称切换

名称切换已按以下顺序执行：先让第一阶段 PR 同时产生 `CI Gate · 合并检查` 和依赖它的 `quality-gate`，验证 PR 与 master 成功后，将 ruleset 的 required check 改为新名称，保留 GitHub App 绑定、严格检查及其余规则，第二阶段移除旧检查。切换保持 GitHub App 15368、严格检查和全部其他保护规则，未关闭保护；历史验收记录保留原工作流名称。

GitHub [上传接口会改写特殊文件名](https://docs.github.com/en/rest/releases/assets#upload-a-release-asset)。Squirrel 磁盘文件 `TaskRelay Setup.exe` 固定以 `TaskRelay.Setup.exe` 发布并核对返回名称；中断恢复也按公开名匹配，再比较大小和哈希。不能因本地名有空格而误判资产缺失，更不能删除重传已公开文件。

领取事务内再次检查暂停/维护开关，阻止早先读到旧开关的并发领取；管理员不能在未完成发布期间覆盖领取开关。旧结构的 `0028_release_claim_barrier.sql` 是历史迁移，当前基线已包含此保护，不应重复应用旧迁移。

`MASTER_KEY` 已配置为 Workers Secret。**不要再次执行初次密钥生成脚本，不要覆盖现有主密钥。** 现有模型密钥、账号密码和短期回复都依赖它解密。迁移/恢复时必须同时保留该密钥和 D1 数据。仓库及诊断包不保存主密钥；需要持有者从自己的秘密管理设施维护备份和轮换策略。

新部署到另一账号时，先创建空 D1 并配置应用认证，替换 wrangler 配置，保留 SQLite DO 迁移，再对该全新空库执行一次 `node scripts/provision-secret.mjs --initial-empty-database`。Access 仅作为可选外层限制，不创建 R2。脚本通过标准输入传递随机密钥，不输出或落盘。

模型地址先校验 HTTPS、域名、IP 和 DNS 结果，拒绝私网及带 URL 凭据的地址。Workers 使用 `redirect: manual`，显式拒绝重定向，避免将 Authorization 转发到别的地址。不能使用 Workers 不支持的 `redirect: error`。

`GET /api/admin/settings/check` 是管理员有限自检，只返回数据库、加密和固定模型域名 DNS 校验结果，不返回密钥。`node scripts/cloud-self-check.mjs` 仅检查协议、匿名拒绝、Bearer 管理权限拒绝，不再创建诊断设备或借用设备令牌管理模型。真实模型测试在管理员网站执行。

## 工作空间域名

公开注册由 `apps/web/wrangler.jsonc` 的 `REGISTRATION_OPEN` 控制，`"1"` 开放，`"0"` 关闭普通邮箱新注册；变更须走上述正式发布流程。关闭不会删除已有账号或撤销既有会话。发布后读取主域 `/api/auth/config` 核对 `registrationOpen`，保留 `TURNSTILE_SECRET`、`TURNSTILE_SITE_KEY`、`BREVO_API_KEY` 与 `MAIL_FROM` 的现有配置；注册仍须完成人机验证和邮箱验证。线上开放及验证证据见 ACCEPTANCE。

主入口为 `https://tr.zhangheng.eu.org`，原 `https://taskrelay.zhangheng.workers.dev` 保留。自定义域名已在 `apps/web/wrangler.jsonc` 的 `routes` 中声明为 `custom_domain: true`，指向同一 `taskrelay` Worker；不创建另一套 D1/R2/模型配置。

两个主机名均使用应用认证；历史 Access 切换证据见[验收补充](ACCEPTANCE.md#历史部署补充证据)，旧入口也没有保留 owner JWT 或设备管理权限。网站注册、发信及重置回调以新主域名为准，用户应使用主入口；原地址继续支持 v2 设备执行接口。HTTPS 验证使用正常证书校验。

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

旧 0.12.0 / 协议 15 的迁移记录见[历史验收](ACCEPTANCE.md#2026-11-05-云端粗步骤与-langchain--langgraph0120--协议-15)，不再作为当前升级步骤。云端规划和协助通过 D1 事件与 AiTurn alarm 推进，纯等待节点由绑定当前问题的回复恢复。桌面只恢复同一 utilityProcess 内的等待，不跨进程重播浏览器动作。

早期一次性历史重置曾使用 `historyEpoch=4`，仅为历史记录。执行维护前暂停领取并确认无活动运行，先关闭旧聊天和图写入，再清理图片正文、任务及派生数据；保留用户、账号、模型、设备、密钥、登录 Profile 与独立用量。新桌面空闲且没有未决 journal/outbox 时才能升级设备协议并接受历史代次。一般版本升级不再次清空历史；不能把此次维护方式作为异常任务的自动恢复策略。

Main 在产生浏览器副作用前记录 SQLite 检查点。云端也先记录动作意图，再让执行器执行。事件及终结事实放入持久化 outbox；旧代次和旧租约不能推进新运行。已执行写入但最终结果不明时保留账号锁，失败或租约到期不会触发盲目重放。未决写入保留账号锁；历史 unknown 不自动恢复。

默认心跳 15 秒、租约 90 秒，全机同时执行一个任务。0.9.0 取消固定执行时长、动作数和人工等待业务期限。调度最多补最近一小时内最后一次。停止本机执行先关闭自有浏览器和执行进程，不等待网络请求。

未知结果可能长期阻止账号继续运行，这是保守恢复的预期行为；首版没有绕过核查的强制解锁入口。复杂 iframe/新标签页工作流、不能通过输入/扫码/确认完成的验证可能不受支持，并应保留明确失败记录。

升级保留 userData。0.22.0 源码改为实时检查、自动下载及空闲安装重启；旧安装版首次升级仍需确认，实际发布状态见验收台账。客户端拒绝读取高于自身支持版本的 SQLite。常规卸载是否保留用户数据、干净机器升级及代码签名状态必须按验收表实际记录。

## Windows 更新交付

### 自签名与设备信任

证书使用 `CN=TaskRelay`、RSA 3072、SHA-256、代码签名用途、三年有效期。公开证书及 SHA-256 指纹位于 `resources/signing/`；PFX、密码和备份元数据仅保存在管理员指定的 OneDrive `TaskRelay/signing/<SHA-256>/` 目录。PFX 与密码同目录属于同一个私密存储边界，禁止提交、日志输出或上传构建附件。已有备份不覆盖；现有 MASTER_KEY 不参与签名。

首次生成只执行一次：`pwsh -NoProfile -File scripts/signing-certificate.ps1 -Action Create`。默认私密根目录为当前开发机约定的 OneDrive TaskRelay 目录；其他管理员必须显式传 `-PrivateRoot`。仅把生成的 `TaskRelay.cer` 和 `certificate-info.json` 复制到 `resources/signing/`。GitHub `windows-signing` 环境限制 `master` 分支，分别保存 `TASKRELAY_SIGNING_PFX_BASE64`、`TASKRELAY_SIGNING_PASSWORD`；不在命令行参数中填写密码。到期前 90 天构建发出提醒，正式签名前拒绝过期证书。轮换时先分发新证书再切换构建；泄漏时停止签名、移除旧信任并部署新证书，不依赖在线吊销。

设备管理员先从独立可信渠道核对公开证书 SHA-256 指纹，再以管理员 PowerShell 执行以下独立命令。安装器不自动安装根信任；本机 `Prepare` 也不修改根信任。

```powershell
pwsh -NoProfile -File scripts/signing-certificate.ps1 -Action Trust
pwsh -NoProfile -File scripts/signing-certificate.ps1 -Action Check
# 仅移除该公开证书，不删除其他根证书：
pwsh -NoProfile -File scripts/signing-certificate.ps1 -Action Untrust
```

脚本将公开证书放入 `LocalMachine/Root` 和 `LocalMachine/TrustedPublisher`，重复执行不重复导入；指纹不匹配则停止。自签名只提供持有该私钥的签名来源与文件完整性，不提供公开 CA 身份背书，不保证消除 SmartScreen 提示。

Actions 正式构建只接受主分支 push 或手动发布及 master 上的源码提交；PR 使用无秘密的 `windows-signing-test` 环境与一次性测试证书。`Prepare -TrustBuildMachine` 仅允许 GitHub 托管 Runner，在隔离机器建立测试信任。签名使用 SHA-256 与 `http://timestamp.digicert.com` RFC 3161 时间戳，最多尝试三次，失败停止。make 结束立即执行 `Seal` 删除临时私钥，完成验签后再执行 `Cleanup` 移除本次导入的信任及临时文件；失败也执行清理。测试证书不能归档或发布。

显式轮换使用 `Create -Rotate`，在新指纹目录写备份，不覆盖旧文件。切换仓库公开证书和 Actions secrets 前先完成进行中的发布及恢复，再向设备分发新公开证书。旧未签名版本只有在恢复路径提供原 D1 固定 planHash 时才可继续；新的归档或发布不能使用此兼容例外。

顺序为 make 内签名、外层及包内签名验证、打包 smoke、实际安装 smoke、安装入口签名验证、release-manifest、prepare-update、归档。`signed` 来自实际签名证据，不是固定布尔声明；完整报告同时记录受控验收机上的信任状态。发布拒绝未签名、证书不匹配、缺少时间戳、陈旧或不一致的证据。nupkg 本身沿用现有哈希校验，签名对象是其中的 PE 入口。验收后的文件不得再次签名、重建或覆盖公开版本。

### 构建与安装验证

依赖清单固定经过验证的解析版本；Dependabot 每周一北京时间 09:00 创建更新 PR，不自动合并或部署。框架与桌面依赖升级须重新运行生产入口回归、浏览器资源准备、打包及实际安装验证。`prepare:browser`、资源校验和发布清单共同读取桌面清单的 Stagehand 版本；不在脚本中另外固定旧版本。工具链版本及预发布标记以根清单和锁文件为准，不从历史说明推断当前通道。

桌面生产依赖另由 `scripts/runtime-package-lock.json` 锁定；依赖更新后执行 `node scripts/stage-runtime.mjs --update-lock` 并审查该锁文件，普通打包只执行 `npm ci`。每个 Stagehand release 的公开扩展标识保存在 `resources/stagehand-<版本>-public-key.txt`，新增版本须一同提交；它只固定 Chromium 扩展身份，不是账号加密密钥。启动时仅启用当前版本扩展，避免旧 Profile 的扩展运行缓存与新 SDK 混用，保留站点存储。

先提升 `apps/desktop/package.json` 版本并同步锁文件，通过 PR 合并。正式 make、浏览器状态迁移测试和本次产物 smoke 在 Actions 的 Windows 作业执行；本地 make 仅用于开发。暂存运行时包使用桌面应用版本，Squirrel 的版本目录和 nupkg 必须一致。交付不能停留在直接运行 `out/TaskRelay-win32-x64/TaskRelay.exe`。

安装前保存本地数据并检查未完成运行；安装后从桌面或开始菜单的实际入口启动，核对进程路径、版本和 `resources/app.asar` 的 SHA-256，再验证安装目录 smoke。`node scripts/release-manifest.mjs` 会拒绝旧报告、错误版本或不匹配的 ASAR；安装路径取自实际自检报告，不按环境变量猜测。报告同时记录执行程序、资源目录与运行扩展路径。0.4.6 起扩展从应用自有内容寻址目录加载，文件集合和字节哈希必须与安装资源一致，不修改原始安装文件或系统访问控制。

在 Codex MSIX 环境中，逻辑上的 `%LOCALAPPDATA%/TaskRelay` 可能实际位于 Codex 的 `LocalCache/Local/TaskRelay`；Roaming 数据也可能重定向。该副本的安装成功不证明 Windows 桌面快捷方式对应的系统安装已更新。若清单出现重定向路径，应从 Windows 的运行/资源管理器入口执行同一安装包，并单独验证系统安装与快捷方式。不要把另一数据目录的备份或配置一致性结论套用到系统目录。

## GitHub 源码检查与发布边界

Windows 浏览器程序资源必须允许 Chromium LPAC 子进程读取／执行；Main 在首次启动前为自有 `resources/browser/chrome-win64` 校验路径并补齐该 ACL。只有公开程序资源获得权限，不给 Profile、父目录或应用数据授权；链接和权限设置失败均阻止浏览器启动。打包 smoke 与独立状态迁移测试实际经过此入口，禁止用关闭沙箱替代。

发布自动化的健康与下载校验使用现有 `https://taskrelay.zhangheng.workers.dev`，固定目标、禁止重定向、不携带用户会话。主站 `tr.zhangheng.eu.org` 的 Bot Fight Mode 会向部分托管 Runner 发出人机挑战；免费版不能按路径豁免（[官方限制](https://developers.cloudflare.com/bots/get-started/bot-fight-mode/)）。保留全域防护、主站及客户端更新地址；不要以关闭防护或放行全部 Actions IP 解决发布检查。站点实际访问和权限检查另在正常客户端核验。

`.github/workflows/ci.yml` 在 PR、master 推送、手动触发及每周一北京时间 09:00 执行。检查格式、Oxlint 类型规则、TypeScript、仓库一致性、Windows/Ubuntu 测试、Ubuntu c8 覆盖率、CodeQL security-extended 实际结果、Gitleaks、High/Critical 依赖漏洞、actionlint/ShellCheck/PSScriptAnalyzer 和 Web 构建。执行器相关改动追加托管 Windows 打包及实际安装 smoke。总门槛 CI Gate · 合并检查对失败、取消、缺少报告均关闭；纯文档按白名单走轻量检查，未知范围全量。旧 quality-gate 仅用于已存在发布记录的恢复校验。

所有 Actions 固定提交 SHA，PR 不接触生产 Environment，默认 contents:read，CodeQL 仅额外获得 security-events:write。统一命令为 `lint`、`format:check`、`format`、`test:coverage`、`check:workflows`、`quality`。Ubuntu 覆盖率下限由 `scripts/coverage-baseline.json` 固定，后续不可降低；后续 PR 修改的可执行行至少 80%，纯格式差异归一化后排除。报告保留七天，不自动发评论或调用外部审查模型。PR 只保存 Windows 验收报告，master 保存完整候选，正式发布归档选定的同一份文件。

质量工具的固定 GitHub 网页下载入口出现网络错误或非成功状态时，可通过官方 API 核对原仓库、tag、文件名和原下载地址，再下载同一资产；仍按原 SHA-256 校验，成功响应但哈希不符直接拒绝。CI 仅向相关检查步骤提供只读 github.token，令牌只用于 api.github.com，资产跨域下载不携带令牌并限制官方主机。此路径不使用镜像、不降低质量门槛；CodeQL 自身下载失败通过重试作业处理。

浏览器及 Electron 元数据获取最多尝试三次，失败间隔为 0.5／1 秒；400／401／403／404／410 直接拒绝。HEAD 缺少有效大小、返回 405／501 或临时网关/限流错误时，使用受大小限制的一字节 Range 探测，必须满足 206、精确范围、合法总长及实际一字节正文；日志仅记录状态码、curl 退出码和解析后的大小，不输出跳转地址。分段下载在原六次上限内重试临时 HTTP 408／429／500／502／503／504，以及 curl 跟随跳转后连接失败而只留下 3xx 头的未完成传输；错误正文不会追加到合法分段。成功退出却仍返回 3xx、其他非临时状态、Content-Range 或长度错误仍中断，错误分类附 HTTP 状态码和 curl 退出码；只有完整固定 SHA-256 通过才发布缓存，不能用重试代替完整性校验。Electron 元数据或分段下载持续失败时，复用质量工具的官方资产备用适配器，逐项核对原仓库、tag、文件名、下载地址与固定哈希；只有 api.github.com 请求携带只读令牌，跨域下载不携带令牌。成功响应却哈希错误时不尝试备用入口。

README 负责使用入口与状态，CHANGELOG 记录客户端版本的变更，ACCEPTANCE 保留逐项证据。需要发布时从明确、干净的源码提交构建，先完成 make，再取得本次打包/实际安装 smoke 和系统入口证明，整理脱敏附件后发布预览版。不得将含本机绝对路径的原始清单、Profile 或诊断数据库上传为公开附件，也不得复用另一版本的报告。自动更新通道的实际发布状态见验收台账。

### 自动更新通道（0.4.7 起）

公开更新版本以 D1 settings 的 `desktopReleaseCatalog` 为准；`apps/cloud/src/desktop-releases.json` 仅在首次没有目录时初始化。存在但损坏的目录拒绝服务，不回退复活旧版本。不能用源码版本或本机安装版本推断公开版本。历史预览不代表当前版本已发布，也不代表长期运行验收完成。

- 执行器启动后立即检查，收到设备 WebSocket 的 update.available 通知、重连或系统恢复时补查，每 60 秒兜底检查；未配对时同样执行 HTTP 补查，也可从窗口或托盘“检查更新”。更新地址固定为 `https://tr.zhangheng.eu.org/api/updates/windows-x64/latest.json`，不随配对的工作空间地址变化。只有 Windows x64 Squirrel 安装版启用；开发及解压运行明确显示不可用。
- 新版本显示更新说明并发 Windows 通知，自动下载完整 nupkg，不提供关闭开关。下载仅请求同一 Cloudflare 域名，拒绝重定向，不发送设备令牌。大小、SHA-256 和 SHA-1 均验证后生成只含本地文件名的 RELEASES；Squirrel 仅使用该本地目录，没有第二条网络链路。
- 下载期间原任务继续运行。下载完成后自动暂停新增领取，等待正在领取的请求、执行/人工等待、浏览器与子进程清理、RPC 和结果回传结束，再安装重启。原“暂停领取”偏好不变；回传失败则继续等待，不强停任务或清空 outbox。更新不解锁 unknown 账号、不重放写入。中途关闭后下次启动重新检查并下载。失败按 1、5、15、60 分钟退避，之后最多每小时一次；定时补查和重复通知不绕过退避，手动检查/立即重试可绕过。新下载会清理应用自有旧下载缓存。
- Worker 只对目录中固定版本/哈希/文件路径提供流式下载。源限定为 `zhangheng2022/taskrelay` 的 `v<版本>` Release；仅在 CF 内跟随 GitHub 的指定资产域名，绝不向客户端返回 Location，不转发用户的 Cookie/Authorization，不启用 R2 或付费服务。

更新通道的发布与验收步骤：

1. 提交桌面版本、锁文件和 `docs/RELEASE-NOTES.md`，在合并提交的 CI Gate · 合并检查通过后手动启动 [生产发布](#发布)。
2. Windows Runner 构建并安装同一份产物，核验系统入口和 ASAR 后运行 `release-manifest`、`prepare-update`，将产物与验收报告关联到固定 SHA 和 Actions run。
3. 生产作业发布 `TaskRelay-<版本>-full.nupkg` 与 Setup 到可公开下载的 `v<版本>` Release；仅使用已验收附件，不重建或覆盖公开资产。不得把 GitHub token 配到客户端。
4. 生产作业先登记 D1 `desktopReleaseCatalog`，从 Cloudflare 下载核对完整大小和 SHA-256，再切换 `latest` 并读取公开清单验证版本、大小和哈希。更新协调 DO 根据真实目录保存版本通知和分页游标，经 alarm 向全部未吊销设备投递；失败保留批次重试。仅登记候选不触发候选通知，重复读取不重复建任务；保留历史条目供已开始的下载继续使用。不要再修改编译时 JSON 来切换公开版本；`latest:null` 表示尚未发布。
5. 本机通过更新通道自动下载（旧版首次升级仍需确认），检查空闲升级后的系统入口、版本、ASAR、配对和 Profile。运行中、人工等待及断网回传时不重启的实际故障验收另行记录；隔离 adapter 测试和 Runner smoke 均不替代真实本机升级验证。

实现依据：[Electron autoUpdater](https://www.electronjs.org/docs/latest/api/auto-updater)、[Squirrel 本地更新源](https://github.com/Squirrel/Squirrel.Windows/blob/develop/src/Squirrel/UpdateManager.DownloadReleases.cs)、[Cloudflare Streams](https://developers.cloudflare.com/workers/runtime-apis/streams/)。

## 历史外部配置撤销说明

本机 Clash Fake-IP 会触发执行器非公网地址保护。经用户许可，本次仅将 `example.com` 加入全局扩展脚本 `profiles/Script.js` 的 `dns.fake-ip-filter`，保留 blacklist 模式和其他条目；通过正在运行的服务模式本机接口重载，未放宽 TaskRelay 的 DNS/IP 检查。原文件备份为 Clash 配置目录中的 `profiles/Script.taskrelay-before-20261103.js.bak` 与 `clash-verge.taskrelay-before-20261103.yaml.bak`。如需撤销，恢复原全局脚本并在 Clash 中重新应用配置；不要把完整代理配置或订阅密钥复制进 TaskRelay 仓库。扩展语义参考 [Clash Verge 官方说明](https://www.clashverge.dev/guide/script.html)。其他任务站点未自动加入真实 DNS 名单。

以上为 0.2.0 当时的安装与 DNS 调整记录，不代表当前安装或领取开关。后续客户端已改用固定 HTTPS DNS；保留此处的外部配置撤销说明。

## 历史数据维护边界

一次性的 0.3.0 cutover 管理接口和 scripts/ai-cutover.mjs 已从源码移除，不再作为维护入口。历史 SQL 迁移、已安装数据兼容和正常保留期清理继续保留。

删除任务、聊天、运行或图片前，应按用户指定环境核对活动运行、未决结果、设备 outbox 与 journal；暂停新领取并先关闭聊天，阻止旧写入。图片须通过 Evidence 删除后再清索引，不能只删任务表。保留账号、模型、设备及 MASTER_KEY 的授权不可扩大为整库或整个 userData 删除。删除完成后核对数量与配置，按原状态恢复领取。浏览器 Profile 属于独立本地存储，删除数据库不表示 Profile 已删除。

## 聊天清理迁移（0023）

本节仅保留历史锚点。2026-11-05 的迁移、固定提交、Worker 和验证限制见[聊天清理交付](ACCEPTANCE.md#2026-11-05-聊天清理交付)；旧 0023 SQL 只供旧结构转换使用，不对当前库再次执行。当前清理机制见[架构说明](ARCHITECTURE.md#聊天删除与持久清理)。

## 历史发布索引

以下标题保留旧链接；“已上线”“未部署”等均为对应记录时点，不代表当前设备状态。

## 2026-11-10 优先流式（0.21.0，已上线）

历史时点与验证限制见[对应验收记录](ACCEPTANCE.md#2026-11-10-优先流式正式发布0210已完成)；当前操作统一按[发布流程](#发布)执行。

## 2026-11-10 发布后设备升级登记修复（已上线）

历史时点与验证限制见[对应验收记录](ACCEPTANCE.md#2026-11-10-设备升级登记修复正式发布已完成)；当前操作统一按[发布流程](#发布)执行。

## 2026-11-09 0.20.0 设置管理（已上线）

历史时点与验证限制见[对应验收记录](ACCEPTANCE.md#2026-11-09-0200-设置管理正式发布已完成)；当前操作统一按[发布流程](#发布)执行。

## 2026-11-09 0.19.5 已上线（发布完成，领取已恢复）

历史时点与验证限制见[对应验收记录](ACCEPTANCE.md#2026-11-09-0195-正式发布已完成)；当前操作统一按[发布流程](#发布)执行。

## 2026-11-08 0.19.4 已上线（领取已恢复）

历史时点与验证限制见[对应验收记录](ACCEPTANCE.md#2026-11-08-0194-跨域账号保存正式发布)；当前操作统一按[发布流程](#发布)执行。

## 2026-11-08 跨域账号保存修复（0.19.4，准备发布）

历史时点与验证限制见[对应验收记录](ACCEPTANCE.md#2026-11-08-跨域账号保存修复源码验证)；当前操作统一按[发布流程](#发布)执行。

## 2026-11-08 0.19.3 已上线（领取已恢复）

历史时点与验证限制见[对应验收记录](ACCEPTANCE.md#2026-11-08-0193-正式生产发布领取已恢复)；当前操作统一按[发布流程](#发布)执行。

## 2026-11-08 本地字段去重优化 0.19.3（未部署）

历史时点与验证限制见[对应验收记录](ACCEPTANCE.md#2026-11-08-0193-字段去重与摘要提示优化本地验证完成未部署)；当前操作统一按[发布流程](#发布)执行。

## 2026-11-08 0.19.2 已上线（领取已恢复）

历史时点与验证限制见[对应验收记录](ACCEPTANCE.md#2026-11-08-0192-正式生产发布领取已恢复)；当前操作统一按[发布流程](#发布)执行。

## 2026-11-08 本机页面去重版 0.19.2（未部署云端）

历史时点与验证限制见[对应验收记录](ACCEPTANCE.md#2026-11-08-0192-现场网址与重复页面信息去重已安装本机未部署云端)；当前操作统一按[发布流程](#发布)执行。

## 2026-11-08 本机主域名连接恢复（仅调整已授权的防护开关）

历史时点与验证限制见[对应验收记录](ACCEPTANCE.md#2026-11-08-0191-主域名配对与连接恢复)；当前操作统一按[发布流程](#发布)执行。

## 2026-11-08 本机上下文诊断版 0.19.1（未部署云端）

历史时点与验证限制见[对应验收记录](ACCEPTANCE.md#2026-11-08-上下文诊断版-0191-本机安装未部署云端)；当前操作统一按[发布流程](#发布)执行。

## 2026-11-08 全量重置发布（已上线，领取已恢复）

历史时点与验证限制见[对应验收记录](ACCEPTANCE.md#2026-11-08-存储-v2-生产全量重置与正式桌面发布)；当前操作统一按[发布流程](#发布)执行。

### 定时任务扩展（0.24.0 源码候选）

上线前按原发布流程应用 `0005_task_schedules.sql`，再更新云端与 Windows 0.24.0；本地实现不代表已迁移生产。基础执行协议仍为 19，新增定时能力单独登记，旧执行器可继续处理普通任务，新定时运行只分配给已声明能力的设备。迁移不更换 MASTER_KEY，旧计划的时间与状态保留。没有新执行器时定时运行排队至领取期限，不自动回退给旧版。

验收需分别确认每分钟触发、Windows 在线领取、真实站点执行、后台总结及下一次经验使用；独立包内 smoke 不替代这些验收。
