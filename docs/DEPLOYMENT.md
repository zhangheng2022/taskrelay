# 部署与恢复

## 2026-11-08 本地字段去重优化 0.19.3（未部署）

按用户要求优化模型输入表示及共享摘要提示，源码版本为 0.19.3，协议 18／本地 schema 4 不变。变化字段完整覆盖同次工具结果的基础现场，引用必须能在实际消息中唯一定位、且比完整表示更小；摘要提示聚焦进展并保留关键执行事实。验证证据见 ACCEPTANCE。本批只进行本地源码测试及打包验收，不安装或发布更新、不部署云端；既有正式 0.19.2 发布及恢复记录保持有效。

## 2026-11-08 0.19.2 已上线（领取已恢复）

固定源提交 `d5ec76dbe6d657457e6e37580f89fd410f8c7ee8` 已通过主分支 Quality 和 [正式发布 42476649285](https://github.com/zhangheng2022/taskrelay/actions/runs/42476649285)。云端已切换，主域健康及源码 SHA、匿名权限、页面资源核验正常；[0.19.2 Release](https://github.com/zhangheng2022/taskrelay/releases/tag/v0.19.2) 已公开，更新目录已在完整下载哈希核验后启用。正式包内、系统安装及入口验收证据见 ACCEPTANCE。本次不清空数据，没有待应用迁移，保留现有平台 Secret。

原发布曾因两个旧设备均已吊销而进入 awaiting-device。用户确认另一台电脑已安装 0.19.2 并完成授权；只读核验 1 台新设备未吊销、协议 18、最近 90 秒内在线且 claim_ready=1 后，通过 [恢复发布 42479287437](https://github.com/zhangheng2022/taskrelay/actions/runs/42479287437) 继续原源提交及产物运行 42476649285。最终发布为 complete、maintenance=0、claimsEnabled=1，1 台有效设备在线且就绪；没有重打包或重新部署，未手改领取开关、吊销标志或伪造心跳。主域健康及 0.19.2 更新目录再次核验正常，真实任务效果待用户运行。本机原调试安装及此前未部署记录是历史状态。

## 2026-11-08 本机页面去重版 0.19.2（未部署云端）

按用户要求本地打包并安装 0.19.2，仅调整桌面模型输入中逐字相同的网址和完整相同的页面现场表示，浏览器仍使用完整网址。协议 18、本地 schema 4 不变；源码回归、包内 smoke、实际安装 smoke、桌面快捷方式启动及安装 ASAR 哈希核验通过，详细证据和验证限制见 ACCEPTANCE。

升级前暂停并排空本地任务、领取确认和回执，在仓库外保留受限备份；原配对身份、配置和 Profile 核验一致。安装后已恢复原有领取状态，0.19.2 在主域名 `https://tr.zhangheng.eu.org` 显示“在线，等待任务”。此为未提交工作区调试包，未推送、发布更新或部署云端，也未调整云端防护和模型配置。真实任务复跑由用户进行，不能将本地 smoke 作为实际业务执行成功的证据。

## 2026-11-08 本机主域名连接恢复（仅调整已授权的防护开关）

0.19.1 首次配对报告 CLOUD_RESPONSE_INVALID；主域 GET health 和 POST 配对入口均收到 403、text/html、cf-mitigated=challenge，Cloudflare 安全事件确认为 botFight 的 managed_challenge。曾临时用已有 workers.dev 入口验证配对链路；用户明确要求用主域名后，已恢复本机连接地址并停止该临时配对，没有批准备用入口的设备请求。

用户明确批准只关闭 `zhangheng.eu.org` 全域的 Bot Fight Mode；已将 fight_mode 从 true 改为 false，回读确认其他 Bot Management 字段未变，浏览器检查仍 on，自定义防火墙及配置规则版本未变。此项为该用户此次显式授权的配置调整，影响该域下所有子域；不作为后续发布检查失败时自动关闭防护的授权。未部署 Worker、修改域名绑定、模型配置或执行逻辑，主域 health 保持原源码 b4ad9133de04a1d14f95c4c49c3b59933a3fae9d、协议 18。

变更传播后，主域 health=200，使用非法空名称／协议 0 的无写入配对探测返回 400 JSON INVALID_INPUT，未再返回挑战页。本机从主域重新发起配对，由用户在网站核对并批准；0.19.1 已显示“在线，等待任务”，本机保存的 cloudUrl 为主域。若恢复 Bot Fight Mode 为 true，仍可能再次拦截现有桌面 HTTP 客户端，应先评估接入方案，不能直接恢复后宣称执行器可用。

## 2026-11-08 本机上下文诊断版 0.19.1（未部署云端）

按用户要求在开发机本地 make 并从 Windows Explorer 安装 0.19.1，保留协议 18 和 SQLite schema 4。此为未提交工作区的本机调试包，未推送代码、发布 GitHub Release、切换更新目录或部署云端，不作为正式生产发布附件。包内及系统安装 smoke、实际桌面快捷方式启动、进程路径与安装 ASAR 一致性核验已通过，证据见 ACCEPTANCE。

用户确认原执行器在另一台电脑，因此当前开发机为全新安装，没有迁移另一设备的令牌、Profile 或数据库；原电脑保持不动。当前本机 0.19.1 显示“尚未连接”，工作空间地址为 `https://tr.zhangheng.eu.org`。用户需在网站授权本机设备，并确保测试任务由这个新版执行器领取，再通过本机“导出诊断”取得大小统计；旧版执行器生成的诊断没有新增字段。真实任务和字段占用的调查仍等待这次复现。

## 2026-11-08 全量重置发布（已上线，领取已恢复）

配对后的设备已通过既有维护升级入口完成协议 18 升级；[恢复发布 42398978687](https://github.com/zhangheng2022/taskrelay/actions/runs/42398978687) 核验真实在线/就绪设备后，将原发布推进 complete、恢复 claimsEnabled=1，maintenance=0。下文 awaiting-device 为首次切换时点记录。新设备批准曾写入旧协议 2 的源码问题及回归见 ACCEPTANCE；新配对使用当前协议，已有旧设备仍须按维护流程升级，不通过数据库手工改版本。

用户本轮明确要求清空全部数据、不保留历史，覆盖前批存量离线转换要求。本次清空云端认证/业务成员、账号凭据、模型配置、配对设备、任务、聊天、运行、图片/浏览器状态以及各 DO 的旧状态；保留既有平台 Secret，不读取、生成或覆盖 MASTER_KEY，不生成历史转换归档。上线后需重新登录、配置模型及配对设备；本机安装和旧 Profile 不由云端清空操作处理。

固定提交 `8f0009b29330b3903434c944ee8946c41164164c` 已通过主分支 [Quality 42396015821](https://github.com/zhangheng2022/taskrelay/actions/runs/42396015821)，[正式发布 42396374508](https://github.com/zhangheng2022/taskrelay/actions/runs/42396374508) 成功。Worker `d8748c53-2466-4e44-8030-969a564da839` 接收 100% 流量，协议 18；唯一业务 D1 为 `taskrelay-v2-20261108`（`1951016f-1c9b-459e-a332-75266106f7ad`），新基线 storage_meta=2。

维护窗口内暂停旧库交办和领取，确认运行/浏览器清理、回合、模型调用、dispatch、命令、inbox 和清理作业均无待处理项。先部署 `scripts/db/reset-worker.ts` 并应用 `storage-v2-reset-drop-20261108`，核验旧七个命名空间全部消失；随后正式发布应用 `storage-v2-reset-create-20261108` 创建七个新 SQLite DO 命名空间，ID 均与旧版不同。临时上传使用 keep_bindings 保留既有 Secret，未读取或重新设置密钥。新库、公开下载和权限核验后，原业务 D1 `9d387f48-6e34-4af4-a2a0-10f958d65a16` 已删除；独立验收库未处理。未制作旧数据转换归档，旧库/旧命名空间不能作为回退目标。

[桌面 0.19.0](https://github.com/zhangheng2022/taskrelay/releases/tag/v0.19.0) 已公开，托管 Windows 包内 smoke、系统入口实际安装和安装 smoke 均通过，Cloudflare 下载完整哈希核验通过。网站维护关闭，storageFrozen=0；因设备已清空，发布状态为 awaiting-device、claimsEnabled=0。须先用 OWNER_EMAIL 对应邮箱重新注册并验证、配置模型、准备本地 schema 4 并配对 0.19.0 执行器。设备在线且 claim_ready 后，从 master 触发 Production release：mode=resume、source-sha=`8f0009b29330b3903434c944ee8946c41164164c`、recovery-run=`42396374508`，由原发布记录恢复领取；不手改发布状态或伪造就绪设备。本机尚未安装或重新配对。

本地迁移与生产发布按绑定名 `DB` 查库；界面检查使用独立 Transport 夹具。主域名命令行探测受到 Cloudflare 防护挑战，真实 Edge 已核对主站 health 的 SHA/协议和首次注册页面；workers.dev 的健康、匿名权限、静态资源和更新目录检查通过。详细哈希及证据边界见 [验收记录](ACCEPTANCE.md#2026-11-08-存储-v2-生产全量重置与正式桌面发布)。

## 存储 v2 离线切换（保留数据参考流程）

以下保留数据的切换方案仍供未来需要时参考，本次按上节用户授权执行全量重置。

独立新基线使用协议 18、图 relay-graph-4、桌面 SQLite 4。下方既有 0001–0030 增量发布记录是历史证据，不能对旧结构直接执行新 `0001_storage_v2.sql`。常规 `release-production` 预检拒绝没有 storage_meta=2 或仍冻结的库；发布 API 的目标 ID 从唯一 Wrangler D1 配置读取。当前生产已按上节清空并切换；以下转换工具供其他仍需保留旧库的环境使用，不表示本次生产转换了历史。本机前批调试产物的包内 smoke 与本次托管正式安装证据分别记录，不混用。

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

2026-11-07 图片链路源码批次：桌面版本 0.18.0，协议仍为 17，尚未部署、发布或安装。发布须先应用 `0029_image_references.sql`，再部署云端／网站，最后发布桌面；旧 JSON 上传、旧图片及 `format=data` 保留兼容，新桌面依赖新版云端的 multipart 和图片引用入口，不能先更新桌面。迁移只添加图片用途、租约代次和摘要字段；不绑定 R2，不更换 MASTER_KEY。打包在 runtime 依赖下载时因 npm 域名解析失败中断，尚无本批可验收安装包；不得复用旧 smoke 报告。

2026-11-06 首次 [Actions 正式发布 42239257763](https://github.com/zhangheng2022/taskrelay/actions/runs/42239257763) 已完成，源提交 `41c916c133c449736afc92cd66203cff2d16cf83`。先记录 D1 恢复点并应用 0028，再部署 Worker `09848417-7a05-4d18-8dde-6be64eb360ab`（100%），随后发布 [0.17.1](https://github.com/zhangheng2022/taskrelay/releases/tag/v0.17.1)、完整核验 Cloudflare 下载并切换 D1 更新目录。发布记录为 complete，领取恢复 1、维护恢复 0；两个域名健康均报告该 SHA，更新目录均为 0.17.1，匿名用户／管理员接口均为 401。

安装包由 GitHub 托管 Windows 构建和实际安装验收。包内／安装 ASAR 为 `0b67b1d6f07fcf4b2fb272f94f98a88d5f92575e03ab194f0f3d823fc841a011`，更新包 SHA-256 为 `77959e67264fc565b3d01b43d806d0d4d0820428a7fc60de211d050eedcd9701`。用户本机仍为 0.17.0，更新通道升级与升级后 Microsoft 只读验收未完成，原因见 ACCEPTANCE；不能用托管安装报告替代本机证据。

2026-11-06 Web 图片地址批次：仅发布网站图片加载与可选 Transport 能力，复用既有受鉴权二进制接口；D1 保持 0027、执行协议 17、本机执行器 0.17.0，不需要迁移或重新打包安装。后端 Base64 响应保留旧客户端兼容；现有 MASTER_KEY、图片存储和设备凭据不变。

源码 `2f7ff5a` 已部署 Worker `482bdbad-3ee5-4610-928e-6bdc4300c63c`，线上资源 `index-DgSawW-l.js` 与本次构建一致。两个域名健康、匿名及设备令牌范围检查通过；发布窗口无活动执行、未清理浏览器或推理，领取已恢复、维护关闭。UI 实际检查的限制见 [验收记录](ACCEPTANCE.md#2026-11-06-web-图片改为受鉴权地址)。

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

生产使用 GitHub 的 **Production release** 手动工作流；合并不自动发布。本机构建只用于开发，生产迁移、云端部署及正式 Windows 包由 GitHub 托管 Runner 完成。

1. PR 通过固定名称 `quality-gate` 后合并 master，等待合并提交自己的 Quality 检查通过。
2. 在 master 运行 Production release，通常选择 `scope=auto`、`mode=publish`；可指定完整 `source-sha`。预检重新核验该 SHA 的 master 推送检查，不接受 PR 报告或旧的绿色报告；遗漏必要范围、桌面修改未提升版本、已公开版本均拒绝发布。
3. Linux 构建网站；Windows 固定 Chrome for Testing 版本与压缩包哈希，完成 make、包内 smoke、实际安装、系统快捷方式启动和安装 ASAR 校验。验收后的同一份产物进入 production 作业，不再次构建替换。
4. D1 `productionRelease` 保存提交、Actions run、产物哈希、原开关及发布阶段。先暂停领取，最多等待十分钟正常清理；未知结果、未关闭浏览器、推理未结束或不兼容待执行任务阻止发布。保存 Time Travel bookmark 后应用迁移，再部署云端和网页。
5. GitHub Release 资产按哈希校验且不可覆盖；登记 D1 更新目录后，经 Cloudflare 下载并校验完整大小和哈希，才切换 latest。最后核验兼容设备并恢复原开关；无就绪设备时恢复网页，领取继续暂停。

仓库 `production` Environment 仅允许 master。已配置 `CLOUDFLARE_API_TOKEN`，仅 production 作业可读：当前账号的 Workers Editor、D1 Write，以及 `zhangheng.eu.org` 的 Workers Routes Write、Zone Read。现有 MASTER_KEY、模型密钥留在 Cloudflare；工作流不读取或覆盖。Release 写权限也只在 production 作业授予。

失败后保持现场，不能直接打开领取或回滚数据库。确认原运行已结束后，在同一源 SHA 以 `mode=resume`、`recovery-run=首次产物运行 ID` 继续核验；恢复使用原附件，不重新打包。迁移按已提交记录继续；部署结果未知时只核对 health 的 `sourceCommit`，未确认则报错并等待人工诊断。附件保留七天，缺失且阶段仍需要附件时拒绝恢复。若停在 `awaiting-device`，升级设备后同样通过 resume 核验。已完成发布和公开版本不能重新 publish。

GitHub [上传接口会改写特殊文件名](https://docs.github.com/en/rest/releases/assets#upload-a-release-asset)。Squirrel 磁盘文件 `TaskRelay Setup.exe` 固定以 `TaskRelay.Setup.exe` 发布并核对返回名称；中断恢复也按公开名匹配，再比较大小和哈希。不能因本地名有空格而误判资产缺失，更不能删除重传已公开文件。

本批新增迁移 `0028_release_claim_barrier.sql`，在领取事务内再次检查暂停/维护开关，阻止早先读到旧开关的并发领取。管理员不能在未完成发布期间覆盖领取开关。协议仍为 17；不改变账号、Profile、快照格式或加密密钥。

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

先提升 `apps/desktop/package.json` 版本并同步锁文件，通过 PR 合并。正式 make、浏览器状态迁移测试和本次产物 smoke 在 Actions 的 Windows 作业执行；本地 make 仅用于开发。暂存运行时包使用桌面应用版本，Squirrel 的版本目录和 nupkg 必须一致。交付不能停留在直接运行 `out/TaskRelay-win32-x64/TaskRelay.exe`。

安装前保存本地数据并检查未完成运行；安装后从桌面或开始菜单的实际入口启动，核对进程路径、版本和 `resources/app.asar` 的 SHA-256，再验证安装目录 smoke。`node scripts/release-manifest.mjs` 会拒绝旧报告、错误版本或不匹配的 ASAR；安装路径取自实际自检报告，不按环境变量猜测。报告同时记录执行程序、资源目录与运行扩展路径。0.4.6 起扩展从应用自有内容寻址目录加载，文件集合和字节哈希必须与安装资源一致，不修改原始安装文件或系统访问控制。

在 Codex MSIX 环境中，逻辑上的 `%LOCALAPPDATA%/TaskRelay` 可能实际位于 Codex 的 `LocalCache/Local/TaskRelay`；Roaming 数据也可能重定向。该副本的安装成功不证明 Windows 桌面快捷方式对应的系统安装已更新。若清单出现重定向路径，应从 Windows 的运行/资源管理器入口执行同一安装包，并单独验证系统安装与快捷方式。不要把另一数据目录的备份或配置一致性结论套用到系统目录。

## GitHub 源码检查与发布边界

Windows 浏览器程序资源必须允许 Chromium LPAC 子进程读取／执行；Main 在首次启动前为自有 `resources/browser/chrome-win64` 校验路径并补齐该 ACL。只有公开程序资源获得权限，不给 Profile、父目录或应用数据授权；链接和权限设置失败均阻止浏览器启动。打包 smoke 与独立状态迁移测试实际经过此入口，禁止用关闭沙箱替代。

发布自动化的健康与下载校验使用现有 `https://taskrelay.zhangheng.workers.dev`，固定目标、禁止重定向、不携带用户会话。主站 `tr.zhangheng.eu.org` 的 Bot Fight Mode 会向部分托管 Runner 发出人机挑战；免费版不能按路径豁免（[官方限制](https://developers.cloudflare.com/bots/get-started/bot-fight-mode/)）。保留全域防护、主站及客户端更新地址；不要以关闭防护或放行全部 Actions IP 解决发布检查。站点实际访问和权限检查另在正常客户端核验。

`.github/workflows/ci.yml` 在 PR、master 推送、手动触发及每周一北京时间 09:00 执行。检查格式、Oxlint 类型规则、TypeScript、仓库一致性、Windows/Ubuntu 测试、Ubuntu c8 覆盖率、CodeQL security-extended 实际结果、Gitleaks、High/Critical 依赖漏洞、actionlint/ShellCheck/PSScriptAnalyzer 和 Web 构建。执行器相关改动追加托管 Windows 打包及实际安装 smoke。固定名称 quality-gate 对失败、取消、缺少报告均关闭；仅明确无关的安装作业可跳过。

所有 Actions 固定提交 SHA，PR 不接触生产 Environment，默认 contents:read，CodeQL 仅额外获得 security-events:write。统一命令为 `lint`、`format:check`、`format`、`test:coverage`、`check:workflows`、`quality`。Ubuntu 覆盖率下限由 `scripts/coverage-baseline.json` 固定，后续不可降低；后续 PR 修改的可执行行至少 80%，纯格式差异归一化后排除。报告保留七天，不自动发评论或调用外部审查模型。质量检查只保存 Windows 验收报告，正式发布才保存完整安装包附件。

质量工具的固定 GitHub 网页下载入口出现网络错误或非成功状态时，可通过官方 API 核对原仓库、tag、文件名和原下载地址，再下载同一资产；仍按原 SHA-256 校验，成功响应但哈希不符直接拒绝。CI 仅向相关检查步骤提供只读 github.token，令牌只用于 api.github.com，资产跨域下载不携带令牌并限制官方主机。此路径不使用镜像、不降低质量门槛；CodeQL 自身下载失败通过重试作业处理。

浏览器及 Electron 的分段下载在原六次上限内重试临时 HTTP 408／429／500／502／503／504，以及 curl 跟随跳转后连接失败而只留下 3xx 头的未完成传输；错误正文不会追加到合法分段。成功退出却仍返回 3xx、其他非临时状态、Content-Range 或长度错误仍中断，错误分类附 HTTP 状态码和 curl 退出码；只有完整固定 SHA-256 通过才发布缓存，不能用重试代替完整性校验。

README 负责使用入口与状态，CHANGELOG 记录客户端版本的变更，ACCEPTANCE 保留逐项证据。需要发布时从明确、干净的源码提交构建，先完成 make，再取得本次打包/实际安装 smoke 和系统入口证明，整理脱敏附件后发布预览版。不得将含本机绝对路径的原始清单、Profile 或诊断数据库上传为公开附件，也不得复用另一版本的报告。自动更新通道的实际发布状态见验收台账。

### 自动更新通道（0.4.7 起）

公开更新版本以 D1 settings 的 `desktopReleaseCatalog` 为准；`apps/cloud/src/desktop-releases.json` 仅在首次没有目录时初始化。存在但损坏的目录拒绝服务，不回退复活旧版本。不能用源码版本或本机安装版本推断公开版本。历史预览不代表当前版本已发布，也不代表长期运行验收完成。

- 执行器启动 15 秒后及每 6 小时检查一次，也可从窗口或托盘“检查更新”。更新地址固定为 `https://tr.zhangheng.eu.org/api/updates/windows-x64/latest.json`，不随配对的工作空间地址变化。只有 Windows x64 Squirrel 安装版启用；开发及解压运行明确显示不可用。
- 新版本显示更新说明并发 Windows 通知。用户确认“下载并安装”后才下载完整 nupkg。下载仅请求同一 Cloudflare 域名，拒绝重定向，不发送设备令牌。大小、SHA-256 和 SHA-1 均验证后生成只含本地文件名的 RELEASES；Squirrel 仅使用该本地目录，没有第二条网络链路。
- 下载期间原任务继续运行。下载完成后自动暂停新增领取，等待正在领取的请求、执行/人工等待、浏览器与子进程清理、RPC 和结果回传结束，再安装重启。原“暂停领取”偏好不变；回传失败则继续等待，不强停任务或清空 outbox。更新不解锁 unknown 账号、不重放写入。确认不跨应用重启保存；中途关闭后须重新确认，失败支持重试，新下载会清理应用自有旧下载缓存。
- Worker 只对目录中固定版本/哈希/文件路径提供流式下载。源限定为 `zhangheng2022/taskrelay` 的 `v<版本>` Release；仅在 CF 内跟随 GitHub 的指定资产域名，绝不向客户端返回 Location，不转发用户的 Cookie/Authorization，不启用 R2 或付费服务。

更新通道的发布与验收步骤：

1. 提交桌面版本、锁文件和 `docs/RELEASE-NOTES.md`，在合并提交的 quality-gate 通过后手动启动 [生产发布](#发布)。
2. Windows Runner 构建并安装同一份产物，核验系统入口和 ASAR 后运行 `release-manifest`、`prepare-update`，将产物与验收报告关联到固定 SHA 和 Actions run。
3. 生产作业发布 `TaskRelay-<版本>-full.nupkg` 与 Setup 到可公开下载的 `v<版本>` Release；仅使用已验收附件，不重建或覆盖公开资产。不得把 GitHub token 配到客户端。
4. 生产作业先登记 D1 `desktopReleaseCatalog`，从 Cloudflare 下载核对完整大小和 SHA-256，再切换 `latest`，保留历史条目供已确认的下载继续使用。不要再修改编译时 JSON 来切换公开版本；`latest:null` 表示尚未发布。
5. 本机通过更新通道确认下载，检查空闲升级后的系统入口、版本、ASAR、配对和 Profile。运行中、人工等待及断网回传时不重启的实际故障验收另行记录；隔离 adapter 测试和 Runner smoke 均不替代真实本机升级验证。

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
