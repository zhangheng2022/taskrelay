# TaskRelay 验收记录

## 2026-11-09 0.19.5 正式发布（等待设备）

- 用户随后授权发布，覆盖下方图片优化实施时的暂不发布要求。正式源 SHA 为 `1a5daed979406d6e09b7c2e395034b97e71ad437`；[PR #26](https://github.com/zhangheng2022/taskrelay/pull/26) 的 [CI 42570691536](https://github.com/zhangheng2022/taskrelay/actions/runs/42570691536) 第 2 次尝试、[master CI 42571799226](https://github.com/zhangheng2022/taskrelay/actions/runs/42571799226) 第 1 次尝试全部通过，包含双平台测试、Linux 覆盖率、真实 Chromium 图片验收、完整 Windows 打包与实际安装。PR 首次在 Electron 下载信息校验处失败，原提交重跑通过；未降低下载哈希或验收要求。
- [生产发布 42572476103](https://github.com/zhangheng2022/taskrelay/actions/runs/42572476103) 第 1 次尝试成功执行至 `awaiting-device`。复用主分支 `ci-web-1`（`13653398301`）与 `ci-windows-1`（`13653945851`），无重复 Web/Windows 构建；发布恢复附件 `release-bundle-1`（`13654106269`）显式文件哈希校验通过。首次发布从 06:20:52 到 06:26:27 UTC 共 5 分 35 秒，候选 Windows 构建验收用时 5 分 56 秒；此为单次观测，不能推定长期平均提速。
- 最新依赖审计通过既定 high 门槛；开发工具链有 17 项 moderate 报告，runtime 审计为 0 漏洞，本次未做跨版本依赖升级。生产排空、D1 恢复点、迁移核对、云端部署、GitHub Release、Cloudflare 完整下载哈希及更新通道切换顺序完成，没有待应用迁移。Worker 版本 `6ba596bb-3d7e-41b1-a181-447b95630864`，两域 health 返回正式 SHA，主域 HTML 引用 `index-C3b2ULhF.js` 与 `index-CaC_MnEe.css`，这两个静态文件与 master Web 候选逐文件 SHA-256 一致，更新目录为 0.19.5。
- 发布时兼容设备检查未通过，最终为 `awaiting-device`，领取仍暂停；Actions 成功不表示业务发布已到 complete。用户随后要求本次及后续发布不再校验执行器状态；移除门槛后按 DEPLOYMENT 的原运行参数恢复。未伪造设备心跳、解除吊销、强制恢复领取，未重新生成 MASTER_KEY 或清空数据。

| 正式产物                    |    字节数 | SHA-256                                                          |
| --------------------------- | --------: | ---------------------------------------------------------------- |
| TaskRelay.Setup.exe         | 388410880 | 9911093fae9304885d02cc51390c00c73ac64b7df677e6ad3b5812a6d708e53f |
| TaskRelay-0.19.5-full.nupkg | 387870878 | 2ec340b3d3f63f49ca46ce0ceeb182054cd33c358ec698d1c149bfdfc304cfb6 |
| RELEASES                    |        81 | 2eaf76231824397ee2f9d559ce2f7e0b46323061eb56976119beccfc5c94787d |

版本准备的 5 个文件经 OCR preview/rule 与宿主审查全部覆盖，无未解决发现；仓库检查和发布相关测试通过，图已更新，SQL 解析限制仍保留。托管 Windows 安装验收不表示已升级用户设备；真实手机/WebKit、生产聊天图片时延及真实模型网站任务未在本次发布中验收。下方记录保留原时点结论。

## 2026-11-09 Web 图片 Loading 与预览

- 缩略图使用固定占位、Skeleton 与 Spinner；预览先显示缩略图，原图完成网络读取和解码后结束 Loading。两种失败均可独立重试；原图按会话保留一份内存 URL，切图、附件移除和退出会话中止请求并释放。
- 本地 494 项全量测试通过，类型、lint、仓库、工作流静态检查及 Web 构建通过。图片组件测试覆盖失效登录、删除响应、非图片内容、网络错误、重试、迟到响应、同源二进制读取及资源回收。
- 真实 Chromium 使用合成图片和正式共享组件/样式/Transport，验证浅色桌面、390×844 深色、实际动画、Enter/Esc、焦点恢复、缩略图失败仍可查看原图、重试、刷新去重、会话清理和历史图片进入视口后加载。
- 固定 700 ms 响应延迟的本机夹具中，缩略图加载前后附件高度变化由旧实现的 30 px 降到 0 px。同图两次打开累计原图请求均为 1 次、图片响应合计均为 45,068 字节；未把浏览器原有复用算作新增收益，不宣称网络传输提速。首次耗时包含夹具延迟，不代表生产时延。
- CI Windows 测试作业在完成全量测试后准备固定版本、哈希校验的 Chromium，再执行 `test:web-images`。报告和截图保留 7 天；浏览器缺失、断言失败或报告缺失不会产生成功完成标记。共享 UI 改动仍要求完整 Windows 打包安装验收。
- OCR preview/rule 与宿主差异审查覆盖 16/16 文件（含默认排除的文档），无跳过及未解决问题；图已更新，33 个 SQL 文件因缺少 tree_sitter_sql 未解析。复测时既有 Chromium 状态恢复测试在默认并发下两次超时，独立重跑通过；将本机测试并发限制为 4 后，同一份完整 494 项测试通过，未修改断言或超时标准。
- 本批不发布生产；PR/master 的运行结论以对应提交的 Actions 为准。本地夹具不代替生产权限、真实网络和 iPhone/WebKit 验收。

## 2026-11-09 GitHub Actions 重构

- 第一阶段 [PR #23](https://github.com/zhangheng2022/taskrelay/pull/23) 已合并，源提交 `bce00358654f6254d9c99e776aec388c0532e509`。[PR 检查 42560104700](https://github.com/zhangheng2022/taskrelay/actions/runs/42560104700) 与 [主分支检查 42560698377](https://github.com/zhangheng2022/taskrelay/actions/runs/42560698377) 全部通过，包含托管 Windows 包内/实际安装、系统入口及 ASAR 验收；PR 保留完整验收流程，master 生成 ci-web-1 和 ci-windows-1 候选。
- 本地全量 491 项测试通过，行/分支/函数覆盖率 74.63%/81.90%/82.11%，差异可执行行 517/571。类型、lint、仓库、格式与工作流检查通过。发布预检、缺失/过期候选补建、新旧恢复入口、等待设备无附件及错误来源/哈希均有隔离入口测试。
- 第一阶段 OCR preview/rule 与宿主审查覆盖 32/32 文件，含默认排除的测试、类型与文档；无跳过、无未解决问题。CodeQL 的两条网络数据落盘提醒指向固定路径的发布元数据和运行摘要，已核查为预期数据写入并解决 PR 讨论，未降低扫描门槛。
- PR 和 master 的新旧门槛同时通过后，ruleset 26694266 已切换到 CI Gate · 合并检查；核对除检查名称外所有规则完全一致，保留 App 15368、严格检查和 active 状态。本提交移除旧过渡检查，工作流显示为 CI · 持续集成、Release · 生产发布、Build · Windows 构建验收。
- graphify update 已完成；33 个 SQL 文件因缺少 tree_sitter_sql 未解析，30 个代码/声明文件无符号，12 个不支持类型文件跳过。不把图更新当作这些文件的审查。
- 本批未触发生产发布或修改 Cloudflare；本地发布夹具不证明线上 D1、真实发布恢复或设备升级通过。产物复用和缺失补建已通过隔离入口验证，实际发布耗时收益需在下一次手动发布时确认。

## 2026-11-08 0.19.4 跨域账号保存正式发布

用户授权提交修复、应用迁移、部署云端并更新安装包。[PR #21](https://github.com/zhangheng2022/taskrelay/pull/21) 已合并，正式源提交为 `6ba82cab7495feb1d79f55c189fd9fe1297de2e6`；[主分支 Quality 42492540003](https://github.com/zhangheng2022/taskrelay/actions/runs/42492540003) 通过。提交范围为 20 个文件，全部完成 OCR preview/rule 及宿主审查，补审默认排除的测试、锁文件和文档，无未解决发现；既有 `.codex/config.toml` 留在本地，未提交。

PR 首轮 Ubuntu 覆盖率作业中的既有聊天通知测试等待新结果超过一秒；本机隔离复测通过，重跑失败作业后全部门禁通过。主分支双平台测试各 482 项，481 通过、1 项因普通 Runner 未准备 Chromium 而跳过；正式 Windows 作业在 prepare:browser 后补跑真实 Chromium 状态传输入口 2/2 通过。Ubuntu 覆盖率为行 73.73%、分支 81.73%、函数 81.10%，PR 新增可执行行覆盖 76/78。静态、格式、类型、仓库、工作流、故障探针、安全及 Web 构建门禁通过；构建保留既有大分块和混合导入提示。

[首次正式发布 42493069395](https://github.com/zhangheng2022/taskrelay/actions/runs/42493069395) 的托管 Windows 包内与实际安装 smoke 均 passed=true，系统快捷方式启动安装进程为 `C:\Users\runneradmin\AppData\Local\TaskRelay\app-0.19.4\TaskRelay.exe`。构建与安装 ASAR SHA-256 均为 `96d5f4bbfc7ac548750920848ac2c5ba99e5bb584c827102e2a4c5935a33bf5a`，release-manifest 通过。此证据来自托管 Windows，不代表用户另一台电脑已更新或真实 Microsoft 登录闭环通过。

| 正式产物                    |    字节数 | SHA-256                                                            |
| --------------------------- | --------: | ------------------------------------------------------------------ |
| TaskRelay.Setup.exe         | 388403712 | `a31d24c8aa2517d80bbea995a967360ed60afcfa5b83f5861badfd343e3a671f` |
| TaskRelay-0.19.4-full.nupkg | 387868110 | `d307c9481fc8c82affbbdd01b4826d4c6eb89093c9db945b81726b0c6ccebf64` |

首次 production 作业排空运行、保留 D1 Time Travel bookmark，成功应用 `0002_account_state_origins.sql`；只读核对 accounts.state_origins 为 TEXT、默认 `'[]'`，storage_meta 保持 2，未清空数据或读取/替换 MASTER_KEY。Worker `4397dc2f-52ba-4e73-b2a4-a372720e2092` 已部署并承接 100% 流量，但流程在切换后的即时核验返回 DEPLOYMENT_HEALTH_MISMATCH 后停止于 deploying；随后两域 health 均确认正确源 SHA。[恢复发布 42493872442](https://github.com/zhangheng2022/taskrelay/actions/runs/42493872442) 以同一源 SHA 和首次产物运行继续，构建作业跳过，未重打包或重复部署；已公开 [0.19.4 Release](https://github.com/zhangheng2022/taskrelay/releases/tag/v0.19.4)，经 Cloudflare 完整下载核对大小和 SHA-256 后启用 latest。

主域和 workers.dev 的 health、首页及实际 JS 资源均 200，源 SHA 与协议 18 正确，匿名本人/管理员接口均 401，最新目录均为 0.19.4。首次恢复因设备就绪检查暂落 awaiting-device，maintenance=0、claimsEnabled=0；随后观察到协议 18 的有效设备重新在线就绪，通过 [恢复发布 42494204028](https://github.com/zhangheng2022/taskrelay/actions/runs/42494204028) 成功继续同一源提交和首次产物。最终回读 phase=complete、maintenance=0、claimsEnabled=1、storageFrozen=0，1 台未吊销、协议 18 的设备最近 90 秒内在线就绪；没有手改开关或伪造心跳。

本机仅执行源码检查和公开入口核验，未覆盖本机或用户另一台电脑的安装；执行器需通过“检查更新”或下载安装包完成升级。未代用户执行真实模型和 Microsoft 站点任务，不自动重放此前失败的保存请求。Graphify CLI 不可用，新增 SQL 没有图解析证据。公开核验摘要位于忽略目录 `.cache/db-refactor/0.19.4-public-verification.json`，不提交诊断、产物或秘密。

## 2026-11-08 跨域账号保存修复源码验证

修复保存卡片把登录成功落点误当作凭据投递站点的校验：跨域落点可生成保存卡片，访问列表未包含当前页也不额外阻止；由执行器依据实际登录结果提出保存。账号入口归属、用户/设备隔离、租约、公网 HTTPS 与凭据精确投递范围继续生效。新增 `0002_account_state_origins.sql`，本人确认未修改的已验证卡片后只把当前落点写入状态来源，不将全部访问域、落点或其他子域自动加入密码投递和业务匹配范围。执行中确认与晚确认均可关联原候选并在下一轮恢复落点 Cookie/Local Storage；认证修改及清除状态不继承落点范围，重命名保留。

新增八项生产入口回归，覆盖跨域卡片和幂等消息、访问列表不完整、私网/入口/租约拒绝、认证编辑、执行中及晚确认的快照发布与下一轮恢复、保存失败的原聊天提示及脱敏诊断、保留旧密文和版本的增量迁移。四个相关测试文件定向 **78/78** 通过；完整 `npm test` **482/482** 通过，无失败或跳过，包含真实本地 Chromium 状态传输入口及 workerd D1 应用基线和增量迁移。SQLite/DO 对象传输 stand-in 不代表生产 D1 并发或部署验证，真实本地 Chromium 也不代表 Microsoft 登录闭环。

类型检查、lint、格式检查、仓库检查、git diff --check 和 Web 构建通过；Web 构建保留既有混合导入与大分块提示。Hono CLI 直接读取命名导出的 index 返回 INVALID_APP，使用仓库外仅重导出真实 app 为默认导出的临时入口后，路由读取及 health 200 通过，卡片权限和状态流由真实 app.request 回归验证。lint 初次发现新增测试的数组排序缺比较函数，修正后 lint 与该文件 12/12 回归通过。

OCR delegate preview/rule 均成功，宿主完整审阅本次 16 个变更文件及相关上下文，补审默认排除的四个测试与三份文档；无未解决发现，未调用 OCR 外部模型。按整个工作区预览统计 total_files=17、reviewed_files=16、skipped_files=1、coverage_rate=94.12%；唯一跳过项为修改前已存在且不属于本次任务的 `.codex/config.toml`，已原样保留，不算已审。`graphify query` 与 `graphify update .` 均因命令不可用而未成功，已按源码完成检索与审阅，图未更新；本批新增 SQL 未获得图解析覆盖。

上述为源码验证时点，仅修改源码、测试和文档，保留既有 `.codex/config.toml` 改动；当时未应用生产迁移、部署 Worker、重打包/安装执行器或调用真实模型及 Microsoft 网站。用户随后授权提交和正式发布，桌面源码已提升到 0.19.4，同步两份锁文件、更新发布说明，生产发布结果另行补充。按 [DEPLOYMENT](DEPLOYMENT.md#2026-11-08-跨域账号保存修复0194准备发布) 执行迁移和发布，不读取、重建或替换 MASTER_KEY，不自动重放历史任务。

发布准备追加审查桌面清单、两份锁文件和发布说明，确认仅递增版本元数据、无依赖变更。最终工作区审查 total_files=21、reviewed_files=20、skipped_files=1、coverage_rate=95.24%；跳过项仍为原有机器配置。本次提交范围为 20 个文件，全部已审，无未解决发现。

发布准备期间，本机额外运行覆盖率时真实 Chromium 状态传输入口因超时失败；随后隔离复测该文件 2/2 通过。该次覆盖率运行不算通过，不替代前述完整测试或正式 Ubuntu 覆盖率门禁；生产构建仍须在准备浏览器资源后重新验收此入口。

## 2026-11-08 0.19.3 正式生产发布（领取已恢复）

用户随后授权提交全部项目代码并部署，覆盖下节本地验证时的暂不部署要求。项目代码、测试、版本及发布说明经 [PR #19](https://github.com/zhangheng2022/taskrelay/pull/19) 合并，固定源提交为 `9bebe3d5e4effb5598535fd4f65568b290a0d60d`；[主分支 Quality 42487677936](https://github.com/zhangheng2022/taskrelay/actions/runs/42487677936) 和 [正式发布 42488175891](https://github.com/zhangheng2022/taskrelay/actions/runs/42488175891) 均成功。用户原有机器配置 `.codex/config.toml` 保留在本地，未提交；没有将缓存、诊断、密钥或产物纳入版本库。

两套系统完整测试各 474 项，473 通过，1 项因普通测试 Runner 尚未准备原生浏览器资源而跳过；托管 Windows 打包作业在 prepare:browser 后单独运行该浏览器状态入口并通过。PR Quality 的 Ubuntu 覆盖率为行 73.67%、分支 81.67%、函数 81.07%，差异可执行行 49/49；类型、格式、lint、仓库、工作流、故障探针及安全门禁通过。最终提交 14 个文件全部完成 OCR preview/rule 与宿主审查（14/14、100%，无未解决发现），包含测试、锁文件、配置和发布说明；未调用 OCR 外部模型。下节本地工作区审查统计是提交前的独立范围记录。

正式 Windows 产物重新构建，包内及实际安装 smoke 均 passed=true。系统入口创建的安装进程位于 `C:\Users\runneradmin\AppData\Local\TaskRelay\app-0.19.3\TaskRelay.exe`；构建和安装 ASAR SHA-256 均为 `93800ede1c7bfa2e786b8716a5e8a6803c62fbae167f9724bf81739be00470a0`，release-manifest 核验通过。该验收来自托管 Runner，没有声称安装或验证用户另一台电脑。

| 正式产物                    |    字节数 | SHA-256                                                            |
| --------------------------- | --------: | ------------------------------------------------------------------ |
| TaskRelay.Setup.exe         | 388403200 | `43e138858843ed25bf7dc6d05757f299eca79dbec416dd1fc4bf549caea76244` |
| TaskRelay-0.19.3-full.nupkg | 387867917 | `6d4df8c829d6706a3cd33b2f3c40e7b2266a16488b21a07e845cd556c4e2ad28` |

[0.19.3 Release](https://github.com/zhangheng2022/taskrelay/releases/tag/v0.19.3) 已公开，Cloudflare 入口完整下载核对大小和 SHA-256 后启用 latest。Worker `e4e93d92-8f6e-43e7-9003-08febcd78508` 承接 100% 流量；主域 health、主页及实际 JS 资源均 200，源码 SHA 正确、协议 18，匿名用户及管理员接口均 401，最新目录为 0.19.3。保留 D1 恢复点，没有待应用迁移，没有清空业务数据、读取或替换 MASTER_KEY。

首次切换后 phase=awaiting-device、maintenance=0、claimsEnabled=0；设备就绪状态在只读检查间发生变化，未凭单次在线结果认定已恢复领取。[恢复发布 42489088082](https://github.com/zhangheng2022/taskrelay/actions/runs/42489088082) 按原源提交及产物运行 42488175891 成功完成，构建作业按恢复模式跳过，没有重新打包、部署或手改领取开关。最终回读 phase=complete、maintenance=0、claimsEnabled=1，1 台未吊销、协议 18 的设备最近 90 秒内在线且就绪。云端就绪核验不能证明另一台电脑已升级到 0.19.3，桌面字段去重需升级后才生效；本次没有代用户运行真实模型或业务网站任务，实际摘要次数、耗时及任务效果仍待复测。

公开核验、正式 smoke 摘要及发布元数据保存在忽略目录 `.cache/db-refactor/0.19.3-*`；本节为正式发布证据，下节保留此前本机调试包的独立记录。

## 2026-11-08 0.19.3 字段去重与摘要提示优化（本地验证完成，未部署）

用户要求按两步方案优化并测试，暂不部署。保留本轮开始前的 `.codex/config.toml` 及两份部署恢复记录改动。源码版本升至 0.19.3 并同步两个锁文件，仅版本变化，协议 18／本地 schema 4 不变。新增引用仍只用于模型输入表示，浏览器导航、工具反馈、原始用户消息、账号、停止、租约及 unknown 保护保持原处理路径。

当前页面可引用同次工具结果的基础现场，并在 overrides 完整携带变化字段；仅同网址、同字段集合且实际序列化更小时使用，按当前待发送历史选择最小表示。空数组、null、标题、标签页、加载和网络状态不深层拼接旧值；重复调用或结果 ID、网址／字段集合变化、失败观察、非页面工具及无可用来源时保留完整现场。摘要移除引用目标后重新投影并按实际保护输入回算预算，不修改或裁剪原工具历史。

共享摘要提示聚焦旧摘要与新增进展合并，省略重复目标、规则、原文和页面描述，同时要求保留独有约束和纠正、关键结果与必要完整网址、未完成事项、未执行调用、错误、是否送出和结果未知。不改变 80% 触发、30% 近期保留、输出预留及原有超限拒绝，不新增硬截断或重试。确定性摘要模型仅验证生产请求接线与关键事实传递，不能证明真实模型一定遵循提示或减少摘要次数。

定向回归 73/73，覆盖变化字段无损还原、空值／删除字段、选择及移除来源、重复 ID、不划算的引用、实际图摘要后的完整恢复和预算、真实 execute 的持续变化网络状态及完整长网址，以及摘要输入中的完整旧历史和未知结果。使用同一合成输入对比 HEAD 的 0.19.2 与新实现，计入各自 guide 后，短网址场景由 2770 降至 2695 字节、长网址场景由 7868 降至 5244 字节，并核验完整还原。该对照不是重跑用户任务或生产性能测试；真实 36 轮任务的末尾诊断只保留 8 份快照，不能补出早期峰值。

最终完整测试 474/474（无跳过）、类型检查、lint、仓库检查、格式及 Web/Worker 本地构建通过；Web 构建保留既有分块提示。`npm run make` 成功，之后新生成的包内 smoke passed=true，版本 0.19.3，Electron 45.2.3、Node 24.22.2、Stagehand 4.4.0、CDP 0.34.0，原生 ESM、浏览器状态往返、LangGraph 工具和中断、本地夹具网站、表单及脱敏截图通过。ASAR 检查确认包含 overrides 及新摘要提示，未用旧包报告冒充新包验证。

本机安装器 388615680 字节，SHA-256=`41bc7cb6e2096599907b3ffbb9aca5b6908f327722d5144f27441035bfef8d6e`；nupkg 388079423 字节，SHA-256=`94fc89bdf5571d2fe065136df382cd277c0312ff2b183ab2d91d5a761221dbdf`；ASAR SHA-256=`93800ede1c7bfa2e786b8716a5e8a6803c62fbae167f9724bf81739be00470a0`。证据位于忽略目录 `out/field-dedup-0.19.3-20261108-133839Z/`，包含 make、packaged-smoke、artifact-hashes、bundle-check；合成对照及测试和审查日志位于 `.cache/db-refactor/`。

OCR preview/rule 成功，宿主完整审查本轮差异及相关上下文，补审默认排除的 4 个测试、3 个架构／验收／部署文档、CHANGELOG 和根锁文件；total_files=14、reviewed_files=13、skipped_files=1、coverage_rate=92.86%，唯一跳过项是未修改的用户原有 `.codex/config.toml`。发现调用或结果 ID 重复时引用来源不唯一，已增加完整现场回退及回归，无未解决发现；未调用外部审查模型。Graphify 更新为 6759 节点、11657 边、583 社区，初始查询截断部分由源码阅读补足，保留既有不支持扩展及社区标签限制。

本轮没有提交或推送、安装本机执行器、发布 GitHub Release、切换更新目录或部署云端，没有运行用户的真实任务。这是未提交工作区的本机验证包，不替代托管 Runner 正式发布、系统安装 smoke、干净 Windows 或真实模型／网站验收；独立 smoke 不调用完整 runtime.execute/ExecutorHost，执行入口由源码隔离回归覆盖。实际摘要次数、耗时和模型对新提示及字段引用的理解效果，仍待用户后续明确授权升级并复测。

## 2026-11-08 0.19.2 正式生产发布（领取已恢复）

用户授权提交并部署，功能、发布说明及交付修复分别经 PR #15、#16、#17 合并。固定源提交 `d5ec76dbe6d657457e6e37580f89fd410f8c7ee8` 的 [主分支 Quality 42476060096](https://github.com/zhangheng2022/taskrelay/actions/runs/42476060096) 全部通过，[Production release 42476649285](https://github.com/zhangheng2022/taskrelay/actions/runs/42476649285) 成功，正式 [0.19.2 Release](https://github.com/zhangheng2022/taskrelay/releases/tag/v0.19.2) 已公开。Worker `f07bf2af-9c4e-4d90-bb7c-7e03c26a458a` 承接 100% 流量，主域 health=200、源码 SHA 正确、协议 18。当前更新目录为 0.19.2；主页与实际 JS 资源均 200，匿名用户及管理员接口均 401。

两套系统的完整测试各 467 项：466 通过，1 项因普通测试 Runner 未准备浏览器资源而跳过；托管 Windows 打包作业在 prepare:browser 后单独运行浏览器状态生产入口并通过。Ubuntu 覆盖率为行 73.64%、分支 81.62%、函数 81.07%；PR #17 差异可执行行覆盖 84/85。格式、lint、类型、仓库、工作流、故障探针、CodeQL 和依赖安全门槛通过。CodeQL 的 js/file-access-to-http 中等级提示指向固定公开工具清单中的 URL，经核对没有发送用户文件或密钥文件，API 令牌只发往固定 GitHub API；解决该已审查讨论，未关闭扫描、撤销警告或改变门槛。

正式发布重新构建并验收同一份产物，包内和实际安装 smoke 均 passed=true。系统快捷方式创建的实际安装进程位于 `C:\Users\runneradmin\AppData\Local\TaskRelay\app-0.19.2\TaskRelay.exe`，安装及构建 ASAR SHA-256 同为 `1a110974161030986a4b5f93d05abd1282d2d0d685d52b57334ff6995cf74496`；release-manifest 核验通过，没有复用本机调试包作为发布附件。

| 正式产物                    |    字节数 | SHA-256                                                            |
| --------------------------- | --------: | ------------------------------------------------------------------ |
| TaskRelay.Setup.exe         | 388407296 | `0530261d680291f26212d49c6a56692157d03f33ad828de9cc4e16aceecbb2a5` |
| TaskRelay-0.19.2-full.nupkg | 387869438 | `458995de52ff0a04ef68bb89ef78c0c0535447a91ba4afa1e88602be143564b8` |

生产流程保留 D1 恢复点，报告没有待应用迁移，没有清空业务数据或更换 MASTER_KEY。更新目录先登记候选，经 Cloudflare 入口完整下载核对大小和 SHA-256 后才激活 latest；GitHub 资产与主域更新目录的版本、大小和哈希一致。原两个设备均已吊销，未擅自恢复旧身份，发布曾为 awaiting-device、maintenance=0、claimsEnabled=0。

用户随后确认另一台电脑已安装 0.19.2 并重新授权。只读核验 1 台未吊销设备协议 18、最近 90 秒内在线且 claim_ready=1 后，执行 [恢复发布 42479287437](https://github.com/zhangheng2022/taskrelay/actions/runs/42479287437)，固定原源 SHA 并复用产物运行 42476649285，构建作业按恢复模式跳过。工作流成功，最终回读发布 phase=complete、claimsEnabled=1、maintenance=0，仍有 1 台在线就绪设备。主域 health=200、源码 SHA 及更新目录 0.19.2 正确；没有重打包、重新部署、手改领取开关、解除旧设备吊销或重放任务。另一台电脑的版本依据用户确认，云端直接核验的是授权、协议、在线及就绪状态；未代用户执行真实任务。

本机真实 Electron 归档下载及有限重试证据、最终 PR 的 9 文件 OCR 宿主审查记录、公开发布元数据和主域核验保存在忽略目录 `.cache/db-refactor/`；用户原有 `.codex/config.toml` 未提交。最终源码图为 6754 节点、11652 边、585 社区，保留既有无支持扩展及未调用 LLM 更新社区标签的限制。独立 smoke 不调用完整 runtime.execute/ExecutorHost，源码执行入口使用隔离夹具验证；本次没有在用户另一台电脑、真实模型或业务网站复跑任务，实际任务效果仍待用户验证。

## 2026-11-08 正式发布准备与质量工具下载恢复

用户进一步授权提交并部署。上下文修复经 PR #15 合并，功能合并提交 d96b934 的主分支 Quality 42463728649 全部通过，含托管 Windows 打包、系统安装及 smoke；发布说明经 PR #16 修正为 0.19.2。最终文档合并提交 b77ed13 的 Quality 42464232763 遇到官方工具下载故障：CodeQL 工具包返回 HTTP 504，重试后通过；工作流检查下载连续三次失败，本机对 ShellCheck 和 actionlint 原入口同样收到 504，官方资产 API 可用。

为恢复正式门禁，质量工具增加受限的官方 API 备用下载，固定版本及归档 SHA-256 不变，拒绝资产身份变化、非官方跳转、跨域令牌转发、下载失败和错误哈希。新增回归覆盖正常下载、传输失败、HTTP 失败、资产身份、跳转主机、令牌边界和两条路径的哈希拒绝，相关质量测试 10/10、类型检查、lint 及仓库检查通过。生产尚未因这些失败而切换，不使用旧提交的绿色报告替代最终源提交检查；正式发布结果在完成后追加。

通过生产下载函数强制模拟原入口 504，备用 API 实际取得 ShellCheck 的 3773312 字节、actionlint 的 2353908 字节 Linux 归档，均通过原固定 SHA-256。OCR preview/rule 成功，宿主补审 6 个源码、类型、测试、工作流及文档文件，唯一跳过项是用户原有 `.codex/config.toml`（7 项中已审 6 项，85.71%），无未解决发现；未调用外部审查模型。Graphify 更新为 6753 节点、11651 边、585 社区，保留既有不支持扩展及社区标签限制。

PR #17 的静态、CodeQL、安全及两套系统测试通过，桌面验收两次在 Electron 归档下载报告 BROWSER_DOWNLOAD_RANGE_INVALID。旧错误不含 HTTP 状态，不能据此断言是 504；本机抽查各位置的一字节 Range 均正常。补充构建分段诊断中的状态码，并在原六次上限内重试 408／429／500／502／503／504，临时错误正文不写入分段；错误范围、超长响应及最终哈希不符仍拒绝。新增生产下载入口回归覆盖合法前缀后连续 504／429 恢复及持续 503 的次数上限、缓存保留，相关下载及质量回归 15/15、类型和 lint 通过，等待更新后的正式 CI 验收。

本机实际 Electron 45.2.3 完整归档下载进一步复现 HTTP_302，最后只保存跳转头，未取得有效资源分段；当时尚未记录 curl 退出码。增加 curl 非零退出且仅留下 3xx 头的有限重试，错误正文不进入缓存；新增入口回归确认连接恢复后取得完整归档，而 curl 成功退出但仍为 302 时继续拒绝。相关回归 16/16、类型和 lint 通过。错误诊断同时包含数字状态和 curl 退出码，不输出带签名的跳转地址。

随后真实归档下载在第 37/38 段记录 curl 35 的跳转后连接失败，有限重试成功完成全部 158182975 字节并通过 Electron 自带固定 SHA-256。更新后 PR Quality 42474817024 的源码检查、两套系统测试、实际资源下载、make 和包内 smoke 均通过；安装 smoke 在停止候选进程时遇到已随父进程退出的子进程 PID，Stop-Process 因该 PID 不存在而失败。安装脚本只容忍已经消失的进程，仍存活时的停止错误继续抛出，并再次核对候选安装路径没有遗留进程；系统入口与安装 ASAR 验收继续保留，待更新后的托管安装流程验证。

## 2026-11-08 0.19.2 现场网址与重复页面信息去重（已安装本机，未部署云端）

用户导出的 0.19.1 诊断显示运行在第 5 轮因 CONTEXT_SUMMARY_NOT_REDUCED 结束：当前网址 2593 字节，单标签页列表 2613 字节，二者又进入最新 act 的 observation；该现场 6146 字节，占该工具消息 7206 字节中的大部分。历史可用额度 3316，完整保留的近期调用及结果 3772，新摘要 575，替换后 4347。上述 token 是本地预算估算；诊断不含原始网址，未推断具体登录参数或读取浏览器历史。

按用户授权，仅调整桌面模型现场表示。重复网址在本对象内引用，当前现场与同次输入中已有的完整工具现场精确相等时引用该结果；浏览器完整网址、原始消息、账号、不同历史现场、操作反馈、错误及观察失败事实不裁剪。摘要移除引用目标后自动恢复完整现场并重新计算预算。摘要提示、80% 触发／30% 保留配置、输出预留、停止、租约与 unknown 防重规则未改。桌面升至 0.19.2 并同步两个锁文件，仅版本变化，协议 18／本地 schema 4 保持不变。

新增回归验证多标签页可还原全部完整网址、不同参数和片段不合并，act/navigate/wait/switchPage 的现场引用可在同次消息解析，原文和账号值不改；同网址的 loading/network/title 改变及观察失败均不合并。实际执行图覆盖摘要移走引用目标后的恢复及预算回算，实际 execute 覆盖约 2.6 KB 网址、接近本次大小的反馈和摘要、两次读取及两次操作后正常结束，并确认 page.goto 原样收到长参数和片段；原有真实超大 extract 仍按原保护拒绝，未通过截断掩盖超限。

隔离对照从 HEAD 提取去重前的 runtime/graph，复用相同夹具及当前固定依赖：去重前在第一次操作后再次报 CONTEXT_SUMMARY_NOT_REDUCED；本轮生产入口完成预定的 2 次读取、2 次操作和最终回复。夹具使用公开 example.com 网址与确定性模型，不是重跑用户任务或对已安装旧包的实测。定向测试 66/66、完整回归 457/457（无跳过）、类型检查、lint、格式、仓库检查和本地 Web/Worker 构建通过；构建保留既有分块提示。

`npm run make` 成功，最终产物之后新生成的包内 smoke、系统安装 smoke 均 passed=true，Electron 45.2.3、Node 24.22.2、Stagehand 4.4.0、CDP 0.34.0。浏览器资源校验、原生加载、浏览器状态往返、LangGraph 工具及中断、本地夹具网站、表单及脱敏截图通过。安装器由 Windows Explorer 打开；安装后关闭空闲 Main，再通过实际桌面 TaskRelay.lnk 启动，核对新进程路径为 `C:\Users\96227\AppData\Local\TaskRelay\app-0.19.2\TaskRelay.exe`，不是 out 或 Codex LocalCache 副本。

升级前在 UI 暂停领取，确认没有未完成任务、待确认领取和待回传回执，保留仓库外受限权限备份后再安装。本地 schema 4、integrity=ok；配对令牌密文、除临时暂停外的配置、1 个 Profile、Local State 和系统加密配置均与升级前一致。最后通过 UI 恢复原有领取状态，0.19.2 显示主域名 `https://tr.zhangheng.eu.org` 和“在线，等待任务”；没有重新配对或迁移其他电脑数据。

安装器 388619264 字节，SHA-256=`25f7cbf3408227e9f9316c66515b5be7293446694632ba5b3a1c3954eb903b86`；nupkg 388080944 字节，SHA-256=`a4a17a74906cfe07223110e184bbdf3ab9a1efecd09356f216071ff48671b93c`。构建与实际安装 ASAR SHA-256 同为 `1a110974161030986a4b5f93d05abd1282d2d0d685d52b57334ff6995cf74496`。本次证据位于忽略目录 `out/page-dedup-0.19.2-20261108-154759/`，包括 make、两份 smoke、产物哈希、系统入口和本地状态核验；私密备份不放入交付目录，不自动删除。

OCR delegate preview/rule 成功，宿主沿用此前统计代码审查并补审本次去重、摘要预算、测试、版本与交付文档：total_files=21、reviewed_files=20、skipped_files=1、coverage_rate=95.24%，无未解决发现。默认排除的测试、文档与锁文件已补审；唯一跳过项是用户原有 `.codex/config.toml`，未修改。未调用外部审查模型，不将本次差异审查称为全仓审查。

Graphify 增量更新成功，6745 节点、11637 边、584 社区。保留 12 个无支持扩展文件跳过、Windows 路径表示切换的 stat-index 警告和未调用 LLM 更新社区标签的限制，相关变更仍以源码阅读及测试为准。

此为未提交工作区的本机调试包，没有推送、发布更新、部署云端或更改云端配置。两份 smoke 使用独立目录及确定性模型，不调用完整 runtime.execute/ExecutorHost；完整执行入口由源码夹具回归覆盖。未在干净 Windows、真实模型或用户业务网站复跑；本次用户任务是否不再超限，仍待其使用本机新版运行并导出诊断核验。

## 2026-11-08 0.19.1 主域名配对与连接恢复

用户报告首次配对 CLOUD_RESPONSE_INVALID。只读探测发现主域健康和配对入口均为 403 HTML、cf-mitigated=challenge；Cloudflare GraphQL 安全事件的 source=botFight、action=managed_challenge，与本机错误分类对应。已有 workers.dev 的相同源码健康正常；短暂经本机 UI 发起该入口配对后，用户要求继续用主域名，已在未配对、journal=0、outbox=0 时停止空闲 Main，仅恢复 cloudUrl 为主域，再重新启动，未移植或解密设备令牌，也没有批准备用配对。

用户获知影响全部子域后，明确授权只关闭 Bot Fight Mode。配置从 fight_mode=true 改为 false，逐字段回读确认只有 fight_mode 变化；浏览器检查仍 on，既有自定义防火墙版本 1、配置规则版本 3 不变。未部署任何代码，主域 health 的源码仍为 b4ad9133de04a1d14f95c4c49c3b59933a3fae9d、协议 18。初次变更后的探测仍收到挑战页，后续已生效：health=200、非法配对输入返回 400 JSON INVALID_INPUT，证明请求已到达业务校验，不把该非法请求当作成功配对。

随后实际本机 0.19.1 从主域正常生成配对校验码，用户核对并在网站批准。UI 最终显示“在线，等待任务”，工作空间为 https://tr.zhangheng.eu.org，本机仅检查令牌存在性为真、outbox=0，没有输出或读取明文令牌。此前错误和旧配对等待已消失。证据记录在忽略目录 `.cache/db-refactor/pair-network-diagnosis.json`；没有代用户运行真实任务，具体上下文占用仍等待其在此新版执行器运行后导出的诊断。

## 2026-11-08 上下文诊断版 0.19.1 本机安装（未部署云端）

用户进一步授权先打包安装到本机，再自行运行任务并导出诊断。桌面版本由 0.19.0 升至 0.19.1，同步根锁文件和精选运行依赖锁文件，仅版本字段变化；协议 18、本地 schema 4、摘要及执行规则不变。`npm run make` 成功，浏览器 Chrome 157.0.8103.38 的 305 项资源哈希校验通过，产物中的 executor 和 Main 均包含 contextSizes，executor 同时含页面子字段统计。类型检查、仓库检查、版本文件格式和差异检查通过，前批 448/448 测试证据继续适用于未改变行为的统计代码。

最终 make 后新生成的包内 smoke 和实际系统安装 smoke 均 passed=true，版本 0.19.1，Electron 45.2.3、Node 24.22.2、Stagehand 4.4.0、CDP 0.34.0；原生加载、浏览器状态往返、LangGraph 工具和中断恢复、本地测试站点、表单及脱敏截图通过。安装器由 Windows Explorer 打开；首次启动后确认未配对、journal=0、outbox=0、quick_check=ok，再关闭该空闲进程并通过 Explorer 打开实际桌面 `TaskRelay.lnk`，创建新的系统安装主进程，界面版本确认为 0.19.1。实际安装路径为 `C:\Users\96227\AppData\Local\TaskRelay\app-0.19.1\TaskRelay.exe`，不是 Codex LocalCache 副本。

安装器 388616704 字节，SHA-256=`22a9d30ca7504a76e729ce7e03ad329ca3aa4dcab55997935164cdc6a32683e5`；nupkg 388077376 字节，SHA-256=`2f273a4203e3c26c19697870f90ab891ecf347f3e14c5791e065ce0762bb8174`。构建和实际系统安装的 ASAR SHA-256 同为 `89f31ce7b7d680fa76ba5a1b7d3d9f73c174cd435d3a588ae71f115ceff6d1bc`。新证据位于忽略目录 `out/context-size-0.19.1-20261108-125455/`，含 make.log、packaged-smoke.json、installed/installed-smoke.json、artifact-hashes.json、bundle-check.json 和 system-entry.json；未放宽要求干净源码和托管 Runner 的正式 release-manifest。

用户确认旧执行器在另一台电脑；本机此次为新安装，没有复制旧设备身份或更动旧电脑。工作空间地址正确，当前为“尚未连接”，仍需用户通过网站授权此设备，并让下一次复现由 0.19.1 执行。未部署云端、发布更新、修改模型配置或替用户运行真实任务；这些 smoke 使用独立目录、夹具网站和确定性模型，不证明实际模型、业务网站或完整调度成功，也不能补出此前失败时的字段明细。

已在实际安装 UI 打开“导出诊断”的另存为对话框，自动化无法可靠定位该附属窗口的文件名控件，已取消并返回执行器，没有保存本次空记录 JSON；真实导出待用户运行后完成。OCR 委托 preview/rule 成功，宿主沿用前批审查并完整补审版本清单、两个锁文件、CHANGELOG 和安装证据文档：total_files=18、reviewed_files=17、skipped_files=1、coverage_rate=94.44%，无未解决发现；唯一跳过项仍是用户原有 `.codex/config.toml`。锁文件逐项核对仅版本变化，没有重新解析依赖；未调用外部审查模型。Graphify 本批更新为 6730 节点、11603 边、584 社区，保留既有不支持扩展和社区标签限制。

## 2026-11-08 上下文大小统计（仅本地源码）

按用户“只增加各部分大小统计，不改执行逻辑，暂时不要部署”的要求，新增保护输入、工具定义、历史角色和最大消息的字节／估算 token 统计，细分页面、用户消息、账号及工具反馈；摘要前后另外区分摘要本身和完整保留的近期结果。每次运行最近 8 份快照随既有检查点保存，终态仍保留，可通过现有“导出诊断”读取。严格白名单只允许数值、固定分类和位置，不导出任务原文、网页地址、登录信息或错误正文。统计与计费 token 不同，字段和父级有重叠，读法见架构的执行阶段计时说明。

新增隔离回归通过真实 `execute()` 入口模拟“大工具结果＋短摘要”：原有 `CONTEXT_SUMMARY_NOT_REDUCED` 仍出现，仅 1 次提取、1 次摘要和 1 次决策，没有新增模型调用或重试；失败终态的统计正确区分短摘要与超限的近期 extract 结果，并完成既有资源清理。另验证统计开关／接收方抛错时摘要与决策请求、返回消息完全一致，原有失败、空摘要、停止和租约失效均不提交历史替换；真实 Journal 写入、终态替换、导出、最近 8 份上限与嵌套原文拒绝也有回归。

定向回归 51/51、完整测试 448/448（无跳过）、类型检查、lint、仓库检查、Web/Worker 本地构建和差异检查通过。构建仍提示共享模块动态／静态导入重叠与较大客户端分块，未在本批调整打包。OCR delegate preview/rule 成功，宿主完整审查本批 12 个源码／测试／文档文件，包含默认排除的 3 个测试和 2 个文档，无未解决发现；预览合计 total_files=13、reviewed_files=12、skipped_files=1、coverage_rate=92.31%，跳过项仅为用户原有 `.codex/config.toml`，保持未修改且不属本批交付。Graphify 更新为 6739 节点、11602 边、588 社区；新测试文件未提取出符号、12 项无支持扩展文件跳过，社区标签未调用 LLM 更新，符号缺口已直接阅读源码补审。

本批没有部署、打包、安装、改变模型配置或重跑用户任务；生产和当前已安装的 0.19.0 尚无这些新统计。历史失败缺少原始上下文，不能用本次模拟断言当时具体是哪一字段过大。只有后续运行使用包含本改动的桌面代码，才会产生可核对的字段大小证据。

## 2026-11-08 新设备配对协议与领取恢复

用户报告 0.19.0 显示 CUTOVER_NOT_READY。生产检查发现新配对设备仍被批准入口写为协议 2，而旧设备升级要求 maintenance=1、claimsEnabled=0；前批等待设备时已恢复网站，形成新设备首次连接的死锁。先确认没有排队/活动/未清理运行，在领取暂停期间临时开启维护；设备自行通过原升级入口提交 localReady 并变为协议 18，没有直接改写设备协议或伪造心跳。首次恢复检查早于新心跳到达，仍保持 awaiting-device；收到新心跳后，[恢复发布 42398978687](https://github.com/zhangheng2022/taskrelay/actions/runs/42398978687) 核验实际设备就绪，将原发布推进 complete，maintenance=0、claimsEnabled=1。

源码将新配对批准的旧常量 2 改为 PROTOCOL_VERSION；start 入口仍只接受当前协议。既有旧设备的维护、本地就绪及运行清理门槛不变，重复批准保留原身份及吊销状态。新增生产路由回归在修复前复现 2≠18，修复后覆盖开始、管理员批准、poll、设备 status/readiness、匿名/设备身份拒绝及重复批准后的吊销保持。定向配对/切换/API/可靠性测试 24/24、类型检查、lint 与仓库检查通过；Hono CLI 已读取真实路由并确认 health=200/协议18。完整质量门禁及云端修复发布继续通过固定 SHA 的 Actions 执行，桌面代码、协议号和安装包版本均不变。

## 2026-11-08 存储 v2 生产全量重置与正式桌面发布

按用户“数据全部清空，不保留历史数据”的明确要求执行，取代本轮生产保留数据转换计划。[Quality 42396015821](https://github.com/zhangheng2022/taskrelay/actions/runs/42396015821) 与 [正式发布 42396374508](https://github.com/zhangheng2022/taskrelay/actions/runs/42396374508) 成功，源码固定为 `8f0009b29330b3903434c944ee8946c41164164c`。Worker 版本 `d8748c53-2466-4e44-8030-969a564da839` 的流量为 100%，协议 18。本文后续“尚未部署”段落是前批时间点记录，当前状态以上述最终发布为准。

维护窗口暂停旧库领取和交办，运行/浏览器清理、AI 回合、调用、dispatch、命令、inbox 与清理作业待处理数均为 0。先部署无 DO 类/绑定的维护入口，应用 `storage-v2-reset-drop-20261108`，核验七个旧命名空间全部消失；再由正式发布应用 `storage-v2-reset-create-20261108` 建立七个新 SQLite DO 命名空间，其 ID 均不同。Secret 通过 keep_bindings 保留，未读取、生成或覆盖 MASTER_KEY 等平台密钥。

唯一业务 D1 已切为 `taskrelay-v2-20261108`（`1951016f-1c9b-459e-a332-75266106f7ad`），storage_meta=2、基线迁移已登记、foreign_key_check 为空。切换后核验认证用户/会话、成员、设备、模型、账号、任务、运行、聊天、消息和附件计数均为 0。核验新绑定、公开下载及权限后，旧业务 D1 `9d387f48-6e34-4af4-a2a0-10f958d65a16` 已通过 API 删除并从列表消失；既有独立验收库未删除。未制作旧数据转换归档，本机旧库和 Profile 未清除。

正式 [0.19.0 Release](https://github.com/zhangheng2022/taskrelay/releases/tag/v0.19.0) 已公开，托管 Windows 新构建的包内 smoke、系统快捷方式启动、进程/安装路径核对、实际安装 smoke 与 release-manifest 均通过。实际安装可执行文件为 `C:\Users\runneradmin\AppData\Local\TaskRelay\app-0.19.0\TaskRelay.exe`，安装资源位于同目录 resources，安装与构建 ASAR 哈希一致，非 Codex LocalCache 副本。

| 正式产物                    |    字节数 | SHA-256                                                            |
| --------------------------- | --------: | ------------------------------------------------------------------ |
| TaskRelay.Setup.exe         | 388404224 | `de8e4bb61132a15b34615c265b9a5239f3aedad8f5fe797e68d647ac0be7cb2a` |
| TaskRelay-0.19.0-full.nupkg | 387865151 | `c559d3ea24a73792169882a666f5146a2a7edcd3719c56970af648c8ee73f0c5` |
| 构建/安装 app.asar          |         — | `984f44b2a7f4f210e725ba9e5bc04f03070aee3464ee72bab446fea4ece05930` |

正式流水线通过 Cloudflare 入口完整下载 nupkg 并核对字节数及 SHA-256 后才激活更新目录。workers.dev health=200，协议/SHA 正确；匿名 `/api/user/me`、`/api/admin/operations` 均为 401，首页及实际 JS 资源 `/assets/index-Dpf0pjn_.js` 为 200，最新更新目录为 0.19.0。主域命令行请求被 Cloudflare 防护返回 403；真实 Edge 的主域 health 显示同一协议/SHA，主页正常显示登录和管理员首次注册入口。未调整防护、注册账号或发送邮件。

网站 maintenance=0、storageFrozen=0；因配对设备已清空，发布阶段为 **awaiting-device**，claimsEnabled=0。代码、网站、公开安装包和更新目录已上线，执行领取尚未恢复。须重新注册并验证管理员、配置模型、处理旧本地库并配对新版设备；设备就绪后按 DEPLOYMENT 的固定 SHA/recovery-run 恢复发布，不能将当前状态写成 complete。

最终主分支完整测试为 442 项：441 通过、0 失败、1 项需真实 Chromium 的测试跳过；正式 Windows 作业准备浏览器后，该真实状态适配器套件 2/2 通过。覆盖率为行 73.12%、分支 81.14%、函数 80.45%；类型、lint、格式、仓库、工作流、安全和 Web 构建门禁通过。前批 UI、workerd/D1、离线转换与容量证据见各自段落；本次没有对生产做百万行压力验证。

OCR delegate preview/rule 对最终提交范围 `b658569..8f0009b` 执行成功；宿主沿用分批审查并复审最后增量，含默认排除的 SQL、测试、配置、声明及删除项：total_files=166、reviewed_files=166、skipped_files=0、coverage_rate=100%，无未解决发现，不是全仓审查。锁文件仅版本同步，旧迁移移动内容逐一核对相同；未提交原有 `.codex/config.toml`、截图、缓存、用户数据或产物。Graphify 最后一轮更新为 6714 节点、11512 边、575 社区，保留提取和社区标签限制，未调用 LLM。

本次生产无已配置模型或就绪设备，没有执行真实模型/网站任务；不能据此声称验证了模型实际地区、完整调度/租约/恢复闭环、百台设备连续在线或用户本机升级。托管 Windows 安装是本次正式安装证据，用户本机尚未安装/重新配对。

## 2026-11-08 发布说明校正

主分支 `4974fcb` 的 Quality 门禁通过。正式发布 42395304459 的 Web 和真实 Chromium 状态检查通过，切换前发现发布说明仍为 0.18.0、包含与本次协议 18 不符的兼容描述，因此主动取消该运行，未进入生产切换。更新 0.19.0 说明，明确客户端升级、本地库离线转换、云端全量重置及重新注册/配置/配对要求；不更改包代码或放宽门禁，正式产物仍须对新固定提交重新生成。

## 2026-11-08 正式发布前 Chromium 就绪竞态

主分支 `638b4ca` 的完整 Quality 门禁通过；首次正式发布 [42393900169](https://github.com/zhangheng2022/taskrelay/actions/runs/42393900169) 在独立 Chromium 状态验证中返回 CDP_DISCOVERY_FAILED，生产作业跳过，旧生产未切换。端口文件出现不保证 HTTP/CDP 就绪；测试现按 Main 的 20 秒启动窗口等待下载禁用策略成功，进程退出立即失败，每次连接都关闭，不重试状态恢复或业务操作。测试固定模拟首次探测失败后继续连接真实 Chromium，验证这一恢复路径。两个独立浏览器各有启动窗口，整体测试上限调整为 90 秒。

本机 Chromium 状态与 CDP 回归 7/7、类型检查与 lint 通过；正式托管打包和系统安装验收须对后续固定提交重新执行，不能复用前批产物。既有生产仍为旧库和协议 17，清空尚未执行。

## 2026-11-08 发布前 CI 回归：本地回执 FIFO

PR #10 的首轮 Linux 测试发现同毫秒写入时，`created_at,id` 索引会按随机请求 ID 倒置 finish/browser-closed；本机较慢写入未稳定触发。未切换生产。schema 4 基线在发布前增加 outbox 内的递增 `ordinal` 及唯一索引；序号分配与入队在同一 SQL 写入完成，时间只保存事实时点，重复 ID 不改变原位置。离线转换按旧时间/rowid 顺序固化新序号，重复转换同时核对顺序，目标被重排即拒绝。

确定性回归覆盖同毫秒、时钟回拨、随机 ID、重复请求、重启、旧回执转换与目标顺序篡改；本地定向验证通过。前批本机 0.19.0 调试产物不含此修复，不能作为最终发布证据；正式托管构建和主分支门槛须对修复后的提交重新验收。

## 2026-11-07 补齐审查、下载与桌面包内 smoke（本机，未部署/安装）

补审前批跳过的 `.codex/config.toml`、`.graphifyrc`、执行器提示词差异和完整 1935 行 Drizzle 映射，保留原有内容。对照 SQL、认证调用、归属约束、状态、时间及密文语义，未发现新增可复现问题。下载和 Forge 变更也完成差异复审；OCR preview/rule 成功，宿主累计审查本工作区差异 **total_files=190、reviewed_files=190、skipped_files=0、coverage_rate=100%**，包含默认排除的 SQL、测试、声明和配置，不是全仓审查，未调用 OCR 外部模型。逐路径记录仍在 `.cache/db-refactor/ocr-review.json`。

浏览器原下载每次从头开始，curl 的单次超时及更短的外层进程超时不能覆盖当前慢链路。构建下载改为系统 curl、4 路并发、4 MiB 分段，校验 Content-Range/长度与 ETag，超时保留合法前缀；重跑只补缺少内容，整体 SHA-256 通过后才替换缓存。错误范围或哈希不替换原缓存，已校验的完整缓存不再请求网络，3 个进程/网络隔离测试通过。Chrome for Testing 固定 157.0.8103.38 的 210600182 字节官方压缩包校验为 `ae0deef27d449e1d7529df7705d609bab102de48464da13567ed3dd2ee1a0586`，305 个资源文件逐一校验通过，缓存命中复验通过。没有换版本、放宽 TLS、禁用沙箱或跳过哈希。

Forge 的默认 Electron 下载曾停留在 0 字节；改用同一下载入口并保留已安装 Electron 依赖的官方清单及 `@electron/get` 二次校验。Electron 45.2.3 的 158182975 字节官方压缩包 SHA-256 为 `489cd061908e697394b004298bf5ffd345c935d10e8ca197ba819f019ab2dec0`。`npm run make` 成功，主进程、Preload、Executor 和 Renderer 均构建，生成 Windows x64 解包程序及 Squirrel 安装包。

| 本机构建产物                                                             |    字节数 | SHA-256                                                            |
| ------------------------------------------------------------------------ | --------: | ------------------------------------------------------------------ |
| `apps/desktop/out/make/squirrel.windows/x64/TaskRelay Setup.exe`         | 388406272 | `054991071b4750cbfdace3409eb42805237b19725551fb0afe5fe4206b992cb2` |
| `apps/desktop/out/make/squirrel.windows/x64/TaskRelay-0.19.0-full.nupkg` | 387866332 | `34f71983f7865f026a76f45e94a057e110697b767f412f2da948fd9d6d04c2e4` |
| `apps/desktop/out/TaskRelay-win32-x64/resources/app.asar`                |  80488206 | `588f5f615241b7ae2d0012077132b5573b2d1807e456ec0e3c4367937cf19a0b` |

最终 make 结束后，使用独立新目录运行 `node scripts/smoke.mjs apps/desktop/out/TaskRelay-win32-x64/TaskRelay.exe out/desktop-0.19.0-20261107-235740/packaged-smoke.json`，退出码 0、passed=true。报告确认为 0.19.0、Electron 45.2.3、实际 Node 24.22.2、Stagehand 4.4.0；原生 ESM、ASAR 中的 SDK/CDP 加载、LangGraph 工具与中断恢复、真实 Chromium 状态往返、观察/操作、错误验证码、前导零、多步登录、表单及脱敏截图通过，提交/签到/错误码各一次。报告 ASAR 哈希与当前产物一致，新于本批全部产物；RELEASES 的 nupkg 名称、字节数和 SHA-1 核对一致。实际 Electron 在隔离目录创建的 SQLite `user_version=4`、`integrity_check=ok`；结束后未发现本次 smoke 路径的残留 TaskRelay/Chromium 进程。

完整 `npm test` **434/434 通过、0 失败、0 跳过**，包括此前因缺少浏览器跳过的正式状态适配器测试；下载器最后定向复验 3/3，通过类型检查、lint、仓库检查及格式/差异检查。前批 UI 首轮超时根因仍未确定，本轮完整套件包含全部 UI 用例且未复现。Graphify 最终更新到 6710 节点、11495 边、590 社区；声明文件未产生符号、缓存及社区标签告警保留，未用 LLM 补标签。

证据保存在忽略目录 `out/desktop-0.19.0-20261107-235740/{packaged-smoke.json,build-evidence.json}` 和 `.cache/db-refactor/`。本批为未签名、本机脏工作区调试产物；没有执行安装器、替换系统安装、转换现有设备库、改动云绑定或部署生产，原 MASTER_KEY 不变。不运行或放宽要求干净源码和托管 Windows 系统入口证据的正式 `release-manifest`。包内 smoke 是确定性模型与本地站点流程，不调用 `runtime.execute()` / `ExecutorHost`，不证明生产调度、真实模型/网站、干净 Windows、实际安装升级或百台设备在线；这些边界及前批 Free 容量限制继续保留。

## 2026-11-07 存储 v2 重构（源码完成，未部署/安装）

以下为同日上一批源码交付记录；后续审查和本机打包结果以上节为准。

新基线含 55 张表、442 个字段、50 个显式索引和 24 个触发器；SQL 表/字段/索引中文注释覆盖均为 100%，包括 Better Auth、关联、分块和清理表。Drizzle 对照测试逐项核对表/列类型与空值、主键、外键、全部索引顺序/部分条件及 CHECK。桌面 4 张本地表改为逐字段多行 SQL 和中文说明，DO 类型/入口注明 KV 格式 2、对象归属、分块/AAD 与 alarm 仲裁。源码协议 18、图 relay-graph-4、桌面 0.19.0 / schema 4；既有未提交改动保留，旧 30 份 SQL 冻结为离线输入，未提交产物或密钥。

离线验收覆盖源库只读预检、显式归属、新库初始化、密文解密、unknown 锁、可见历史顺序、退休图归档、重复执行、同源临时库/归档中断重做、错误密钥/目标改写拒绝、外键及整体归档核验。桌面转换保留配置、generation、epoch 和待确认回执身份，不迁移 cache；正常 Main 拒绝旧库及未来 schema。原 MASTER_KEY 未重新生成/覆盖。源库真实全量数据和私有 DO 对象尚未执行预检/转换，生产切换不在本轮执行范围。

生产入口隔离回归涵盖跨用户关联拒绝、活动/清理占用、unknown、重复请求、停止、租约过期、删除与迟到结果竞争、组仍引用历史版本时的正文清理、长模型缓存分块与缺片阻断。实际 workerd/D1 验证新基线循环版本事务、两个设备并发领取同一用户最多成功一个、查询计划及外键；实际 SQLite DO 验证分块加密、退休墓碑和冻结时旧元数据转换。Wrangler `--local` 向独立空 D1 导入 360011 字节 Unicode JSON，返回字节数一致、json_valid=1、foreign_key_check 为空；没有远程导入。Miniflare/本机 D1 不证明部署并发或 Free 配额达标。

容量对照使用 1000 名合成用户、100 台登记设备、1060 个任务/聊天/运行，逐级增加至 100 万消息，另有 10% 用量、5% 附件索引、5% 图记录。v1 另含其旧默认成员，因此实计 1001 名；设备登记数不证明 100 台持续在线/并发浏览器。两种测试均无生产数据、真实模型或网站流量：

- 原生 SQLite：v1 532348928 字节，v2 565919744 字节；生成数据使用 MEMORY/OFF，不能以加载时长证明生产写入性能。报告在 `.cache/db-capacity/2026-11-07T14-44-59.178Z/report.json`。
- 实际本机 workerd/D1：v1 527536128 字节，v2 552624128 字节；报告在 `.cache/db-capacity/workerd-2026-11-07T14-45-10.324Z/report.json`。以下 p50/p95 为 20 次热测、本机 RPC/桥接在内的毫秒值，读写行数来自真实隔离 D1 meta；不等于部署时延或计费承诺。

| 查询           | v1 p50/p95 ms | v2 p50/p95 ms | 每次 rows_read：v1 → v2 | 最终计划                             |
| -------------- | ------------- | ------------- | ----------------------- | ------------------------------------ |
| 任务前 50 条   | 7.29 / 11.15  | 7.22 / 9.82   | 123 → 50                | tasks_visible 覆盖索引，无额外排序   |
| 聊天前 50 条   | 6.92 / 8.36   | 7.06 / 8.97   | 123 → 50                | threads_visible 覆盖索引，无额外排序 |
| 消息前 50 条   | 6.96 / 8.89   | 6.32 / 8.67   | 50 → 50                 | thread_id/seq 索引                   |
| 指定运行用量   | 21.20 / 43.97 | 16.19 / 27.55 | 100000 → 1001           | usage_run，消除全表扫描              |
| 聊天附件 10 条 | 7.03 / 15.83  | 6.63 / 10.35  | 451 → 10                | artifacts_thread                     |
| 原聊天图记录   | 15.80 / 17.75 | 10.44 / 11.06 | 50000 → 1001            | graphs_thread 覆盖索引               |

上述只读查询 rows_written 均为 0。累计加载百万消息及配套记录时，v1 meta 写行数 345 万，v2 为 590 万；正文拆表和匹配查询的索引增加了写入及空间成本，不宣称所有延迟都下降。已去掉确认冗余的索引和用量表无引用需求的额外联合唯一索引；实际业务还有模型账本、checkpoint/outbox、鉴权与状态更新，本夹具不覆盖它们的完整成本。转换清单给出目标字节数与是否落入 Free 单库范围；导出给出插入/分块写行估算，均明确未核验当日剩余导入额度，不能据此直接切换。

**单库 Free 边界已触达：两版百万消息夹具均超过 500 MB。** 官方当前单库上限为 500 MB，账号每日 500 万读行、10 万写行，索引也计写行和空间，超日限额会报错至 UTC 零点恢复。[容量限制](https://developers.cloudflare.com/d1/platform/limits/)、[计量规则](https://developers.cloudflare.com/d1/platform/pricing/)、[日限额强制执行](https://developers.cloudflare.com/changelog/post/2026-09-01-d1-free-tier-limit-enforcement/)。仅按本夹具 5.9 写行/消息估算，约 1.69 万消息/日已用完写额度，尚未计算其他业务；这不是可用吞吐承诺。100 台设备若按每分钟一次心跳全天在线，单心跳估算约 14.4 万次写入，也超出 Free 日写额度。就绪值不变时已合并心跳，暂停/恢复仍立即写入；不能承诺百台持续在线达标。

建议在单库 350 MB、日读/写使用约 70% 或 p95 持续恶化时启动运维容量复核，结合真实数据保留期、冷归档方案与实际活跃设备评估；这些只是预警，不新增任务预算或运行硬限额，不自动付费或改为多 D1。真实源库若超空间或当日导入余量不足，必须阻断切换并另行安排，不能静默删历史/unknown 或绕过平台限额。

类型检查、lint、仓库检查及 Web 构建通过，构建仍有大分块提示。完整 `npm test` 为 **431 项：430 通过、0 失败、1 跳过**；跳过项需要当前缺失的真实 Chromium，不能算通过。独立 UI 套件首次为 64/65，通知刷新用例等待消息超时；该文件单独复验 10/10，随后完整 `npm run test:ui` 为 **65/65**，首轮超时根因未确定。最后一轮仅补充 SQL/Drizzle 注释，类型检查与结构/实际 D1 定向测试 3/3 再次通过。`node scripts/test-free-runtime.mjs` 的真实本机 workerd 网关、alarm、中断恢复、防重、加密多分块、发布仲裁、孤儿清理、WebSocket 及吊销检查通过。日志在忽略目录 `.cache/db-refactor/`，不提交产物。

Hono CLI 已核对路由及 health=200/协议18，shadcn CLI 已读取当前配置和 button/sidebar 文档。Graphify 已通过本机独立工具路径执行查询及更新，最终结构为 6696 节点、11460 边、580 社区。本轮分批更新中有 20 个文件未提取到符号，最后一轮变更的 3 个测试文件也未产生符号；图工具的缓存及社区标签告警保留，未调用 LLM 补标签，不能把图更新称为全部解析无误。

OCR `delegate preview` 和所有路径的 `delegate rule` 执行成功，未调用 OCR 外部模型。宿主按最终差异及上下文审查，并补审默认排除的 SQL、测试、脚本和配置：`total_files=185`、`reviewed_files=181`、`skipped_files=4`、`coverage_rate=97.84%`，范围为工作区差异，不是全仓。30 份旧迁移移出活动目录后的内容已与原版逐一核对一致；两个锁文件仅同步桌面/暂存运行时版本，未改依赖。跳过项为原有且本轮未改的 `.codex/config.toml`、`.graphifyrc`、`apps/desktop/src/executor/runtime.ts`，以及未逐行人工审查的生成映射 `apps/cloud/src/schema.ts`；后者已由人工核对 SQL、注释和自动化全量结构对照覆盖，不能据此算作逐行已审。逐路径状态及已修问题记录在 `.cache/db-refactor/ocr-review.json`。审查修复了毫秒排序/写入、历史版本引用清理、清理批次边界、分页迟到响应及离线转换路径/完整性问题；未发现其他可复现的未解决差异问题。UI 首轮超时及下述交付/容量限制仍保留。

桌面 `npm run package` 未通过：缺少 `resources/browser/manifest.json`；随后按固定版本下载浏览器，原准备流程及断点续传均超时，完整官方压缩包未取得，未放宽 SHA-256/资源校验。无本批可验收桌面包，包内与实际安装 smoke 未执行；干净 Windows、真实模型地区、网站闭环和百台设备持续在线均未验收。Web 构建与源码回归不代替这些证据。

## 2026-11-07 Graphify SQL 解析与覆盖排查

通过 `uv tool install --force "graphifyy[sql]==0.9.103"` 为 Graphify 独立工具环境安装 `tree-sitter-sql 0.3.11`，工具版本仍固定为 0.9.103，未修改项目 npm 依赖。新增 `.graphifyrc` 的 `language.jsonc=json` 映射，补入原先未分类的 `apps/web/wrangler.jsonc`；当前配置提取出 32 个节点和 31 条结构边，Wrangler 自身配置读取同时确认 7 个 DO 绑定和 1 个 D1 绑定，但 Graphify 不会把数组内每项绑定都独立建模。

31 个 SQL 文件（30 个云端迁移、1 个 `scripts/acceptance-site/batch.sql` 隔离夹具）均已产生提取结果且在最终图中有节点，缺失依赖问题已解除。底层语法树核对发现 13 个 SQL 文件存在方言恢复节点，提取器仍返回结构，不能称为“零解析错误”；JSONC 尾逗号也存在恢复标记，当前字段节点和 Wrangler 配置读取已核对，但不承诺任意 JSONC 构造均能完整提取。30 个迁移在内存 SQLite 中按顺序执行成功，`foreign_key_check` 为空；隔离夹具独立执行产生 8 条记录，既有迁移测试 1/1 通过。图表示各迁移中的声明、引用、索引和触发器关系，不等同于执行全部迁移后的实时数据库结构。重建后为 6397 个节点、10744 条边、566 个社区，SQL 引用及 JSONC 配置的图查询验证通过。

原先 39 个“未提取符号”文件已逐项核对；安装 SQL 解析器后，新增仅含 DROP/DELETE 的 `0013_remove_platform_budget.sql` 也只保留文件节点，因此现有单文件提取无符号共 40 个。它们不是全部缺失：文件节点及可提取的导入/调用仍保留，后续引用解析还可能补充节点。分类如下，未为消除告警改写业务源码：

| 数量 | 文件类型与核对结果                                                                                              |
| ---- | --------------------------------------------------------------------------------------------------------------- |
| 24   | `tests/` 中匿名 `test()` 回调或循环注册的测试，当前提取器未建测试用例符号                                       |
| 5    | 桌面 4 份 Vite 配置与 Web Vite 配置，均为匿名默认配置，文件与导入关系保留                                       |
| 4    | `apps/web/src/ui-review.ts`、`scripts/{change-scope.mjs,check-secrets.mjs,check-powershell.ps1}` 为顶层执行脚本 |
| 1    | `scripts/install-smoke.ps1` 为顶层执行脚本                                                                      |
| 3    | `scripts/{check-coverage,quality-gate,release-api}.d.mts` 的 ambient 声明未被当前符号提取器建模                 |
| 1    | `scripts/PSScriptAnalyzerSettings.psd1` 为数据字典，不定义函数                                                  |
| 1    | `docs/RELEASE-NOTES.md` 无章节标题，仅保留文档文件节点                                                          |
| 1    | `apps/cloud/migrations/0013_remove_platform_budget.sql` 仅删除表及设置，不定义新对象                            |

未分类仍为 12 个：`wrangler.jsonc` 已补入，同时新增的工具配置 `.graphifyrc` 本身不生成源码符号。其余为 3 个 CSS（生产 `packages/ui/src/styles.css` 及 `.agents`/`.claude` 中两份技能样式）、2 个 TOML（`.codex/config.toml`、`.gitleaks.toml`）、4 个规则/列表文件（`.git-blame-ignore-revs`、`.gitattributes`、`.gitignore`、`.prettierignore`）、环境变量模板 `apps/web/.env.example` 及二进制 `resources/icon.ico`。CSS/TOML 不在当前结构提取器支持范围，其他文件无适合的代码符号模型；没有用错误语言映射或新增排除规则隐藏它们。

另发现 `packages/contracts/src/conversation.ts:34` 的 `import("./execution").ChatPart[]` 带单行语法恢复标记；`ThreadPage` 仍入图，TypeScript 类型检查通过，不能据此声称所有类型字段关系均已完整提取。逐文件提取结果、语法形态和未分类原因保存在忽略产物 `graphify-out/{extraction-audit.json,EXTRACTION_AUDIT.md}`。

本批仅新增工具配置并更新本节记录；仓库检查、类型检查及配置读取验证通过。OCR preview/rule 已执行，宿主审查本轮 2 个增量文件（`.graphifyrc`、本节记录）：total_files=2、reviewed_files=2、skipped_files=0、coverage_rate=100%，无未解决的配置或文档问题；preview 中其余 5 个既有变更没有新增差异，沿用前批审查，不把 40 个文件的提取形态核对称为完整业务代码审查。未修改运行逻辑或数据库，未重新运行前一批完整业务回归，未调用 LLM、提交、部署、打包或安装桌面应用。

## 2026-11-07 固定提示词精简（仅源码）

精简云端交办、桌面执行、云端协助及截图反馈文案，明确最新用户原文优先、已绑定与未绑定账号的区别，以及 `askUser` 两种答复的接收者。已授权步骤直接执行，缺少目标、范围、授权或关键选择时才澄清；`ask` 不充当用户确认凭证。账号工具细则留在原 description，自动截图由运行时管理并据实反馈。没有修改 Agent 编排、工具 Schema、模型出站、账号/站点隔离、加密、停止、租约或未知结果防重逻辑。

相关定向测试 **92/92** 通过，覆盖模型/结构化输出、美国出站 adapter、原文进入 Stagehand、临时凭据登录与更正、账号卡片、协助恢复、截图及未知操作等现有生产入口。`npm test` 首轮因加载 `node_modules/langchain/dist/agents/utils.js` 返回 `UNKNOWN`，导致 `auth-mail.test.ts` 未运行；该文件单独复验 **3/3** 后，再次完整运行 **419 项：418 通过、0 失败、1 跳过**。跳过项为缺少可用 Chromium 的真实浏览器验证，不算通过。类型检查、lint、仓库检查和 Web 构建通过；构建保留既有大分块及混合导入提示。Hono CLI 直接读取 Worker 导出返回 `INVALID_APP`，改用仓库外仅重导出真实 `app` 的临时入口后，确认 73 条路由及健康接口 200。

使用临时 npm CLI `@alibaba-group/open-code-review@1.13.6` 执行 OCR delegate preview/rule，未修改项目依赖、未调用 OCR 外部模型。宿主审查全部 4 个源码差异及上下文，并补审默认排除的 2 个文档：total_files=6、reviewed_files=6、skipped_files=0、coverage_rate=100%，无未解决发现；范围仅本次差异，不是全仓审查。首次更新关系图时，当前进程无法解析 `graphify` 命令；随后用户安装并处理 Windows 智能应用控制拦截后，通过绝对路径运行 `graphify 0.9.103 update .` 成功生成 6202 节点、10486 边及 537 个社区，产物位于已忽略的 `graphify-out/`。本次为本地结构提取，未调用 LLM；31 个 SQL 文件因缺少 `tree_sitter_sql` 未入图，另有 39 个代码文件未提取到符号、12 个文件未分类，不能宣称关系图覆盖全部源码。

本批未提交、部署、打包或安装，未进行真实模型/网站对照或连续观察。确定性回归证明现有接口与安全流程仍工作，不能证明模型一定遵守精简后的文案，也不能将字数减少等同于决策质量或线上耗时改善。

## 2026-11-07 网站邮箱登录 415 回归

共享请求层使用大小写不敏感的 `Headers` 保留调用方的媒体类型，仅在发送 JSON 且调用方未指定时补充默认值。合成已验证账号通过网站的 `authClient.signIn.email` 进入生产 Hono / Better Auth 路由；同一测试在修复前返回 `UNSUPPORTED_MEDIA_TYPE`，修复后使用服务端签发的 Cookie 成功读取同一账号的会话。

## 2026-11-07 跨任务执行基线

Windows PowerShell 运行以下命令复核。使用固定决策、页面和 RPC 适配器，调用生产 `execute()` 和执行图。每个样本先验证执行结果、写入次数、实际模型调用和空反馈，再按场景报告执行时长 P50/P95。用相同 Node、平台、样本数和机器负载做比较。本基线只测本地编排，真实模型的决策质量、线上耗时和云端排队要另外取样。

```powershell
$env:TASKRELAY_BASELINE_SAMPLES='20'
node --import tsx --test --test-name-pattern='跨任务执行基线' tests/executor-runtime.test.ts
Remove-Item Env:TASKRELAY_BASELINE_SAMPLES
```

在同一机上对只读、单次提交、跨页、多项目、协助后继续、空读取、提交结果未知七类场景改变一个变量：移除只读工具入口紧邻的第二次上下文请求。前后各 20 次。只读与空读取每次由 7 次上下文请求降至 6 次，提交、跨页、协助后继续由 11 次降至 10 次，多项目由 15 次降至 14 次。未知提交保持 11 次且实际只提交一次。前后模型请求次数一致。本地毫秒级 P95 有涨有跌，当前数据只支持请求数下降。

桌面可在现有“导出诊断”中读取 `journal[].timing`。云端需先应用迁移 `0030_inference_timing.sql`。按所有者及运行 ID 绑定下面的只读查询，保留没有用量行的调用；老记录及未取得响应的时点可能为空。任务交办、等设备、执行和等人应分别报告。

```sql
SELECT a.id, a.status, a.created_at, a.egress_started_at,
       u.inference_started_at, u.provider_started_at, u.at AS response_at,
       a.updated_at, u.input_tokens, u.output_tokens
FROM ai_calls AS a
LEFT JOIN model_usage AS u ON u.call_id = a.id AND u.run_id = a.run_id AND u.user_id = a.user_id
WHERE a.user_id = ? AND a.run_id = ?
ORDER BY a.created_at;
```

本轮定向测试 107/107 通过，类型、lint、仓库检查和 Web 构建通过。全量测试 418 项通过 404 项，14 项未通过，涉及 Windows 符号链接权限、Chromium 启动、本机代理与 CDP、workerd 回环访问。使用锁文件的本地缓存完成 Windows 隔离打包，检查了 sharp 原生模块的 ASAR 解包标记和磁盘文件。打包进程实际启动后未生成 smoke 报告，重试退出码为 `0x80000003`。本轮未做系统安装、生产迁移或真实模型对照。

## 2026-11-07 桌面扩展发布与本地集成测试复验

扩展目录重命名在受管 Windows 的系统临时目录返回 `EPERM`，当时目标目录不存在。原实现把它当作并发发布，随后的目录检查用 `ENOENT` 覆盖了原始错误。现在仅在目标可读取时进入内容校验，真实发布错误保留。扩展与 Git 范围检测的测试夹具改用项目可写的独占临时目录。3 项扩展测试、1 项 Git 测试恢复通过，新增权限失败回归在修复前失败、修复后通过。

默认 `npm test` 完整运行 415 项，401 通过、14 失败、0 跳过。12 项依赖回环连接（执行器代理 5、CDP 5、workerd 2），真实连接返回 `EACCES`，其中 CDP 通过记录发现请求底层错误确认。另有 1 项创建 Windows 目录链接返回 `EPERM`，1 项 Chromium 的 Crashpad 启动失败并退出，未到达登录态恢复断言。剩余用例仍待具备这些能力的 Windows 环境复验。类型检查、lint 和仓库检查通过，桌面打包在 npm 获取运行依赖时报 `ENOTFOUND`，本次没有安装验收结果。

本次增量审查涉及扩展发布、两份测试、工作区夹具和本节记录。OCR preview／rule 已执行，total_files=5、reviewed_files=5、skipped_files=0、coverage_rate=100%。关系图已更新，30 个 SQL 文件因缺少解析器未纳入图。

## 2026-11-07 图片引用、二进制上传与缩略图（源码 0.18.0）

本批实现脱敏后的字节预算缩放、multipart 原图／缩略图上传、同图引用复用、稳定上传身份的一次网络重试和固定失败反馈。聊天通过受鉴权链接读取缩略图，打开预览才读取原图；Stagehand 到美国模型出站使用私有图片引用，提供方最后一跳仍展开为 Data URL。临时视觉图限时保存且不进入聊天；新增 D1 0029，旧客户端及旧图片兼容。

已有相关定向测试 59/59、新增图片链路测试 7/7、共享 UI 66/66 和发布入口 2/2 通过；类型检查、lint、仓库检查及 Web 构建通过。新测试覆盖 Main 实际 multipart／boundary、两种模型协议、结构化修复保留引用、模型作业不携带图片字节、引用过期／代次拒绝、旧图回退、损坏 PNG／压缩流／扫描行拒绝、字节预算缩放、取消不重试及上传失败反馈。完整测试首次 413 项中 394 通过、19 失败；其中发布夹具的迁移数量断言已随 0029 更新并定向复验通过，未将定向结果改写为完整测试通过。

其余完整测试失败涉及符号链接权限、Chromium 启动、workerd／CDP／网络本地连接权限、临时 Git 目录权限及扩展临时目录缺失，未将这些项目记为通过。独立 workerd 验证因回环连接 EACCES 未完成；其脚本已增加真实 DecompressionStream 和缩略图加密存取检查，尚需可运行环境复验。桌面 package 在 runtime 依赖下载时因 registry.npmjs.org 的 ENOTFOUND 失败；未生成本批安装包／smoke，未安装或部署，未新增真实模型、网站或连续观察验收。Node SQLite／隔离模型通过不代替实际 D1 并发和美国部署证据。

OCR delegate preview／rule 成功，宿主审查本次 43 个变更文件及必要上下文：total_files=43、reviewed_files=43、skipped_files=0、coverage_rate=100%。默认排除的 15 项测试、文档与锁文件均补审；依赖、生成物、缓存与图产物不纳入变更交付，这不是全仓审查。复审已修正 Main 对非 JSON 网关 502／503／504 的固定错误分类，并增加生产 Cloud.request 隔离回归；没有重试模型或浏览器动作。graphify 更新为 5155 节点／9211 边；缺少 tree_sitter_sql，30 个 SQL 文件未入图，6 个测试文件没有提取符号，迁移以源码和 SQLite 测试为准。

## 2026-11-06 Actions 质量与发布迁移

源码交付版本提升为 0.17.1，协议仍为 17；新增 D1 0028 领取事务屏障，已由首次 Actions 正式发布执行生产迁移。格式提交 `7d9e25c` 独立保存并登记 blame 忽略；行为修复、质量门槛及发布流程分别审查。账号、凭据、Profile、快照和 MASTER_KEY 沿用现有数据。

本地类型、Oxlint、仓库检查、工作流检查和 Web 构建通过；完整回归 **397/397**，包含真实 Hono 管理员会话、暂停后迟到领取、实际 workerd 更新目录、发布状态机及 UI 回归。Windows c8 全源码统计：行 68.64%、分支 81.23%、函数 79.64%；它不是正式 Ubuntu 下限，待托管 Runner 校准。构建仍提示已有大分块，未把提示当成新的发布阻断。

隔离负例验证八类拒绝：格式、悬空 Promise、Hooks、测试失败、覆盖率不足、模拟密钥、无效工作流和漏洞依赖。每项核对实际诊断及总门槛拒绝；未提交坏代码或真实秘密。Gitleaks 扫描现有完整历史无有效命中；只对已核实的公开 Access 标识和精确测试假值配置位置限定例外。根依赖无 High/Critical（仍有 17 个 Moderate），精选桌面运行依赖无已知漏洞。

OCR preview/rule 已执行，CLI 只选文件和解析规则，宿主审查变更及上下文；格式批次另核对 244 个文件等于旧内容的 Prettier 输出，测试、配置和脚本补审。完整清理变更清单 total_files=287、reviewed_files=287、skipped_files=0、coverage_rate=100%；范围是本轮差异，纯格式文件采用等价性检查，不宣称未变更行的全文件安全审计。第三方技能、依赖、缓存、生成产物不纳入清理清单，锁文件只审依赖与版本变化。发现并修复新 Runner 缺缓存目录、Linux npm 启动路径、发布版本未拒绝降级、设置写入结果未确认、工作流触发器空值绕过检查等问题。graphify 更新为 5108 节点／9016 边；29 个 SQL 缺 tree_sitter_sql、14 个文件未提取符号，迁移和交付脚本另按源码审查。

首次 [Quality 42219241264](https://github.com/zhangheng2022/taskrelay/actions/runs/42219241264) 中 Windows 和 Ubuntu 均完成 397 项回归、无失败；Ubuntu 全源码统计为行 68.07%、分支 81.21%、函数 78.74%，据此将正式下限固定为 **68% / 81% / 78%**。此前 Windows 的临时函数门槛 79% 不适合作为 Ubuntu 基线。首次运行实际阻断了覆盖率门槛与 CodeQL SARIF 查询包规则解析不兼容的问题；已补解析和行为回归。依赖图、Dependabot 告警和安全更新现已启用，首次审查在初始化前返回不可用，等待新报告复验。

同次托管 Windows 作业完成浏览器资源校验、打包、包内与安装 smoke、系统快捷方式启动及安装/构建 ASAR 一致性检查，版本 0.17.1，ASAR 为 `f48ed81b2a14cba175ebcb92787d1e6564e178d08e4a2f2650ba9bf80be712b1`。这是 PR 验收包，尚未公开；正式发布会对合并提交重新构建并验收。首次 quality-gate 确实因必要检查失败而失败，未得到绿色汇总。

第二次检查中依赖审查和正式 Ubuntu 门槛通过；原始 CodeQL 报告发现四处历史脚本问题，虽然 GitHub 的 PR 差异界面未列出，quality-gate 仍阻断。已改为本地密钥文件排他创建、同一报告句柄核对新鲜度和正文、Access 精确主机校验，并用 Set 明确原本已精确匹配的目标地址列表；自检协议也改读当前合同。实际脚本入口测试覆盖已有密钥不变、并发初始化、伪造 Access 域名和当前协议。质量检查仅保留安装验收报告，完整安装包只在正式发布运行保存，减少重复附件占用。

GitHub production 环境仅允许 master，部署令牌已配置。PR #1 的 Quality 42220755457 全绿，双平台各登记 399 项测试、398 通过、1 项真实 Chromium 测试因普通测试 Runner 缺浏览器跳过；Ubuntu 行／分支／函数覆盖率 68.24%／81.22%／78.82%。Windows 安装验收作业现在在准备浏览器后显式补跑该状态迁移入口，不能只用包内 smoke 替代。已启用 master Ruleset 26694266：必须 PR、最新主分支上的 quality-gate、讨论解决、禁止强推和删除，无常规绕过者、额外审批人数为 0。PR #1 通过 merge commit 05677db 合并，保留格式提交。

合并后的完整 CodeQL 扫描 42221667335 又发现两项 High：模型地址尾部正则回溯和测试中的动态回调调用。PR 默认差异过滤未覆盖这两处既有问题，生产发布被阻止，尚未执行迁移或部署。改用线性尾部扫描、显式数字 ID／函数检查，并将 CodeQL 的差异过滤关闭，PR 也检验完整报告；实际模型入口长地址与 Chromium 状态往返 14 项定向测试通过。八类隔离负例之外，PR #2 的运行 42221726362 因故意格式错误导致 static／quality-gate 失败，Ruleset 显示 BLOCKED；已关闭 PR，坏文件未进入 master。补审本批 5 个文件及上下文（含测试和文档），无未解决发现；图更新 5118 节点／9036 边，29 个 SQL 缺解析依赖、2 个 PowerShell 文件未提取符号。

此时尚待修复后主分支完整 Quality 和 Actions 生产发布，后续完成记录见下文。本机更新通道升级及升级后 Microsoft 只读复验仍未完成：2026-11-06 本机界面核验因电脑工具无法可靠确定 Windows 浏览器地址被停止，未以命令行启动替代系统入口验收。下面历史 0.17.0 的五次验证不能算作 0.17.1 验收。

PR #3 的 42223411817 完整检查与安装验收通过，合并为 e262cff；两平台各 400 项（399 通过、1 项由 Windows 安装作业补跑），真实状态迁移 2/2。合并后 42224566612 再次在目标 Profile 首次 `Storage.clearCookies` 超时，未放宽超时或跳过测试；验收改为先通过自有 CDP 关闭源浏览器、确认进程退出，再启动独立目标环境，与生产单浏览器所有权一致。此时仅定位到失败命令，不能宣称已证明 Chromium 内部超时根因。安装影响范围补入执行器和浏览器测试路径，避免仅改测试时省略必要验收；实际脚本入口与 Chromium 定向 5/5，本批完整 Runner 结果待核验。

生产发布负例 42222593964 指定未通过主分支检查的提交，预检返回 `RELEASE_QUALITY_NOT_GREEN`，构建与 production 作业均跳过，未取得生产令牌或写入数据库。

串行浏览器夹具在 42225301067 仍复现相同命令超时，排除“两份浏览器同时运行”这一充分解释。随后通过实际 LocalCdp／CRI／WebSocket 入口延后发送完成回调，稳定复现已经收到回复仍超时：CRI 0.34.0 在发送回调中才登记请求，快速回复先到时会被丢弃。现有固定源码哈希补丁将登记提前，发送失败清理回调，不重发命令；隔离复现由失败转为通过，CDP 与真实 Chromium 7/7。托管 Runner 和新安装包仍需复验，不能将此隔离证据单独视为所有现场超时已消除。

42226283599 的隔离竞态和完整安全检查通过，Runner 浏览器仍在首次清理超时。夹具此前仅等 DevToolsActivePort，而生产 OwnedBrowser.launch 会确认默认上下文已接受 `Browser.setDownloadBehavior(deny)` 才交接；补齐同一就绪条件后继续复验。没有改生产超时、增加写操作重试或降低质量门槛。

PR #4 的 42226787711 与合并提交 c66de74 的 42227631295 全绿：两平台各登记 403 项、402 通过、普通测试缺浏览器的 1 项由 Windows 安装作业实际补跑，真实 Chromium 2/2。Ubuntu 行／分支／函数覆盖率 68.45%／81.27%／79.00%；托管 Windows 包内、实际安装、系统快捷方式和 ASAR 核验均通过，ASAR 为 `9b250d4b171c3fb3667c1204df14dedccb4560cc5aee7b2a91b3a367798ca5cc`。该包仍是质量验收产物。

正式发布 42228490917 两次只读预检均失败，未进入 production、未迁移或部署。Cloudflare 安全事件精确记录 13:49:00 UTC 的 `/api/health` 为 `managed_challenge`、来源 `botFight`、User-Agent `node`；本机主域健康及权限检查正常。发布健康／部署 SHA／下载核验改用已有同一 Worker 的 workers.dev 入口，主域防护和更新地址不变，错误只报告固定分类和状态码。仍需 Actions 真实发布复验。

PR #5 的 42229701345 再次在目标环境清 Cookie 超时，补充有界虚构浏览器诊断后，42230529991 显示源／目标程序均被 Windows LPAC 拒绝读取，随后网络服务崩溃重启；不能把此前两次通过视为已彻底消除该问题。本机按 [Chromium 官方权限要求](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/docs/design/sandbox.md#lpac-file-system-permissions) 只给浏览器程序树补充读取／执行后，权限错误和网络服务崩溃消失。Main 与真实状态夹具接入同一权限入口，增加路径、链接、失败拒绝以及无网络服务崩溃断言；保留浏览器隔离和原超时，Runner 新包待复验。

42231794443 的双平台功能回归、真实 Chromium 和托管实际安装通过，差异覆盖率 57/83 未达 80%，总门槛仍拒绝。补充真实发布脚本子进程入口，验证非主分支／健康异常在生产写入前失败，封闭全部网络、不含部署令牌；本机差异覆盖率升至 69/83（83.13%），未降低门槛。本机并行覆盖率回归曾在夹具等待源浏览器优雅退出时超时，补齐 Main 已有的自有进程树回收与退出确认流程，再开始目标环境；独立入口复验通过，新的完整 Actions 结果待核验。

42233373202 暴露旧并发夹具对三个请求先后顺序的假设；现在通过实际模型请求进入信号明确第一条已占有会话，再发送重复请求与后续指令。42235016749 双平台功能回归通过（407 项中 406 通过，普通测试缺浏览器的 1 项另由安装作业补跑），Ubuntu 分支／函数覆盖率 80.72%／77.74% 未达到 81%／78%，门槛继续拒绝。新增真实发布脚本的内存 SQLite 与封闭网络测试，覆盖安装包发布、错误哈希、无兼容设备、重复发布、旧报告、已公开产物恢复和部署结果未知；模拟报告不作为实际安装证据。本机完整测试另捕获 taskkill 因子进程已退出返回非零，夹具改为等待自有浏览器退出事件确认，未放宽生产安全约束。新增定向测试 4/4、类型和代码规则通过；新完整统计与 Actions 结果分别记录。

补齐上述入口后，本机完整 407/407 通过，Windows 全源码统计行／分支／函数为 70.01%／81.14%／79.67%，未降低 68%／81%／78% 下限。按原统计约定补排除 4 个只有声明的 `.d.mts` 文件；业务源码范围未缩小。OCR preview/rule 后宿主复审本批 6 个文件（含默认排除的测试与文档），reviewed_files=6、skipped_files=0、coverage_rate=100%，无未解决发现。图为 5137 节点／9093 边，29 个 SQL 仍缺解析器。Windows 统计不替代 Ubuntu 正式门槛，托管检查和生产发布尚待本提交通过。

PR #5 的 [Quality 42237134630](https://github.com/zhangheng2022/taskrelay/actions/runs/42237134630) 全绿，按 Ruleset 正常合并为 `41c916c`。两平台各 407 项、406 通过、1 项由 Windows 安装作业补跑，真实 Chromium 2/2；Ubuntu 行／分支／函数为 69.49%／81.00%／78.81%，差异行 73/80。托管实际安装、系统入口与 ASAR 核验通过。CodeQL 关于公开版本元数据组成固定下载路径的 Medium 讨论已核对来源、固定目标、无凭据和完整响应哈希后解决，未删除扫描规则或降低门槛。

合并提交 `41c916c133c449736afc92cd66203cff2d16cf83` 的 [Quality 42238251749](https://github.com/zhangheng2022/taskrelay/actions/runs/42238251749) 再次全绿；Ubuntu 行／分支／函数为 69.49%／81.02%／78.81%，双平台完整回归与托管安装验收通过。手动正式发布运行 42239257763 只接受此 SHA，预检已在同一 Worker 的机器入口成功，不再遭主域 Bot Fight 挑战。

首次 [Production release 42239257763](https://github.com/zhangheng2022/taskrelay/actions/runs/42239257763) 已全绿。正式 Windows 包通过真实 Chromium 2/2、包内 smoke、实际安装、系统入口及安装 ASAR 一致性核验；ASAR 为 `0b67b1d6f07fcf4b2fb272f94f98a88d5f92575e03ab194f0f3d823fc841a011`。在记录 D1 恢复点后执行 0028，部署 Worker `09848417-7a05-4d18-8dde-6be64eb360ab`（100%），公开 0.17.1、完整下载核验后切换更新目录；阶段 complete，领取 1、维护 0、无活动或未清理运行。主域与 workers.dev 的健康均为发布 SHA，更新目录均为 0.17.1，匿名用户／管理员入口均为 401。未执行本机更新或新一轮 Microsoft 验收。

公开资产核对发现 GitHub 将安装器空格转为点，已补固定公开名称的上传／恢复匹配及返回名称校验。真实脚本夹具包含原始磁盘名和已公开规范名，修复前 resume-published 失败，修复后通过；这是后续发布脚本修正，不替换已公开的 0.17.1 产物或重新部署云端。

## 2026-11-06 Web 图片改为受鉴权地址

Web Transport 提供同源图片地址，聊天缩略图和大图预览不再请求 `format=data` 或保存 Base64 字符串。加载完成后开放预览；加载／预览失败显示固定提示，地址切换重置状态，旧图片事件不能改写新图片。沿用既有二进制接口、会话鉴权、本人归属、过期与删除检查，不新增公开图片链接、数据库迁移或桌面更新。

类型检查、完整回归 381/381（含 UI 66 项）、Web 构建和仓库检查通过。新增／扩展生产组件与 Web Transport 回归覆盖直接地址、ID 编码、加载事件、预览错误、地址切换和旧事件；生产图片入口测试核验 PNG 字节、Content-Type、no-store、nosniff，既有多用户测试核验真实会话隔离。构建保留已有大分块提示。

OCR preview/rule 成功，宿主完整审阅本批 11 个文件，含默认排除的 4 个测试及 4 个文档；reviewed=11、skipped=0、coverage=100%，无未解决发现，未调用外部模型。graphify 更新为 4759 节点／8377 边；28 个 SQL 缺 tree_sitter_sql、3 个测试未提取符号，不计为完整解析覆盖。Wrangler 4.158.0 发布预检通过；官方命令网页读取失败，使用项目已安装 CLI 的 help 与现有配置核对命令。

本机浏览器夹具已观察到图片与预览入口，服务端记录到二进制图片请求；首次检查后续因 Windows 当前 URL 识别失败而中断。发布后重新在 Edge 的真实登录聊天核验：缩略图和大图的 src 均为 `/api/user/artifacts/snapshot_*`，实际图片解码成功（1264×649）；Enter 打开、Esc 关闭通过。390×844 下聊天宽度 390、对话框宽度 370.5 且左右留边，无横向溢出，大图正常显示；已恢复浏览器尺寸。窄屏大图一次检查工具等待超时，随后实际加载成功，未重发聊天或执行任务；不将该工具超时记为图片失败，也不声称固定加载时延。截图 `web-image-url.png`、`web-image-url-390.png` 保存于仓库外。未新增真实手机或浅色主题验证。

源码 `2f7ff5a` 已推送，生产 Worker `482bdbad-3ee5-4610-928e-6bdc4300c63c` 承接 100% 流量。发布前暂停领取并确认活动执行、待清理浏览器、待处理推理和聊天均为零；无新增 SQL，D1 保持 0027。主域及 workers.dev 的 health 均为 200，匿名本人／管理员／图片接口为 401，设备 Bearer 访问图片为 403；线上 `index-DgSawW-l.js` 与构建字节一致。已恢复领取，maintenance=0、设备协议 17、claim_ready=1，本机继续 0.17.0，无需更新安装包。上线后的实际登录图片显示与本轮布局检查见上段。

发布后的 CI 42206948805 在既有聊天刷新用例出现时序失败：通知回调不返回刷新 Promise，用例在订阅建立及错误结果落地前即进行断言。测试补充等待订阅和实际错误提示，保持失败、离线及恢复的原有断言；未改变生产行为。修正后类型检查、该文件 9/9 和完整回归 381/381 通过。OCR preview/rule 成功，宿主补审此默认排除的测试及本文，reviewed=2、skipped=0、coverage=100%，无未解决发现；graphify 节点／边保持不变，本次增量仍有 28 个 SQL 缺解析依赖、此测试未提取符号。此次仅测试与验收记录变更，无需再次发布生产或更新桌面。

## 2026-11-06 CDP 与运行版本核验（0.17.0，已部署、安装及五次真实复用验证）

发布安装：源码 0e40975，CI 42198300218 成功；Worker 29a285ee-3fc7-4f44-9e01-bc0a8918e76e，D1 0027。health=200，匿名用户／管理员接口=401。系统安装 0.17.0，从桌面 TaskRelay.lnk 启动的主进程位于 `C:\Users\96227\AppData\Local\TaskRelay\app-0.17.0\TaskRelay.exe`；安装／构建 ASAR SHA-256 同为 `830a760351b565c3ef4c64b6c49004514870c3457cfab4a0f40a850225c482ff`。包内与安装 smoke 均实际加载 Stagehand 4.4.0、CRI 0.34.0，并完成状态往返，release-manifest 通过。首次独立安装 smoke 受已有进程的单实例锁影响未生成新报告；退出空闲进程后重新运行成功，不采用旧报告。升级前后配置、Local State、26 个 Profile 目录保持一致，SQLite quick_check=ok、outbox／未完结 journal=0。已恢复领取；五次真实只读复用验证均已完成。

源码验证：完整回归 378/378（含 UI 64 项）、类型检查、仓库检查与 Web 构建通过。OCR preview/rule 成功，宿主完整审阅 19 个本批文件，含默认排除的测试、配置、文档和仅版本变化的锁文件；reviewed=19、skipped=0、coverage=100%，无未解决发现，未调用外部模型。图更新 4753 节点／8366 边；28 个 SQL 缺 tree_sitter_sql，一个 Vite 配置未提取符号，不计作完整解析覆盖。

两处生产 CDP 通信统一使用 CRI 0.34.0；SDK 管编号、响应和事件，Main 保留本机端点与进程退出权威。新增真实 SDK 的乱序配对、session 事件、断连、命令超时、HTTP／WS 重定向拒绝及握手超时测试。既有真实 Chromium 独立 Profile 分区 Cookie、HttpOnly、首读 Local Storage、空快照和同版缺失 Cookie 补齐通过。安装 smoke 与真实网站证据分别记录，不相互替代。

### 连续五次 Microsoft 登录状态复用

2026-11-06 10:00–10:28 UTC，在同一个验证聊天和同一台实际安装的 Windows 执行器上，依次发起五个独立只读任务。均使用已保存账号，未重新提供密码、未填写凭据、未发送催促结束消息、未领取或兑换。每轮实际页面均显示已登录并返回显示名及积分，随后自主结束。

| 轮次 | 环境                           | 运行 ID                                | Agent／Stagehand 模型请求 | 建立运行至终态（秒） | 发布后状态版本 |
| ---- | ------------------------------ | -------------------------------------- | ------------------------- | -------------------: | -------------: |
| 1    | 原 Profile 复用                | `run_e0e5d0ee47d0405485fb0b6f47cfdffb` | 4／2                      |              178.087 |              7 |
| 2    | 同一 Profile 复用              | `run_98844a7586724b56a4ac30a97e5e706b` | 4／2                      |              165.945 |              8 |
| 3    | 同一 Profile 复用              | `run_28e78dbf54ae44f1b07f7c61962ea7b1` | 4／2                      |              170.353 |              9 |
| 4    | 新 Profile 恢复云端版本 9      | `run_4a6b09ec99b14f7c8962e3715987c42b` | 5／2                      |              174.679 |             10 |
| 5    | 另一新 Profile 恢复云端版本 10 | `run_dab407bb2196407894d7a375115dc5f4` | 5／2                      |              152.201 |             11 |

前三轮复用 `profile_43adacfc-b18c-483e-af0e-e34d2ea2940c`。两次独立恢复前均暂停领取、确认前次关闭与清理、退出空闲 Main，备份并移除该账号的本地版本映射，再经桌面快捷方式启动；未删除原 Profile 或云端快照。第 4／5 轮分别新建 `profile_dbe70762-6436-4ea5-9cfa-5b359a9067eb`、`profile_7b5122c7-8b23-47d6-9949-1b36a2d1602e`，物理目录由 26 增至 28，确认不是复用原目录。第一次准备第 4 轮时发现在线删除映射后旧值仍在；未开始任务即改为退出 Main 后重做并核实映射缺失，不把未生效的准备记为独立环境。

五轮均为 `succeeded`，且分别等到 `cleanup_confirmed=1`、`cleanup_pending=0`、`write_pending=0`、账号锁释放及状态 `synced` 后才启动下一轮。最终凭据版本／失效版本仍为 1／1，状态版本 11，本地映射 `dirty=false`、outbox=0、未完结 journal=0；维护关闭、领取开启、设备协议 17 且 `claim_ready=1`。安全元数据保存于忽略目录 `.cache/release-0170/reuse-five-cloud-final.json` 和本地 Profile 映射备份，不含凭据或浏览器存储正文。

统计口径：每轮聊天记录均有 1 次 `navigate`、1 次 `extract`；启动阶段另有一次 `page.goto(entryUrl)`，因此仍存在额外导航，不能写成“总共只访问一次”或“零重复导航”。耗时包含排队，不含云端规划和终态之后的关闭确认。`ai_calls` 目前将决策与摘要统一记在 `execute_*`，上表只能核验 Agent 合计，无法可靠拆出摘要次数；此前两条验收记录中的“决策 N 次、摘要 0 次”不作为已核实的独立计数。每轮模型请求合计 6–7 次，较旧版有人工催促的单次基线 21 次少；样本条件不同，不推导普遍耗时改善。

本轮证明本机同 Profile 复用与两份独立 Profile 的真实云端恢复，以及五次无需催促的自动收尾。尚未完成两台物理设备、不同 IP、干净 Windows、登录真实失效后的协助和其他网站验证；不宣称跨设备无损迁移，也不将自动 smoke 的夹具网站当作这些场景通过。

## 2026-11-06 前端与接口类型迁移（0.16.0 包已构建，云端已部署，本机待安装）

Hono RPC 已覆盖用户／管理员客户端调用；Query 接管非敏感工作空间、账号摘要、设置和执行器状态；官方认证客户端与模型表单库接入，保留聊天与账号卡片原协议。新增取消、写入未知、请求合并、通知打断首次读取、用户缓存隔离、迟到响应、表单脏值与预算校验、Turnstile 和成员复核测试。完整回归 374/374（含 UI 64 项）、类型检查、仓库检查、Web 构建通过。Hono CLI Worker 包装入口报告 INVALID_APP；改为检查默认导出的真实 browserApi 路由组合成功，生产权限由既有入口测试核验。Edge 隔离模型表单检查桌面浅色／390×844 深色、滚动、预算错误、未知提交反馈及取消关闭通过；未新增真实手机／输入法验收。浏览器包 gzip 231.56 kB，存在既有 500 kB 分块提示。OCR preview/rule 成功，宿主审阅本批 41 个变更文件（含默认排除的测试与版本锁文件），覆盖 100%、无未解决发现。修复初次读取途中通知被合并及表单刷新覆盖／滞后两个边界，补回归；未调用外部审查模型。图更新至 4741 节点／8371 边；28 个 SQL 缺 tree_sitter_sql，初次解析曾报告 AuthGate 部分提取和一个无符号测试，类型检查通过，不能视为完整解析覆盖。无新增 SQL。源码 b7a0774 已推送，CI 42195350547 成功；云端 Worker 60f073b2-fb82-417c-a2f4-a32d392ed07b 已部署，D1 保持 0027。发布中遇到 Cloudflare 503／504，核对未生成新版本后重试成功；health 200，匿名本人／管理员接口 401。0.16.0 包内 smoke 通过，ASAR SHA-256 为 3c554e78f2d11440782ee9ce56ae69b663017ceac5a93f53cc4bbe890609eba3；报告的 Stagehand 版本字段仍为旧硬编码 4.3.0，实际依赖 4.4.0，待下一桌面批次修正为读取真实版本。用户按 Esc 中止界面控制，尚未执行系统安装；本机继续 0.15.0／协议 17，恢复领取，maintenance=0。0.16.0 实际安装、CRI 替换及最终连续五次真实登录复用验收尚未完成。

## 2026-11-06 官方模型 SDK 迁移（已部署验证）

Chat Completions／Responses 使用 OpenAI 7.52.0，maxRetries=0、logLevel=off；仍只从美国 ModelEgress alarm 发出请求。边界保留禁止重定向、60 秒完整请求超时、成功 2 MB／错误 64 KB 限制、固定错误分类和实际用量。标准 Zod 使用官方 helper，原始 Schema 校验及 JSON 兼容路径保留；收到无效响应才允许格式修复。新增标准／兼容 Responses、HTTP 限流／故障／断流不重试、正文超时取消、环境凭据隔离和原始网址校验回归。类型检查、完整 368/368、仓库检查、Web 构建通过。中途一次完整测试出现既有聊天刷新断言时序失败，定向 9/9 和最终完整回归通过，未把该现象当作网络功能已修复。OCR preview/rule 成功，宿主完整审阅 8 个本批文件（5 个源码／测试、3 个文档），覆盖 100%、无未解决发现；未调用外部审查模型。桌面协议／安装包不变。源码 a05ab00 部署 Worker e0cf3891-6cf0-4dc1-821b-30c673e49af1；新的只读运行 run_11a890055f9a4d19a7392d5ad8c574a4 于 08:52:10–08:54:18 UTC 自主结束（约 128 秒），4 次决策、2 次 Stagehand、0 次摘要、1 次导航、1 次读取。同设备登录复用，无额外密码或催促，cleanup_confirmed=1、cleanup_pending=0、write_pending=0、账号锁释放，状态 revision=6 synced。该单次样本不替代最终连续五次及两台物理设备验收。

## 2026-11-06 Agent 工具格式修复

0.15.0 首次生产只读验证 `run_8750655b86eb4e8c858c38bac1625c4c` 在第一轮决策返回 MODEL_HTTP_400，未执行浏览器工具；终态 failed、write_pending=0、cleanup_confirmed=1、cleanup_pending=0。已暂停领取排查。发现新 Zod 工具定义包含提供方不支持的 uri 格式，且空参数对象省略 required；Chat／Responses 现统一经过已有 wire Schema 投影，原始 Zod 与运行时校验保留。此项是已定位的兼容缺口，真实复验前不宣称它是该次 400 的唯一原因。完整测试 362/362、类型检查和 Web 构建通过。OCR preview/rule 成功，宿主完整审阅 3 个代码／测试变更和本条验收记录（4/4，100%），无未解决发现；生产复验待完成。

修复源码 `662d9a7` 部署 Worker `7b046e11-febd-4b73-ba16-83bf3cae60c2` 后，新运行 `run_0873308790594fa3848c539da7553570` 于 08:42:01–08:44:01 UTC 自主完成：同设备 Profile 免登录，导航 1 次、读取 1 次，决策 3 次、Stagehand 模型 2 次、摘要 0 次，总耗时约 120 秒。未填写凭据、未执行业务操作、未追加催促；终态 succeeded、cleanup_confirmed=1、cleanup_pending=0、write_pending=0、账号锁 0，快照版本 5／synced。主域 health 200、匿名接口 401，领取恢复。相比此前同设备有引导基线（导航 3 次、模型 21 次、摘要 16 次）明显减少调用；单次样本不替代全部批次结束后的 5 次连续验证或两台物理设备验证。

## 2026-11-06 官方 Agent 与摘要迁移（0.15.0，已部署安装）

源码切换 createAgent v2、p-limit(1) 与官方摘要，删除云端二次摘要和自写分块合并；11 个执行工具统一 Zod 定义。协议 17、图版本 relay-graph-3 使旧执行器不能领取新任务、旧 checkpoint 不能跨版本恢复；不改账号、Profile、快照或 MASTER_KEY，无新增数据库结构迁移。覆盖多工具串行、协助冻结、空回复一次纠正、结束期间新指令、摘要失败及租约失效保留历史、原文保护和未知结果不重放。类型检查、完整回归 360/360（含 UI 58 项）、仓库检查与 Web 构建通过；正式包及实际系统安装 smoke 通过；源码 `976f4ef` 已推送，Worker `038a3ad6-814b-4450-9d3f-369ba004653d` 已部署，D1 保持 0027。通过资源管理器双击桌面 TaskRelay 快捷方式，确认启动系统 `app-0.15.0\TaskRelay.exe`；安装与构建 ASAR SHA-256 同为 `ed9fdfd48a4f3bb39bf1d4b5ba2bec1295129cb005475bf0eca196ff051812b5`。26 个 Profile、配置与 Local State 均未改变，本机 outbox／未完结 journal 为 0；设备协议 17、claim_ready=1，维护关闭、领取恢复。主域 health 200、匿名用户／管理员接口 401。真实网站效率尚待验证。OCR preview/rule 成功，宿主完整审阅 32 个本批变更文件（含测试、文档和仅版本变化的锁文件），覆盖率 100%，无未解决发现；未调用 OCR 外部模型。源码图更新至 4688 节点／8047 边；28 个 SQL 仍缺 tree_sitter_sql，两个测试文件未提取符号，不能算作完整解析覆盖。

## 2026-11-06 全仓依赖升级基线（0.14.0，已部署安装）

直接及开发依赖已按本轮 registry 发布版本锁定：Stagehand 4.4.0、LangChain Core 1.3.5、LangGraph 1.7.1、Electron 45.2.3、Better Auth 1.7.18、TypeScript 7.0.2；新增后续重构所需的官方 Agent、模型 SDK、查询、表单及 CDP 依赖，本批保留原执行循环。Cloudflare 的 Miniflare 和已有 Hono CLI 分别跟随 beta、next 通道。GitHub Actions 的 checkout v7.0.1、setup-node v7.1.0 已是核对时的最新 release，继续固定其 SHA。

隔离目录重新解析依赖后，`npm ci`、类型检查、完整回归 **353/353**、Web 构建和仓库检查通过。未使用 force 或 legacy-peer-deps。新版 Node 类型下的网络测试显式区分字符串与 Buffer；未改变网络执行行为。构建资源和发布清单改为读取桌面清单中的 Stagehand 版本，重新准备时清理已核对路径的生成资源，避免新旧扩展混用。

已配置 Dependabot 每周一 Asia/Shanghai 09:00 检查 npm 和 GitHub Actions，更新 PR 分组且不自动合并或部署。上游仍固定的间接旧版本不强制覆盖。本批包内及系统实际安装 smoke 已通过，生产领取已恢复；真实网站效率复验留待官方 Agent 批次。

Windows 0.14.0 重新打包及本次包内 smoke 已通过（Electron 45.2.3、Chrome 157.0.8103.38、Stagehand 4.4.0）。首次升级 smoke 暴露旧 Profile 继续执行旧扩展代码，修复为按 SDK release 固定公开扩展身份并在启动时仅启用本版扩展；同一旧测试 Profile 的连接及完整 smoke 随后通过。未修改 MASTER_KEY 或删除账号 Profile。新增生产依赖锁文件，普通打包改为 `npm ci` 并清理已核对路径的暂存目录；修复后类型检查、Host 21/21 通过。实际系统安装路径为 `C:\Users\96227\AppData\Local\TaskRelay\app-0.14.0\TaskRelay.exe`，安装与构建 ASAR SHA-256 均为 `c5a3a16cc04493cfd4a1ae25ce891ac9983ce23bd7cc5961b04119b0d9fae293`；26 个 Profile、原配置与 Local State 保留，SQLite quick_check 通过，outbox 与未完结 journal 均为 0。通过 Explorer 启动安装器及实际版本程序，尚未单独完成桌面快捷方式点击验证。生产 Worker `32a8bb89-39a1-4ae6-b2a3-e8adcc4ef7dd` 已部署，D1 保持 0027，`maintenance=0`、`claimsEnabled=1`、设备就绪；本批未验证真实网站。

OCR preview/rule 成功；23 个变更文件中 21 个完整审阅、2 个生成锁文件不逐行人工审查，覆盖率 91.3%；两个锁文件已核验 registry 来源、完整性字段及安装／构建／包内 smoke。无未解决发现，未调用 OCR 外部模型。graphify 已更新，28 个 SQL 仍缺少 tree_sitter_sql 解析器，相关行为以源码及测试证据为准。

## 2026-11-06 账号管理、登录状态与串行账号组（0.13.0）

### 用户确认后的真实登录状态复用

用户自行确认保存 Microsoft 账号，生产卡片为 saved，账号凭据状态为 valid、云端快照为 synced，初始状态版本为 1。未从已删除聊天恢复凭据，未代替用户点击保存。

第一轮 `run_1b284aea97c64e738f8a3c8c4311def0` 使用已保存账号进入新的独立浏览器环境：运行前没有该账号的本地版本标记；Main 从云端快照恢复，生成与首次临时登录目录不同的物理 Profile。任务仅打开 Microsoft Rewards 页面并读取一次，真实页面显示已登录并返回显示名和积分。动作登记数为 0，未填写凭据、点击登录、领取或兑换，也未新增保存卡片。运行 succeeded 后先观察到 cleanup_pending=1／cleanup_confirmed=0、账号版本仍为 1；浏览器退出和关闭确认完成后变为 0／1，账号版本推进到 2、同步成功、账号锁为 0。本机 ownedBrowser=null、outbox=0、journal=finished，账号本地标记 revision=2、dirty=false。

第二轮 `run_662d36578b93400a8d0ea2fb2dc3917d` 在同一聊天使用同一账号，Main 本地标记确认复用第一轮的同一物理 Profile。启动时真实截图已经显示登录后的仪表盘，积分与上一轮一致；这证明同设备登录状态复用。执行器随后重复导航三次，需要在原聊天补充“依据本轮已有观察结束”，之后返回已登录的最终回复并 succeeded，因此不将本轮记为完全无人干预或一次观察后自动收尾通过。三个导航登记均为 observed，write_pending=0、may_have_written=0；未进行登录或业务操作，两轮新增保存卡片数为 0。

第二轮清理完成后，云端状态版本推进到 3、synced 且无同步错误；两轮均 cleanup_pending=0、cleanup_confirmed=1，账号锁为 0。本机 ownedBrowser=null、outbox=0、journal=finished，账号标记 revision=3、dirty=false；设备 claim_ready=1，领取保持开启。

这两轮证明同一台实际安装 Windows 执行器可在新的独立环境中恢复真实 Microsoft 登录状态，并在后续任务复用完整本地环境；尚不能代替两台物理设备、不同 IP／设备风控、其他网站、真实失效后协助及连续观察验收，不宣称所有浏览器状态无损迁移。安全元数据证据保存在忽略目录 `.cache/release-0130/reuse-before.json`、`reuse-cloud-running.json`、`reuse-cloud-closed.json`、`reuse-local-running.json`、`reuse-local-closed.json` 和 `reuse-cloud-final.json`，不包含密码、Cookie 或 Token。最终聊天截图为 `microsoft-reuse-result.png`。本轮仅更新验收／部署文档，事实与差异检查通过；未改代码、未重新运行源码测试或部署。

### 四项账号界面补充

根据后续反馈，卡片与账号编辑框统一为“账号名称、域名、账号、密码”，摘要密码固定遮蔽，业务网站、业务域名和关联登录地址不再作为用户填写项。未修改域名时保留原协议、端口及内部登录关联；新域名默认 HTTPS，修改域名则重置旧关联，服务端权限和版本校验不变。修复清空域名时编辑表单消失的问题。

类型检查、UI 58/58、完整回归 353/353 与 Web 构建通过。实际 Edge 隔离 Transport 检查浅色 390×844、深色 1280×900；卡片分别为 348×162／448×162，无横向溢出，编辑框仅四项、高度 582，密码默认遮蔽，Enter 打开及 Esc 关闭通过。此阶段未操作生产保存按钮；后续用户确认及真实复用见上节。本次无新增 SQL 迁移、桌面协议或安装包变更。

OCR preview/rule 成功，宿主审阅全部 9 个变更文件，补审测试与文档，9 reviewed、0 skipped、覆盖率 100%；未调用外部模型，无未解决发现。graphify 为 4605 节点／8026 边，28 个 SQL 缺少解析依赖、8 个不支持类型文件未分类，沿用直接源码审查边界。

源码 `2f852684342c3074dc0725658a530efd5fd6e3d5` 已推送，[Windows／Ubuntu Node 24 CI](https://github.com/zhangheng2022/taskrelay/actions/runs/42167538597) 均通过。生产 Worker `3cd368fb-b697-4b8a-914e-448afd0f2fca` 100% 生效，两域健康及权限自检通过，恢复领取 1／维护 0。实际线上入口引用 `index-CQPf5LzX.js`，原验证聊天只有一张卡片、一个保存按钮，四项标签与遮蔽密码均已核对；未提交账号确认。

账号、精确业务域名、关联登录 origin、凭据版本、登录状态和优先设备已接到现有账号管理。原聊天的保存／修改卡片采用独立加密草稿和本人确认，当前等待绑定运行、版本与消息游标；重复确认、字段修改、晚确认和聊天关闭均有生产路由回归。普通设置修改只影响下一次领取，同次修改卡片可更新有效等待；新消息不会被旧卡片覆盖。

状态同步使用 Main 内部 CDP adapter 与独立 SQLite DO，保留分区 Cookie 和页面首次脚本读取前的 Local Storage；超过 2 MB 或不透明 Cookie 分区会跳过同步并显示固定原因，不截断或降为普通 Cookie。同版本本地环境保留完整 Profile；跨设备恢复云端可迁移部分。未确认清理及 unknown 保持账号保护，旧候选不得跨失效代次或后续分配重新发布。多账号组固定顺序、一次投递一个成员，普通失败可继续、协助等待、unknown 暂停、停止取消未开始成员。

本机两个独立 Chromium Profile 通过正式状态适配器完成导出／恢复验证：两个不同分区的同名 Cookie、HttpOnly、持久 Cookie 补齐但不覆盖本地新值、Local Storage 首次读取，以及空状态删除。实际 workerd SQLite DO 完成 1.1 MB 三块加密往返、不可变上传、发布引用保护和退休回收。账号与调度测试经过正式 Hono、execute、ExecutorHost、Poller 入口；本地 SQLite 适配不能代替线上 D1 并发或两台真实执行器。

完整回归 **347/347**、UI **55/55**、类型检查、Web 构建、仓库与差异检查通过。新增回归覆盖关闭发布故障后保留锁、新执行领取后拒绝旧发布、转正时更新本地版本、停止期间迟到启动、加密暂存和固定同步错误分类。Web 构建仍有大于 500 kB 的既有分包提示，未因此改依赖或拆分无关页面。

共享 UI 使用虚构账号完成 1280×900／390×844、浅色／深色浏览器检查；账号编辑、卡片密码遮蔽、滚动和 Esc 关闭通过，详见 UI-REVIEW。Windows 0.13.0 从已提交源码重新打包，包内及实际安装 smoke 通过，最新报告为 `out/packaged-smoke.json`、`out/installed-smoke.json`。构建与系统安装 ASAR SHA-256 均为 `44d2eb7226fc4ff84acbe5b8eb979abecaca6106cce60deaeb74087bca395922`，本次安装器 SHA-256 为 `eb50e0572091931093c4c50212bf81019d1052c51919e964755662e7c571ee3f`。smoke 使用隔离用户目录与虚构页面，不调用真实账号，也不证明完整云端调度。

OCR preview/rule 成功，宿主及委托子代理复审本轮 **71 个变更文件，71 reviewed、0 skipped、覆盖率 100%**，补审默认排除的 22 个测试、文档与锁文件；生成类型只核对生成来源和本次差异，不将本轮检查称为全仓审计。发现的卡片并发确认、SSO 来源、旧会话回退、状态发布交接、停止与恢复问题均已修复并回归。清单在忽略目录 `.cache/account-ocr-review-final.json`。graphify 更新为 **4600 节点、8001 边**；27 个 SQL 缺少 tree_sitter_sql 未解析，admin-panel.tsx 被解析器局部标记错误（TypeScript 检查通过），两个测试未提取符号，8 个非支持类型文件未分类；相关变更已直接审阅，不把图覆盖作为源码完整验证。

源码 `cabdee8d9f8866ec42cd9def67e5647c359e7155` 已推送，Windows / Ubuntu Node 24 [CI](https://github.com/zhangheng2022/taskrelay/actions/runs/42156660872) 均通过。生产 D1 0024–0026、新 SQLite DO 与 Worker `96067a0d-ddc1-4398-8cc0-35b44de57881` 已部署，两个域名健康与权限自检通过。部署自检脚本的期望协议号同步为 16。

已由 Windows Explorer 启动安装器并通过系统桌面快捷方式打开 0.13.0，进程及安装 smoke 位于 `C:/Users/96227/AppData/Local/TaskRelay/app-0.13.0/`；通过系统目录 UNC 路径独立核对 ASAR，避免将 Codex MSIX LocalCache 副本当作安装证据。升级前后 24 个 Profile、设备配置和 Local State 哈希一致，SQLite quick_check 为 ok，outbox 与未完成 journal 均为 0。云端确认该设备协议 16、claim_ready=1；已恢复领取与非维护状态。MASTER_KEY 未重新生成或覆盖。

原 Microsoft 聊天已清理，本轮未从已删除历史恢复凭据。用户在新验证聊天重新提供后，真实安装的 0.13.0 完成 Microsoft 登录及只读检查；运行 succeeded、cleanup_confirmed=1，并生成候选快照。未领取、兑换或提交业务操作。首次登录阶段曾发现三张重复保存卡片，当时用户尚未确认保存；后续去重修复及用户确认后的复用见本节补充记录。干净 Windows、两台设备及连续观察仍待验收，不宣称跨设备免登录成功或完全无损迁移。

### 2026-11-06 账号卡片紧凑化与重复提示修复

默认卡片改为摘要和小按钮，完整表单通过“修改信息”展开；关联登录地址仍在确认前显示。服务端使用身份 HMAC 和 D1 唯一索引，在请求标识、名称、说明或域名顺序变化时复用卡片；旧的重复待确认草稿惰性归并，旧确认返回冲突且不再创建账号。不同用户名、密码或域名范围保持独立。

完整回归 **352/352**（含 UI **57** 项）、类型检查、仓库检查与 Web 构建通过。Hono CLI 通过忽略目录中仅重导出命名 app 的入口成功枚举生产路由。新增回归覆盖并发生成、确认后再次提示、旧重复卡片归并及确认拒绝、不同凭据隔离、紧凑卡片直接保存与编辑收起。测试使用 SQLite 适配，不替代真实 D1 并发。

实际 Edge 隔离 Transport 检查：1280×900 下卡片为 448×172，390×844 下为 348×172，无横向溢出；浅色和深色可读，默认不挂载密码输入框，编辑框在视口内滚动，Esc 可关闭。截图位于忽略目录 `.cache/release-0130/compact-card-390.png`。未执行真实手机 Safari 或真实输入法复验。此次仅修改云端和网站卡片，不改变协议 16 或本机执行器 0.13.0，无需重新覆盖安装包。

OCR preview/rule 成功，宿主审阅全部 13 个变更文件（补审默认排除的两个测试和五份文档），13 reviewed、0 skipped、覆盖率 100%，无未解决发现；未调用外部审查模型。graphify 更新成功，为 4604 节点／8030 边，28 个 SQL 因缺少 tree_sitter_sql 未解析，8 个不支持类型文件未分类；新迁移已直接审阅，不把图覆盖当作数据库验证。

源码 `94b5c98` 已推送，[Windows／Ubuntu Node 24 CI](https://github.com/zhangheng2022/taskrelay/actions/runs/42161856795) 均通过。生产先迁移 0027，后部署 Worker `487b9e41-dc31-4e55-9bb5-7b4b31f4849a`，两域健康和权限检查通过，领取恢复。实际原聊天三张 pending 归并为一张 pending、两张 expired/superseded，UI 只显示一张高度 172 px 的卡片；未代替用户点击确认。真实首次登录已结束，系统 SQLite 显示 ownedBrowser=null、outbox=0、运行 journal=finished，未发生重复业务执行。此阶段的账号确认尚未完成，后续结果见“用户确认后的真实登录状态复用”。

## 2026-11-05 聊天滚动与 iPhone Loading 兼容

旧代码在 24 条隔离历史消息中可复现发送确认后 scrollTop 从 1338 变成 0：MessageScroller 在等数量节点替换时，将尚未处理的第一条历史用户行选为 turn anchor。修复改为官方底部跟随和明确的本地发送滚动入口；没有手写滚动高度、定时强制定位或依赖升级。发送、推理和执行状态复用一个状态行，关闭该行的 content-visibility:auto，旋转应用于普通 HTML 元素；离线或读取失败显示真实的状态更新问题。

真实 Edge 修复后发送确认保持底部（scrollTop 1364，scrollHeight 2086，clientHeight 722），上翻后模拟最终回复前后均为 642；状态离屏并返回后旋转矩阵继续变化。390×844 下上翻后主动发送，距底部为 0；已恢复视口。该证据来自实际共享 Conversation 和隔离 Transport，不调用真实模型/业务。iPhone Safari 真机、后台切前台及减少动态效果的实机行为尚未验收；WebKit 301745 为兼容处理依据，不是本机复现证据。

完整 **278/278**、UI **43/43**、类型检查、Web 构建、仓库及差异检查通过。新增回归验证消息确认时状态/动画节点复用、无历史 turn anchor、离线/读取失败提示及恢复终态；JSDOM 不模拟真实布局和动画，滚动证据来自上述浏览器验证。OCR preview/rule 成功，宿主完整检查 9 个变更文件（含默认排除的测试与文档），9 reviewed、0 skipped、覆盖率 100%，无未解决问题。graphify 为 4457 节点、7249 边；23 个 SQL 因缺少 tree_sitter_sql 未解析，一个测试未提取符号，已直接检查本次源码。

源码 `1777a1daca056d55a68f61733157c1141e9d81f2` 已推送，[Windows / Ubuntu Node 24 CI](https://github.com/zhangheng2022/taskrelay/actions/runs/42048420697) 全通过。发布直连两次因连接重置失败，沿用系统已配置代理后 Worker 与网站上传成功；CLI 在 Cron 阶段仍报 fetch failed，不能记为整条 CLI 成功。Cloudflare API 独立确认版本 `24ce3fa3-484b-4eb3-a06a-cf8312860257` 为 100% 活动版本，Cron 仍为 `* * * * *`。主域健康及权限自检通过，线上 JS/CSS 与构建 SHA-256 分别一致（`12cb0ef6b54f82ab314551e916aaacaf39b7708da3807bcc048d8e9ced94b546`、`9b4a3b9778853199819a9a0c8616a7b440ab7544a1726278a83faecce764c261`）；备用 workers.dev 域名本机直连和代理重试均遇连接重置，本轮未完成该域名复检。发布前活动运行 0；不涉及数据库迁移或桌面更新，桌面仍为 0.12.5。

## 2026-11-05 网站发送即时反馈

修复点击发送后聊天要等 POST 返回才新增记录，以及通知在发送或刷新途中被忽略、只能等轮询补偿的问题。发送原文和状态只保存在内存，成功以服务端消息替换，失败恢复输入并保留原 requestId；读取交错时合并通知并补读，不新增自动重发。

完整测试 **276/276**、UI 测试 **41/41**、类型检查、Web 构建与仓库检查通过。新增实际共享组件回归覆盖延迟 POST、失败重试身份保持、通知与读写交错及发送后立即读取最终回复。真实 Edge 隔离慢网络夹具在 390×844 下验证发送提示在响应前可见，返回后消息不重复；未执行新的真实模型或业务任务，不代表全主题、真实手机或输入法验收。桌面执行器仍使用已安装的 0.12.5，本轮不涉及桌面运行代码或数据库结构。

OCR preview/rule 已执行，宿主审查本轮 9 个变更文件（含补审默认排除的测试与文档），9 reviewed、0 skipped、覆盖率 100%，未发现未解决问题。graphify 更新为 4452 节点、7242 边；23 个 SQL 缺少 tree_sitter_sql 未解析，部分测试未提取符号，已直接检查变更源码。

源码 `3fa4d7161ac9df3b1322fd747ccb093a7bb29c66` 已推送，[Windows / Ubuntu Node 24 CI](https://github.com/zhangheng2022/taskrelay/actions/runs/42043115163) 全部通过。已部署版本 `198a7751-901d-4ef6-a17e-357f1a5e65c6`，两个域名健康与权限自检通过，主域新脚本与本地构建 SHA-256 一致（`e60b63f2e99128ba84dfe3517996489650e1f1263fe5da7e3652486133e9f9eb`）。发布前后活动运行均为 0；未更改生产数据、迁移结构或桌面安装。部署证据补充仅修改文档，已检查差异。

## 2026-11-05 消息防重与按需截图（0.12.5）

协助只发布云端确认需要用户回答的问题，内部求助、内部答复及固定收件回执不再重复展示。过程消息使用稳定事件身份，前端按运行合并 Trace，保留每次真实调用；相同文案的新一轮更正不被吞掉。截图改为首次打开、协助轮次、新错误现场、最终结果和明确请求触发，普通 act/observe/extract/navigate 不自动截图，脱敏后相同图片复用；Stagehand 视觉输入独立。业务进度条不再误标为页面加载，重复读到相同结果的事实交给 AI 判断，不增设动作或时间限制。

完整 **273/273 项测试通过**，类型检查、Web 构建、仓库检查和差异检查通过。实际 execute 回归验证八次 extract 仍有八份独立反馈、首尾仅两次捕获且同图仅上传一次；同一协助轮询只捕获一次，内部直接解决不捕获，普通填写/点击不捕获，重复错误按现场抑制。生产路由集成模拟 messages/snapshots/finish 响应丢失重传，问题、过程、图片和结果均不重复；新旧桌面截图能力兼容、提前回复加密及更正仍通过。上传后消息发布失败的边界有独立回归。

OCR preview/rule 已执行，宿主逐项审查全部 25 个变更文件（补审默认排除的测试、锁文件及文档），25 reviewed、0 skipped、覆盖率 100%。修复审查中发现的“上传未发布仍被当作已有聊天图片”问题。图更新为 4450 节点、7230 边；23 个 SQL 因缺少 tree_sitter_sql 未解析，4 个测试文件没有提取符号，已直接审查源码。Hono CLI 直接加载命名 app 导出报 INVALID_APP；接口验证使用现有生产 app.request 集成测试，不将该 CLI 命令称为通过。

源码提交 `9ba3d511e6819ead7839c00fac073cc5b472f513` 已推送，[Windows / Ubuntu Node 24 CI](https://github.com/zhangheng2022/taskrelay/actions/runs/42036882734) 均通过；单独 UI 测试 38/38 通过。云端版本为 `f6f7a752-5348-4899-b1c8-57508a94c080`，主域及 workers.dev 健康与权限检查通过。生产 D1 最新迁移仍为 `0022_checkpoint_chunks.sql`，本轮无结构迁移；领取 1、维护 0、historyEpoch 4，发布前后活动运行均为 0。

实际 Edge 原聊天显示一个执行过程区域，计数为 19 次调用（act 6 / observe 5 / extract 8），展开保留全部八次读取明细。390×844 视口下仍可访问过程、计数和输入控件，Enter 可折叠过程，完成后恢复默认视口；没有读取或复制原聊天的密码内容。该项是历史 UI 验证，不是新版浏览器业务执行。真实手机、全主题布局和输入法未另作完整验收。

从干净源码构建 0.12.5，经系统 Explorer 安装并从实际桌面快捷方式重新启动；系统进程路径为 `C:/Users/96227/AppData/Local/TaskRelay/app-0.12.5/TaskRelay.exe`，界面显示 0.12.5、在线等待任务。包内和实际安装 smoke 均通过，安装报告生成于北京时间 **21:38:30**。安装与构建 ASAR SHA-256 均为 `e2a51203db5312b64cee08bbe8aedba86e906d978918933905435f32b13dc021`；安装器 SHA-256 为 `5a98db9986e3fc733f7d186b6b0725682e00ff794bff696c0089a66cc6ab7acb`。release-manifest 的 sourceDirty=false、installedAsarMatches=true；物理系统路径经只读映射核验，未把 Codex 重定向副本当作系统安装。

配置、Local State 哈希及 24 个 Profile 目录列表安装前后一致，SQLite quick_check=ok，outbox 与未完成 journal 为 0。未发布 GitHub Release 或切换自动更新目录。测试网站和模型为隔离夹具，smoke 不替代实际 execute / ExecutorHost 全调度验证；本轮没有再次运行 Microsoft 积分任务，不能保证 AI 在任何网站都不会重复读取。干净 Windows、真实验证码及连续无人干预业务仍未验收。

## 2026-11-05 真实登录、积分读取与提前回复修复（0.12.4）

0.12.3 的真实运行 `run_a30f9c11b59d4b74a336a217c990bd7b` 已接受用户在原聊天分次提供的 Microsoft 账号与密码，完成填写、提交及登录，选择“不保持登录”，进入 Rewards 页面。本轮没有触发验证码，不能将隔离验证码回归写成真实验证码验证。结束余额为 **5,931**、可领取 **0**、本轮确认新增 **0 分**；每日活动 3/3、必应搜索 1/1、Edge 30/30 是页面已有状态，移动应用签到 0/1 无法在当前网页完成。没有兑换、消费、购买或创建后续任务。

执行器反复读取相同积分状态，未自主及时收尾；在原聊天补充“停止重复读取，按现有证据结束本轮”后已正常回传最终回复。本轮验证真实登录与运行中补充，但不宣称无人干预积分领取闭环通过。重复读取效率仍需后续优化，未添加动作次数或执行时长硬上限。

现场发现密码在云端尚未置 `awaiting_user=1` 时已回复，旧入口按普通补充保存，导致该条正文与一次工具反馈未进入预期的加密/脱敏路径。0.12.4 改为执行中补充一律加密，并将回复绑定当前未完成协助；执行器先登记来源再补截图，问题由云端统一发布。新增历史维护在运行终态后分批加密遗留正文和助手复述、脱敏工具回显，保留本人原文与任务授权，不轮换 MASTER_KEY。

完整 **264/264 项测试通过**，类型检查、Web 构建、仓库和差异检查通过；新增回归覆盖首次协助推理中提前回复、登记前补充、旧协助不重新绑定，以及历史维护的活动运行等待、终态加密、工具回显清理、本人原文与重入。

修复提交 `66896fa` 已推送，[Windows / Ubuntu CI](https://github.com/zhangheng2022/taskrelay/actions/runs/42029417169) 全部通过。云端部署版本为 `d2a34447-8339-4a73-b478-232f18352963`，两域名健康与权限边界自检通过。本次没有 SQL 结构迁移。生产历史维护已将现场提前回复正文加密、对应工具回显替换为隐藏标记，遗留未加密运行补充为 0，修复标记为 done；只查询加密标记与统计核验，没有将密码复制到修复脚本、日志或文档。运行已终态，活动运行数量为 0。

OCR preview/rule 成功执行，宿主审查全部 14 个变更文件（含默认排除的测试、锁文件和文档），14 reviewed、0 skipped、覆盖率 100%。关系图更新为 4440 节点、7185 边；23 个 SQL 文件仍因缺少 tree_sitter_sql 未解析。

从干净提交 `66896fa` 构建 0.12.4，经系统 Explorer 安装，再从实际桌面 `TaskRelay.lnk` 启动；进程为系统 `app-0.12.4/TaskRelay.exe`，界面显示 0.12.4、在线等待任务。包内与真实系统安装 smoke 均通过，安装报告生成于北京时间 **20:48:22**。构建、安装及报告 ASAR SHA-256 一致：`1bdc1b5bc9160eb7f747097506cb773389931c2c2204cad97f28c696c6e59979`；安装器 SHA-256 为 `f41c8eebf3c1b17f686f92c337cae495ceea4b91dd6575159229836027712241`。本次发布清单 `sourceDirty=false`、`installedAsarMatches=true`，安装路径通过只读映射核验为真实系统目录。

安装前后配置与 Local State 哈希、24 个 Profile 目录列表均一致，SQLite quick_check 为 ok，outbox 与未完成 journal 为 0。没有发布 GitHub Release 或切换自动更新目录，也没有再次执行真实积分任务；0.12.4 的提前回复竞态由生产入口隔离回归和线上数据修复核验，实际账号密码登录来自上述 0.12.3 现场运行。干净 Windows、真实验证码与连续无人干预运行仍未验收。

## 2026-11-05 原聊天登录协助（0.12.3 / 协议 15）

0.12.2 微软积分现场运行 `run_5edb9fa8021e4941b1f6044664b06628` 已到达 Microsoft 登录页并进入待协助，但两层 AI 要求用户在不可见的任务浏览器中自行登录，实际无法照做。用户确认改用原聊天输入账号、密码及验证码，允许过程明文；该运行已取消，尚未取得积分余额或领取积分。

0.12.3 明确两层 AI 的浏览器能力边界：按登录页所缺信息在原输入框求助，接受一次或分次回复及纠正，不要求固定格式，不虚构人工接管窗口。保留原文交付、来源与设备校验、本人明文回显及底层加密；没有新增可见浏览器或修改凭据存储方式。无可用入口的扫码/人工验证仍可能受阻。

完整 **261/261 项测试通过**，类型检查、Web 构建、仓库与差异检查通过。新增生产接口隔离回归覆盖账号密码同发、分次输入、错误密码更正、验证码前导零、Stagehand 接收完整原文、当前登录来源绑定、本人回显与密文存储；取消、租约过期和聊天关闭后，已送达回复不能继续调用模型恢复旧协助。提供方与网页为虚构夹具，此证据不代表真实 Microsoft 登录或积分到账。

生产代码提交 `3eb40fb` 已推送并部署，云端版本为 `7e87f574-96fc-497d-9915-8cca49e2b39a`；主域与 workers.dev 的健康及权限边界自检通过。本次没有数据库结构变更，不新增生产迁移，也未修改 MASTER_KEY、注册或领取开关。首次远程 Windows CI 暴露聊天刷新测试在订阅 effect 建立前模拟通知的问题；`bed0765` 仅修正测试等待条件，生产代码与安装包不变。[后续 CI](https://github.com/zhangheng2022/taskrelay/actions/runs/42025264851) 的 Windows / Ubuntu 均通过完整 261 项测试、类型检查、Web 构建与仓库检查。

安装包从干净提交 `3eb40fb` 构建，经系统 Explorer 安装；结束空闲进程后，从实际桌面 `TaskRelay.lnk` 再次启动，系统进程路径为 `C:/Users/96227/AppData/Local/TaskRelay/app-0.12.3/TaskRelay.exe`，界面显示 0.12.3、在线等待任务。安装前后配置、Local State 哈希和 24 个 Profile 目录列表一致，SQLite quick_check 为 ok，outbox 与未完成 journal 均为 0。

本次包内与真实系统安装 smoke 均通过，后者于北京时间 **20:14:59** 由系统 Explorer 启动独立自检入口生成。两份报告与物理安装 ASAR 的 SHA-256 均为 `69594af51b930e5df665d6f7192e72a7cc1e0d9dc9fcb279381055b3f86ba5e5`；安装器 SHA-256 为 `38cd6a7280151d26b1f9af2353c2df673978d398f70b71315102edcef4782d78`。发布清单在仅含测试修正的 `bed0765` 生成，`sourceDirty=false`、`installedAsarMatches=true`，安装路径经只读映射核验为系统物理目录。没有发布 GitHub Release 或切换自动更新目录。

OCR preview/rule 成功执行，宿主补审默认排除的测试和锁文件；本轮代码与文档差异共 11 个文件全部 reviewed、0 skipped、覆盖率 100%，无遗留发现。关系图为 4434 节点、7163 边，23 个 SQL 文件仍因缺少 tree_sitter_sql 未解析。本轮独立 smoke 不等同于真实网站完成；干净 Windows、休眠断网与连续观察仍未验证。

实际安装后，在原任务聊天重新交办，生成 `run_a30f9c11b59d4b74a336a217c990bd7b`，已由系统安装的执行器打开 Microsoft 登录页。执行器与云端助手均明确请求用户在本聊天提供 Microsoft 邮箱/手机号，并说明后续按页面需要请求密码或验证码；没有再要求用户操作不可见浏览器。协助记录已进入 `awaiting_user=1`，尚无回复。这证明真实网站的登录求助入口已纠正；尚待用户提供账号，不能宣称真实登录、验证码恢复或积分领取完成。

## 2026-11-05 生产迁移、云端部署与 Windows 安装（0.12.2 / 协议 15）

已按本次授权推送 `master` 至 `05789de81dc377510536249a45abac4705f24254`，从该干净提交重新构建。本提交 [远程 CI](https://github.com/zhangheng2022/taskrelay/actions/runs/42019037637) 的 Ubuntu / Windows、Node 24 均通过，含完整 256 项测试、类型检查、Web 构建、仓库及差异检查。下方两节“尚未部署/安装”描述的是先前源码修复阶段，本节记录后续交付。

生产维护前确认没有排队/执行/等待中的运行或待处理交办，记录 D1 Time Travel bookmark；临时关闭领取并开启维护。北京时间 **19:28:08** 应用 `0021_context_withdrawal.sql` 与 `0022_checkpoint_chunks.sql`，新增分块表、证据退休表及索引已核对，外键检查无异常。本次生产库没有历史已撤回消息，原有两条终态运行保留；没有清空任务历史、轮换 MASTER_KEY 或更改注册设置。

云端/Web 于北京时间 **19:28:40** 部署版本 `ad3876af-4ada-4a2c-891f-f08eb55d5232`，接收 100% 流量。主域名 `https://tr.zhangheng.eu.org` 与原 workers.dev 域名均通过健康、协议 15、匿名拒绝、设备/管理权限边界自检。线上 JS/CSS 与本次构建逐字节哈希一致；仍有已记录的主 JS 大分块提示。美国 ModelEgress alarm、现有六个 SQLite DO 与无 R2 配置保留。

`npm run make` 与本次包内 smoke 通过，生成 `apps/desktop/out/make/squirrel.windows/x64/TaskRelay Setup.exe`，安装器 SHA-256 为 `2367e6ee3c91fdb4010acb6160ee8ea98e204e83aa4b3ed862b22c1a23b6da02`。首先识别到 Codex MSIX 安装重定向，随后通过系统文件资源管理器执行同一安装包。关闭空闲的重定向副本后，从实际桌面 `TaskRelay.lnk` 启动；快捷方式目标为系统安装根目录 `TaskRelay.exe`，实际进程为 `C:/Users/96227/AppData/Local/TaskRelay/app-0.12.2/TaskRelay.exe`，界面显示 **0.12.2**。

安装前备份系统 userData 中的 SQLite 和 Local State。升级后配置哈希、Local State 哈希、23 个 Profile 目录列表均一致；SQLite quick_check 为 ok，未完成 journal 和 outbox 均为 0。该检查证明目录和配置保留，未重新逐站验证登录。自启动与暂停领取偏好没有调整。

直接从 Codex 以 UNC 路径启动安装 smoke 时发生 Electron GPU 子进程启动错误，未生成新报告；未将该尝试计为通过。随后从系统 Explorer 启动同一安装程序的 smoke 入口，使用独立 userData，生成北京时间 **19:39:39** 的新报告并通过。覆盖 Stagehand 4.3.0 原生导入、sharp 脱敏、自建站操作、LangChain 工具消息及 LangGraph interrupt/resume。

`out/packaged-smoke.json`、`out/installed-smoke.json` 与 `out/release-manifest.json` 均为本次新报告。构建、真实系统安装及两份 smoke 的 ASAR SHA-256 一致：`29b98cfb520fba6877c0c532700e1303b7c46015d283b309d8d2b1d6e29d9b17`。清单检查仅通过仓库忽略目录中的读取适配器，将已知安装路径映射到系统物理 UNC 路径，避免 Codex 再次读取 LocalCache；未修改 smoke 报告或清单校验逻辑。`sourceDirty=false`，`installedAsarMatches=true`，`installedAsarPath` 明确为系统 `app-0.12.2/resources/app.asar` 的 UNC 路径。

安装验证后恢复 `claimsEnabled=1`、`maintenance=0`，保留 `historyEpoch=4`，协议 15 的已授权设备持续心跳。实际系统窗口复核显示“在线，等待任务”，维护提示消失，版本为 0.12.2。部署日志、迁移恢复点、本地备份及安装入口证据仅保存在忽略目录，未提交或公开。没有发布 GitHub Release，也没有切换自动更新目录。

本次没有执行真实模型/业务网站完整任务、干净 Windows 安装、锁屏/休眠/断网或连续观察。独立 smoke 不调用生产 `runtime.execute()` / `ExecutorHost`，不能替代完整调度、租约和真实业务闭环；源码生产入口回归与远程 CI 也不等于这些现场验证。

## 2026-11-05 架构审查确认问题修复（0.12.2 源码 / 协议 15）

先以 `9cbdd0f` 提交本地已有的 51 个文件改动，再修复本次审查确认的九项生产缺陷和两项验证工具问题。保留现有云端规划、桌面执行和美国模型出站架构，没有推送或部署。

| 已修复问题                    | 当前行为与回归                                                                                                               |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 凭据加前后缀绕过来源校验      | 完整已知值双向匹配，实际使用值继承来源；混合多站凭据不能互相放行，同站正常使用保持可用                                       |
| 截图跨文本节点漏脱敏          | 执行进程拼接行内文本并遮蔽全部命中节点；秘密、命中结果与坐标不回传网页                                                       |
| 撤回内容再次进入模型          | 撤回独立于加密；过滤正文及 parts、助手派生消息和旧运行迟到回复，停用旧任务/运行/图；新交办只读取过滤后的上下文，本人历史保留 |
| 子进程启动失败卡住执行器      | 无 child 时仍统一持久化失败、回传并释放占用；收尾失败可重试，领取重试不重启失败运行                                          |
| 删除聊天后旧命令仍排队        | INSERT 原子核对命令、原聊天和任务版本，拒绝过期交接和改挂新聊天                                                              |
| 同图并发上传误删成功图片      | 每次上传独占对象，唯一索引发布；D1 退休墓碑阻止迟到发布，提交结果未知不贸然删图                                              |
| 大检查点超出 D1 单值/单行容量 | 加密后分块，与索引事务保存/读取；覆盖旧格式、完整原文、pending writes 幂等、回滚、并发替换和删除级联                         |
| 刷新/发送重置历史分页游标     | 两种游标保留已加载边界，旧历史响应不覆盖新窗口缺口；覆盖不同返回顺序与读到底                                                 |
| 旧 WebSocket 回调泄漏新连接   | Web Transport 统一订阅所有权，隐藏/离线/退订释放资源，旧连接事件不能操作新连接                                               |

开发夹具改用实际 `modelId/taskId` 合同，真实 App 回归验证历史、协助及结果显示。Node 与 workerd 性能脚本适配 HTTP 202 异步提交并核验持久终态；Node 明确调用生产 dispatcher，workerd 使用真实 DO alarm。两套脚本全部场景通过，仍使用合成提供方，不代表线上 CPU 计费或真实模型延迟。

最终完整 **256/256 项测试通过**（含 UI 与实际 execute/Host 生产入口）；类型检查、Web 构建、仓库结构和差异检查通过。本地 workerd 回归通过异步图、协助 interrupt/resume、重复请求、多块证据、超过 2 MB 的加密检查点、级联清理、暂存图片发布/孤儿回收/重复 alarm、通知与撤销。新增 `0021`、`0022` 仅在隔离数据库验证；旧库升级测试使用实际 `0001..0020` schema，并检查外键与旧撤回图的清理。

桌面版本 **0.12.2** 与锁文件同步。`npm run package` 及本次包内 smoke 通过，报告 `out/architecture-fix-packaged-smoke.json`，ASAR SHA-256 为 `29b98cfb520fba6877c0c532700e1303b7c46015d283b309d8d2b1d6e29d9b17`；覆盖原生 Stagehand 4.3.0、sharp 脱敏、自建站操作和图暂停恢复。没有生成安装器或替换实际系统安装。

OCR 委托的 preview/rule 已成功执行，宿主审查全部 40 个修复文件的完整差异（含默认排除的测试与锁文件），40 reviewed、0 skipped、覆盖率 100%；生成物、依赖目录、缓存和复现报告不在提交范围。复审发现的检查点替换、分页缺口、截图延迟发布与撤回派生上下文问题均已补回归修复。源码图更新为 4427 节点、7146 边；缺 `tree_sitter_sql`，23 个 SQL 文件仍未进入关系图，迁移以源码审查和实际执行测试为准。

Web 主 JS 为 594.99 kB（gzip 186.85 kB），仍有大分块及混合导入提示；未将本轮定点修复宣称为全站性能优化。未执行远程 D1 迁移、云端部署、真实模型/业务网站、实际手机/Electron 布局、干净 Windows 或连续观察；包内独立 smoke 与 SQLite 交错测试仍不能替代这些验证。已经发出的模型请求或浏览器动作无法通过撤回追溯取消。

## 2026-11-05 全仓审查问题修复（0.12.1 源码 / 协议 15）

本轮修复 OCR 委托审查确认的五项问题，保留先前为 33 个主要模块添加的中文职责注释：

- 截图不再将秘密传入网页；控件/媒体固定遮蔽后，敏感文本与邮箱在执行器内匹配并对 PNG 像素涂色。恶意页面覆写原型的回归验证无法读到其他站点凭据，同时敏感文字像素已遮蔽、普通文字区域保留；截图失败仍清除临时覆盖层。
- CONNECT 在等待 DNS 前安装客户端错误监听；真实本地 TCP 重置回归不触发未捕获异常，也不继续连接目标。
- 聊天刷新不清除未确认发送的 requestId；已启动交办的后端重试仍匹配原 inbox，避免重复追加补充。已入队但未提升的请求重试仍可继续处理。
- 清空会话同步释放旧写入标志；实际共享 Conversation 组件回归验证旧请求结束后，新会话能正常发送。
- 配对申请先按入口来源哈希进行每十分钟 5 次的 D1 原子限流，再检查共享名额。隔离 API 回归验证同一来源并发 20 次仅 5 次成功，其他来源仍能配对，正常轮询与窗口过期后恢复不受影响。

完整 **215 项测试通过**；类型检查、Web 构建、仓库检查及差异检查通过。Hono CLI 经仅导出真实 app 的临时入口确认配对路由。Web 构建仍有大分块提示。源码图更新为 4395 节点、7036 边；仍缺 SQL 解析依赖，21 个迁移文件未入图，另有 4 个代码文件未提取符号，不代表这些文件未测试或未审查。

桌面版本提升至 **0.12.1**，锁文件同步；sharp 0.35.5 成为桌面运行依赖，平台模块与 DLL 解包至 `app.asar.unpacked`。`npm run package` 与本次包内 smoke 通过，实际打包 utilityProcess 完成原生 Stagehand 4.3.0、sharp 截图处理、自建站操作及图暂停恢复；报告为 `out/review-fix-packaged-smoke.json`，打包目录 `apps/desktop/out/TaskRelay-win32-x64`，ASAR SHA-256 为 `a14dd57437bbd0a54ba8592707377139747c6df1428112b0c5b4bab1d2ce385a`。

本轮没有生成安装器、替换系统安装、部署云端或发布更新；没有新的真实模型/业务网站、干净 Windows 或连续观察验证。包内独立 smoke 仍不代替完整 `runtime.execute` / Host 故障验收；生产入口的隔离源码测试不等于真实 D1 并发和设备闭环通过。

## 2026-11-05 云端粗步骤与 LangChain / LangGraph（0.12.0 / 协议 15）

一次切换至新的云端规划图、协助图和桌面执行图，没有并行保留旧手写工具循环。粗步骤作为 `executionOutline` 进入任务版本，桌面根据原话、补充和真实页面执行单步操作。标准 LangChain 消息与工具接口经 RelayChatModel 连接原有美国 alarm 出站；Stagehand 仍固定 4.3.0。

完整 **209 项测试通过**，包含 UI、实际 execute/Host、云端规划与协助生产接口；类型检查、Web 构建、仓库检查及 diff 检查通过。专项覆盖等待恢复不重复副作用、超过 40 次动作、停止与 unknown、用户原话不压缩、首次求助期间新补充自动唤醒、最终截图及收尾请求期间用户纠正、租约/generation/聊天删除的原子写入保护、协助结果与聊天事务回滚。源码图已更新，仍缺 `tree_sitter_sql`，21 个 SQL 文件未解析；不能据此声称数据库关系图完整。Web 构建仍提示大分块。

`0020_graph_orchestration.sql` 已应用生产 D1；云端/Web 最新部署版本 `e15c198a-968f-430a-a368-c4ee994923e3`（含 Worker 异步上下文修复）。前次部署的生产健康和匿名/Bearer 归属检查通过。设备已升级协议 15，注册保持关闭，个人次数限制保持关闭，领取恢复为 1、维护恢复为 0。未更改 MASTER_KEY 或增加模型直连。

Windows 0.12.0 make、包内 smoke、实际系统目录安装 smoke、release-manifest 均通过。实际桌面快捷方式指向系统 `AppData/Local/TaskRelay/TaskRelay.exe`，启动进程为 `app-0.12.0/TaskRelay.exe`；实际安装与构建 ASAR SHA-256 一致，为 `d09ce5aadff134d73f1bb8a2b77a5a01cb29f15118864318fa346d4b9b7dc1f8`。报告位于 `out/packaged-smoke.json`、`out/installed-smoke.json`、`out/release-manifest.json`；这是未提交源码构建，不是公开更新发布。包内 smoke 验证原生 Stagehand、自建站操作、LangGraph 工具消息及一次 interrupt/resume，不等于真实模型完整任务。

### 已授权旧历史重置

维护窗口确认无活动运行，先关闭聊天及图写入，再清任务派生记录。线上任务/运行/图片原为 0，本轮删除 1 个空聊天及 947 条旧额度预留；清理后任务、运行、聊天、图状态均为 0。Evidence 目录 130 个对象均无存储数据标记。用户 1、模型 2、设备 1、账号 0、认证数据、偏好及独立用量表逐项比较保持一致，historyEpoch 更新为 4。后续新建的验收任务属于本轮新记录，不属于旧历史残留。

本地当前两处 userData、开发 D1 与旧数据库备份共 12 库完成任务历史清理，共清除 63 条旧 journal；两处当前库 historyEpoch=4，旧 claimRequest 移除，配置和登录 Profile 保留。3 份混合 SQL 备份只移除 1620 条任务历史 INSERT，保留 schema、账号、模型、设备、用量及偏好语句并比较哈希。Codex 重定向库完整性正常；系统库及 5 份旧备份在清理前后均报告 config 自动索引异常。系统库重复键为 historyEpoch（值不同）与 paused（值相同），没有据此选择新偏好或改写凭据。

随后先在旧备份验证，再受控重建系统库 config：historyEpoch 按本次授权统一为 4，相同 paused 值去重，7 行恢复为 5 个唯一键。非 historyEpoch 配置与所有其他表哈希一致，数据库版本不变，系统库 quick_check 恢复正常。其他旧备份的不同配置未擅自选值或去重。

**文件清理未完成**：49 张旧任务截图和 7 份任务导出保留。批量删除及缩小到单个任务文件的删除均被自动审批拒绝，仅返回 `blocked by policy`；没有换工具绕过，不能声称全部本地历史文件已擦除。系统安装/设置截图、源码、运行依赖、浏览器 Profile 未纳入删除。

### 真实模型虚构站验收

首轮 `run_1bf4858e28c548a9b895db4f35d3d9db`：云端生成三条粗步骤并入聊天，系统安装的桌面打开页面并回传截图，云端发布协助问题；进入等待节点时报 `AI_GRAPH_FAILED`。没有填写或点击，验收站次数仍为 1，不能记为完整闭环通过。定位到 Worker 条件导出未自动初始化 LangChain AsyncLocalStorage，Node 测试的自动初始化掩盖了差异。`node scripts/test-free-runtime.mjs` 使用实际 workerd、ProductionAiTurn alarm 与加密 D1 checkpoint，在修复前复现同一错误；显式初始化后验证询问 → 持久等待 → 原文回复恢复 → 完成，同时多块证据及 WebSocket 撤销检查通过。209 项 Node 测试再次通过。

修复已部署，第二次真实复验创建 `run_e6d671db68664904aab178f50225a2be`；用户通过物理 Escape 停止电脑操作，随后已对本次验收运行发出取消，不继续控制电脑。因此本轮真实模型的完整浏览器闭环仍未确认，不能将 workerd 隔离回归替代现场通过。

干净 Windows、真实业务站点、多提供方、锁屏/休眠/断网及连续观察不由上述测试覆盖。

## 2026-11-05 Stagehand 规则对齐（0.11.1 源码与打包验证）

依据官方 v4 AI rules，并核对本地 4.3.0 类型和实现：补充单步 act 指引，明确 observe 仅返回候选、空结果不代表完成，执行历史保留 data/metadata，导航错误不再显示为已打开。初始化返回后重新检查停止；打包自测在异常时也关闭 Stagehand，并校验提取值。SDK browser.close() 会发送 Browser.close，生产 Chromium 继续由 Main/Host 回收，未改为执行器直接关闭。

新增回归在修正前复现初始化停止后仍导航、空候选提示不准确、导航错误仍显示已打开、工具元数据丢失四项问题。修正后完整 173 项测试（含实际 execute、Host 故障和模型转发入口）、类型检查、仓库检查及差异格式检查通过。源码图已更新；tree_sitter_sql 仍缺失，20 个 SQL 文件未纳入图。

0.11.1 Windows 打包与本次独立 Stagehand smoke 通过；报告为 `out/packaged-smoke.json`，产物为 `apps/desktop/out/TaskRelay-win32-x64/TaskRelay.exe`，ASAR SHA-256 为 `5388b9854bb35fc375dc1e9da1fcf94c9f6d41e657769b6c96915c5e7f5aa169`。测试使用无界面浏览器、自建页面和隔离模型回调，验证原生导入、observe/act/extract、密码填写与截图脱敏；不证明生产 execute/Host 的真实模型闭环。未安装、发布或部署，未控制用户桌面；干净 Windows、真实模型、真实网站及连续观察均未执行。

## 2026-11-05 冗余与历史清理

本轮源码修改尚未部署、打包或安装。移除旧界面和一次性切换入口，收敛到当前聊天交接与生产收尾入口。完整 168 项测试（含 UI 与生产接口）、类型检查及额外未使用声明检查、Web 构建、仓库结构检查通过；文档相对链接已核对。源码图已更新，但缺少 tree_sitter_sql，20 个 SQL 文件未进入图，不能把图当作完整数据库关系证明。Web 构建保留 500 kB 分块与混合静态/动态导入提示。未执行本轮桌面打包、安装、真实模型/网站与连续观察；用户要求不控制电脑，实际界面检查未执行。

用户明确授权同时删除线上和本地任务、聊天、运行与图片历史。线上清理前暂停领取并确认无活动运行；先关闭聊天，再经现有 Evidence 清理图片，最后清理任务及派生记录。删除前任务 13、聊天 13、运行 34、图片索引 102；完成后均为 0，账号锁 0，用户 1、站点账号 0、模型 2、设备 1 保留。领取恢复原值 1、维护恢复原值 0，MASTER_KEY 未变。此操作包含已授权删除的 4 条历史 unknown，不是一般恢复流程的解锁方法。

本机两处执行器 SQLite 的 journal/outbox 已清空：系统数据目录删除 55 条 journal，Codex 重定向副本原为 0；config 比较一致。开发 D1 删除 3 个旧演示任务与 3 条运行，模型、账号、设备和设置比较一致。本地任务浏览器目录与缓存截图删除被自动审批策略阻止，32 个 Profile、项目缓存内截图及历史缓存文件尚存；未清空整个项目缓存。不能将数据库已清空写成全部本地文件已擦除。

线上旧 R2 taskrelay-evidence 桶列表为空。Evidence 对象目录的存储标记存在延迟，最后一个仍标有数据的对象经 SQL 查询已无存储表。

用户随后授权直接卸载本地应用。已运行登记的 Update.exe --uninstall -s，退出码 0；卸载登记消失，无 TaskRelay 进程，系统与 Codex 重定向安装根目录均出现 .dead 标记。卸载器未删除系统 app-0.11.0 目录、部分安装缓存和 Roaming 用户数据；对剩余安装目录的删除再次被自动审批拒绝，原因仅返回 blocked by policy。不能报告为应用文件与历史文件已全部移除。

以下现场证据是清理前的记录，线上聊天和截图现已删除，不再提供在线复查入口。

## 0.11.0 原始聊天与原生工具调用（2026-11-05）

完整测试 165 项通过（包含 UI 与生产接口测试）、类型检查、Web 构建及仓库检查通过。覆盖两层模型原文、原生 Chat/Responses 工具与直接答复、运行中纠正/停止、凭据来源及数字下拉选项误拦回归。删除两项旧分类/截取测试，增加实际执行回归。源码图已更新。0.11.0 包内 smoke 已通过：真实 Stagehand observe/act/extract、原生密码框填写及脱敏截图；使用确定性模型回调。云端/Web 已部署，实际系统目录安装 smoke、桌面进程路径及安装哈希核对通过，release-manifest 通过；云端领取已恢复，个人次数限制仍关闭。部署后真实模型验收进行中，不以这些测试代替微软登录或积分完成。

### 0.11.0 真实模型聊天协助

- 用户从桌面启动的实际 0.11.0 接收协议 14 运行 `run_21c91a8a129547c0b132bfaa007afa8b`，聊天 `thread_8313d9bfebf946d79d57ade78c28e442`。
- 首轮云端误把测试码当成启动前提；补充“先打开页面，执行时再询问”后交接。因此该例不能记作首条明确交办直接启动通过。微软复验交办则直接创建运行。
- 原聊天收到测试码询问；自然语言“先不要提交、先核对虚构页面”被理解为要求，未误填。后续整句确认码原文进入执行器和 Stagehand，原生两次 fill、一次 click 完成提交。独立验收库 assist 计数 2→3，没有重复提交。
- 执行器直接总结并附图，运行终态 succeeded、outcome=reported、write_pending=0；刷新后聊天与图片完整。截图当时仅作为本机验收产物，不提交仓库。
- 微软运行 `run_e34b07bfb27e421c97b80cba0267d907` 已由新版启动，但历史摘要发生大量碎片请求，超过本机单次请求 180 秒后返回 OFFLINE；运行 failed、write_pending=0，未进行填写/提交。已修正摘要独立请求窗口（不重复扣除该请求未携带的原文/当前页面），并在摘要回合前检查停止/租约。生产入口回归先复现 50 次碎片请求，再验证不超过 6 次且原文/页面完整；完整 167 项测试、类型检查、仓库检查和源码图更新通过。仅云端修复，桌面安装包不变，真实微软复验待完成。

### 0.11.0 后续微软复验与摘要字段清理

- `run_cee63bbc51fa4f31b779f1b69107943c` 原生 Stagehand fill 已把聊天中的邮箱写入微软输入框；下一模型请求约 20 秒后连接中断为 OFFLINE，未点击登录提交，write_pending=0。不能与前一次 180 秒摘要超时混为同一原因。本机独立请求 Cloudflare API 复现 ECONNRESET，但工作空间健康请求成功；云端错误日志订阅也因连接重置未能建立，尚不能确定该次连接中断的全部原因。
- `run_75ef2a34a67b417b958dce1ba27d86cf` 在历史摘要结构化输出阶段报 MODEL_INVALID_JSON，未操作页面。源码发现摘要提示固定允许 1200 字，而动态 maxLength 可能只有几十字；具体供应商正文为加密记录，本轮未解密验证其实际违规细节。已移除字段 maxLength，使用一致的建议长度，超过窗口时按真实预算继续合并，原始输入不改写。
- 新增生产入口回归：长摘要不因建议字数直接拒绝、继续合并后仍保留原文。完整 168 项测试通过，真实微软流程继续复验，尚未确认登录或领取成功。

- 后续 `run_11414576cdeb491193fd88ff9656dd76` 已真实完成账号填写、账号提交、选择密码、复用原聊天密码填写、密码提交，以及选择不保持登录。六个动作全部 observed、write_pending=0；最终截图已进入 Microsoft Rewards 仪表盘，可用积分 5,842，证明登录成功，不证明积分领取成功。随后下一模型回合在历史摘要期间再次 OFFLINE，运行 failed；此次六个摘要调用均已完成，但尚未进入最终执行模型调用，不能将中断归因于密码填写或微软拒绝登录。该记录证明当时登录成功。
- `run_62dd8ab2d59d4a79a27d9200fed76920` 复用同一 Profile 直接进入已登录仪表盘，真实模型读取到三项可领取奖励；没有填写或点击动作。因大页面反复摘要耗时，通过停止按钮取消，确认 cancelled、write_pending=0、actions=0 后发布云端窗口分块优化。此次日志订阅未得到可定位 OFFLINE 根因的异常，不能宣称网络中断已修复。
- 摘要分块改按编码后的消息大小计算（包括 JSON 转义），避免 ASCII 页面结构只用少量窗口。新增实际 `/model` 入口回归；169 项完整测试、类型检查、仓库检查、Web 构建、源码图更新及生产健康/权限检查通过。源码图仍缺 SQL 解析器。安装包不变，微软领取复验继续。

### 0.11.0 微软实际领取及聊天收尾（已完成，有引导）

- 部署 `ca0a873e-f57a-42aa-a77b-0112a53ef1e3` 后，运行 `run_9263d98207324f23ba83c1e704544fc8` 复用已登录会话。首轮摘要为 5 个请求；运行持续超过五分钟，没有被旧业务时限终止。没有改模型配置或个人次数限制。
- 原生 Stagehand 完成四次实际 click：展开领取入口、领取 3 分、打开“巴黎温馨魅力”、打开“印度尼西亚群岛”。四个动作均 observed、write_pending=0，没有重复领取或重复打开两个活动。页面最终显示余额 5,865（基线 5,842，增加 23 分）、待领取 0、每日活动 2/3；两项活动均已完成。邀请类活动、手机签到及购买/兑换/订阅/抽奖未操作。
- 最终执行器直接生成原聊天报告，终态 succeeded、outcome=reported，云端没有另起报告模型。关联 22 张持久截图；刷新后聊天和结果保留。上述为清理前现场记录。
- **不能认定无人引导的完整自主执行通过。** 此轮共 11 次 observe、5 次 extract，存在重复观察；验收人员在原聊天补充实际点击、剩余活动及直接收尾要求后才完成。运行中补充被采用，但模型推进与自动收尾效率仍有缺陷。较早运行的 OFFLINE 根因未完全定位，后续成功不能证明已消除偶发断线。
- 最终 claimsEnabled=1、maintenance=0，个人次数限制 daily_quota_paused=1、无自动恢复时间。安装仍为已核对通过的系统目录 0.11.0；本轮未做干净 Windows、长期连续观察或新的窄屏/输入法专项验收。

## 早期验证与尚待补齐

早期版本的完整安装、发布、故障注入和模型地区记录保留在 Git 历史及 CHANGELOG，不作为当前流程的操作指南。旧阶段通过也不自动覆盖现有源码。

- 干净 Windows 安装/卸载/升级，真实运行中更新阻断，锁屏、休眠、断网恢复及跨日/七天连续观察仍需独立验收。
- 更多模型和提供方的真实浏览器闭环仍待补齐；Responses 能力测试不能代表 Chat Completions 与所有模型均已通过。
- 独立 smoke 不调用 runtime.execute 或 ExecutorHost；生产入口隔离测试、JSDOM 和 SQLite stand-in 分别不替代真实设备流程、布局滚动和 D1 并发。
- 自主推进和自动收尾效率、偶发 OFFLINE 的完整原因仍未解决；不能把有引导完成写成无人值守通过。

## 2026-11-05 聊天清理交付

- 新增删除单聊、清空当前、一键清理全部，服务端持久捕获范围、取消执行、分批回收，账号/模型/设备保留。回归覆盖重复请求、跨用户、清理期间新建聊天、发送中清空、图片失败重试、密文/检查点/运行模型缓存清理、迟到 finish 的 unknown 与账号锁保护、旧 DELETE 兼容、线程创建撞上清空的旧草稿保护。
- `npm test` 287/287、`npm run test:ui` 45/45、类型检查、仓库检查和 Web 构建通过；构建仍有既有大 chunk 提示。测试使用生产 Hono 路由和 SQLite D1 adapter；Hono CLI 因默认导出为 Worker 对象返回 INVALID_APP，未把失败算作 CLI 通过。
- Edge 本机隔离页面通过桌面清空与 390×844 窄屏全部清理，确认框默认取消、任务暂停、返回新任务和可输入均已观察；无生产聊天删除、实际 iPhone Safari、独立 Windows 安装或真实模型业务复验。本次不改桌面执行协议或安装包。
- OCR 委托仅执行确定性 preview/rule，由宿主审查完整差异，补审默认排除的测试与文档，并核对 SQL；审查中发现并修复旧草稿回填竞争。本次 27 个变更文件全部已审，reviewed_files=27、skipped_files=0、coverage_rate=100%；无未解决审查发现。隔离本地 D1 的 0001–0023 迁移全部通过。源码图更新为 4475 节点/7347 边；24 个 SQL 文件缺 tree_sitter_sql，另有 2 个测试文件未提取符号，不能算图覆盖。

- 生产源码 `f96ca08` 已推送；0023 迁移通过，Worker 版本 `dedc1df5-7075-4974-a86a-a096b023e04c` 已 100% 生效。主域健康、匿名/设备令牌权限边界、新清理接口匿名 401 通过；线上 `/assets/index-CnQih4ue.js` 与本地构建 SHA-256 相同：`c647996a0a17417125bfc1d8ebc3f12345fdddaa80637fa1a0cb970f25e6b75f`。
- 发布前活动运行/推理为 0；发布后任务 3、聊天 4、模型配置 2、设备 1、账号 0，未创建生产清理作业、未删除真实聊天。`maintenance=0`、`claimsEnabled=1` 已恢复，Cron 保持每分钟。生产后台删除闭环未用真实数据执行，仍以生产入口隔离回归和本地 D1 迁移证据为界。

- 源码提交的 [GitHub Actions CI](https://github.com/zhangheng2022/taskrelay/actions/runs/42057489609) 已完成，Ubuntu/Windows Node 24 的类型检查、完整测试、Web 构建、仓库及差异检查均成功。
