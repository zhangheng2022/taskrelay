# TaskRelay 验收记录

## 2026-11-04 第二批 Windows 更新交付验收（进行中）

- 首批修复及记录已提交 `08eb9b8`；0.4.9 候选 `4d06c40` 从干净源码构建，已推送 master。make、packaged smoke、类型检查、11 项更新相关测试、仓库检查通过；候选不能直接视为自动更新通过。
- 0.4.8 原生窗口关闭后主进程仍存活，MainWindowHandle=0；通过系统 Explorer 执行实际桌面 `TaskRelay.lnk` 后唤回同一系统进程。最初自动化截图错误，显式 Raise 恢复后才取证，未把错误截图记为通过。
- 安装前从物理系统 Roaming 保存 SQLite 一致备份、Local State 和 profiles 到忽略目录 `.cache/acceptance-049/private-backup/`；不输出或上传敏感内容。schema=3、historyEpoch=3、outbox/unfinished=0。暂时开启暂停领取和登录启动，供升级保留验证，验收后须恢复原偏好。
- 系统 Explorer 运行本次 Setup，0.4.8 → 0.4.9 跨版本安装完成，Main PID 从 20476 变为 30764，进程路径为系统 `AppData/Local/TaskRelay/app-0.4.9/TaskRelay.exe`；构建/系统 ASAR 均为 `62c70c9afe16a94426bc577f6ddd72ecf9cec7e2cf6ead734a8a6a66613d0ae9`。暂停领取保留。
- 现场发现登录启动显示错误：注册表中本应用条目仍为稳定 `TaskRelay/TaskRelay.exe`，系统批准未禁用，但 0.4.9 窗口显示关闭。Electron 45.2.1 隔离原生探针证实同一路径仅大小写不同即可使 openAtLogin=false，而 launchItems 与 executableWillLaunchAtLogin 仍正确为开启；不能只凭 openAtLogin 作系统启动状态。原生源码依据：[Electron Windows 登录项实现](https://github.com/electron/electron/blob/v45.2.1/shell/browser/browser_win.cc)。
- 修复接入 Main 的正式 `loginSettings`，按本用户、本应用、无额外参数的 launchItems.enabled 读状态，保护系统禁用偏好与已有稳定入口。新增 4 项生产模块回归；版本提升 0.4.10，不用同版本包替换已安装 0.4.9。最终安装、原生复验和发布候选证据待补充。

## 2026-11-04 第一批业务闭环验收（已完成：本机与虚构站范围）

- 结论：修复后人工信息与批准、拒绝取消、提交后进程中断与只读核查、一次性与周期真实调度均通过。旧 unknown 的失败核查和修复前失败如实保留，不能把本轮完成扩展为全量预览版发布验收。
- 本轮范围：人工信息与批准/拒绝、提交后中断与只读核查、真实定时触发。用户明确允许直接修复发现的问题；日启动额度经本轮确认从 5 临时调至 12，结束已恢复 5。模型/平台预算、Free 套餐、注册开关不变。
- 开始时为干净提交 `3781eda`，系统快捷方式启动实际 `AppData/Local/TaskRelay/app-0.4.6/TaskRelay.exe`。当日启动已用 2；无排队/执行中运行，旧 `run_ae0010ad117d4c9dbe329c526e41331f` 保持 unknown。虚构站 form=1、assist=0、approval=0、cancel=0。
- 旧 unknown 的只读核查 `run_af579c3f80064ba3bee8fd2b45740a6f` 返回 `SUCCESS_CRITERION_NOT_MET`；没有写操作，原 unknown 与锁正确保留。此结果不能记为原任务成功，也不能删除锁。该核查在新 assist 写入之前完成，后续共用计数器的变化不能倒推旧运行成功。
- 人工协助复验 `run_ba279ea560fa4822b0f14fd7c0a7a461` 发现重复索取相同目标信息：已消费记录 target 正确、secret 清理，但下一次规划仍请求同一输入框。首次云端修复向规划传递当前运行/租约已消费的目标摘要，Worker `db25458a-a55b-4d6f-bdd2-6d145e82a4bf`；现场仍重复，因此不能宣称该提示修改已解决问题。随后取消，因已填写保守进入 unknown，assist 计数仍为 0，保留锁与失败证据。
- 继续修复执行器：观察只报告输入框 filled 布尔值，不包含值或长度；协助完成历史记录具体目标与读回一致的事实，不把填写成功当作业务成功。桌面提升 0.4.8 并同步锁文件，安装后成功复验见下文。
- 批准拒绝 `run_6dd600ea656a47e1a81d864803515998`：真实网页展示绑定 `/approval` 和 `button[type="submit"]` 的批准卡，点击拒绝后终态 cancelled；write_pending=0、may_have_written=0，站点 approval 计数仍为 0。截图 `.cache/qa1104/approval-rejected.png`。
- 源码检查：typecheck、161 项完整测试（含 UI）、Web build、check:repo 通过；新增覆盖生产规划两协议的协助状态隔离/脱敏，以及实际 execute 的后续规划历史。Hono CLI 对命名导出的 app 返回 INVALID_APP，未将该 CLI 记为通过；生产入口由项目回归测试直接调用。构建仍有既有大 chunk/混合导入提示。`graphify update .` 成功，4285 节点/6755 边/374 社区；SQL parser 缺失、两个 TSX 部分提取警告保留。
- 0.4.8 make、packaged/installed smoke 均通过，安装报告 executablePath 指向系统 app-0.4.8。系统物理路径（UNC 读取）与构建 ASAR SHA-256 均为 `6657b0d0189c1ea1f255feb653e835435df1bb156705154c2775c5539b500df3`；原设备授权保留，窗口显示 0.4.8 在线。直接从 UNC 执行 smoke 未产生报告，随后系统本地路径的全新报告通过，未复用旧报告。安装器经原生系统应用启动入口运行，旧 Explorer 窗口无法激活；尚未补本次快捷方式重开证明，不记为第二批完整更新交付。
- 提交后中断：`run_04b42bb0285b418ba8c9ef85668ae611` 在虚构站 `/cancel` 计数提交为 1 后、15 秒响应窗口内，于 `2026-11-04T03:11:04.670Z` 终止其唯一独立 utilityProcess（PID 30252，Main PID 20476）。正式 Host 回传 `unknown/EXECUTOR_EXITED`；填写 action 已 observed，提交 action 保持 intended，账号锁保留，journal/outbox 已清理。仅终止该测试进程，没有操作其他应用或全局网络。证据 `.cache/qa1104/fault-injection.json`、`submit-unknown.png`；后续只读核查运行 `run_42de0d0da6f74062b9afb2b47749b42c`。
- 上述只读核查成功，证据时间 `2026-11-04T03:12:55.672Z`；核查运行与原运行均为 succeeded，原结果 already_done、write_pending=0，对应账号锁释放。站点 cancel 计数始终为 1，没有重复提交。截图 `.cache/qa1104/reconciled.png`。
- 修复后协助与批准：任务 `task_e6fa2caf0a7cd204ae14f10ccf73851d160c80a2`，运行 `run_7421e4afd5f94cd69c92e03f6a42c8e6`，由系统 0.4.8 与当前 Responses 模型实际执行。仅产生 1 次 information 和 1 次 approval，均 consumed、secret 已清理；虚构回复的前导零/大小写经站点精确比较通过，普通对话页面不含回复原文。批准后 assist 计数从 0 到 1，终态 succeeded/completed_now，证据时间 `2026-11-04T03:16:02.703Z`。截图 `.cache/qa1104/assist-approval.png`、`assist-success.png`。
- 一次性调度：任务 `task_def3ae54402e15e81b5b328d8f54b4cb7746c3be`，上海时间 11:19（`2026-11-04T03:19:00Z`）。试运行 `run_425877974f774954bfb3e3942ab7c9c4` 成功后启用；云端于 03:19:07.956Z 创建定时运行 `run_39f875b1245c4cad8edc829f6ee21c97`，03:19:23.067Z succeeded，next_run_at 已清空。未用手动“运行一次”代替定时触发。
- 周期调度：任务 `task_13a4b60365f18103a627ed6b1f8d78153c9dcb3d`，`*/5 * * * * / Asia/Shanghai`；试运行 `run_e92e349f5b364ff1bc5b5ad86fe62ae3` 成功后，云端于 03:25:07.791Z 为 11:25 时隙创建 `run_0084bb389e5b4d38b419e8bcbe03161d`，03:25:22.708Z succeeded，下一时隙正确推进至 11:30。随后从网站暂停调度，确认 status=paused、next_run_at=null，菜单显示“启用调度”。截图 `.cache/qa1104/cron-success-paused.png`；仅验证一个真实周期，不冒充跨日或多次漏跑验证。
- 收尾：每日上限恢复 5，当日已用 12 不重置（本轮新增 10，含失败/核查/试运行），网页显示 12/5，上海时间次日 00:00 重置。没有 queued/running/waiting_human/verifying，系统实际 SQLite 的 outbox 与未完成 journal 均为空。只保留上述两条 unknown 的原账号锁；没有手工解锁或覆写终态。虚构站最终 form=1、assist=1、approval=0、cancel=1。
- 本轮已部署上述云端修复并安装 0.4.8；Setup SHA-256 为 `1d1b89ec4640604e266caa095527291cf74be1821e36905c28f3376ec45f655a`（363062784 字节）。`out/release-manifest.json` 已生成，sourceDirty=true；源码尚未提交，不能称为干净 tag 构建或公开发布。
- 模型与环境：本机 Windows x64，原设备授权；`gpt-6-luna / Responses`，模型配置 `model_92a4d269cf454a34b579a089aabe7ab6` v2，生产模型仍经过既有美国 ModelEgress。真实模型参与创建和协助/动作规划；只读任务一旦页面满足判据，程序直接核验成功，不强行额外调用模型。全部写入仅限虚构站。
- 边界：本轮不包含真实账号登录/扫码/CAPTCHA、非 GPT 或真实 Chat Completions 服务、断网/断电/休眠/锁屏、多设备竞争、跨日/超一小时迟到及连续七天；自动升级通道、快捷方式重开和干净 Windows 属于后续交付验收。源码测试和开发机 smoke 不能替代这些项目。
- 文档维护：README、CHANGELOG、ARCHITECTURE、UI-REVIEW 同步当前版本/修复/证据范围；相对文件链接与 `git diff --check` 通过。日志与截图仅在忽略目录保存，没有提交密钥、Profile、SQLite 或构建产物。

## 2026-11-04 冗余与过时内容清理（本地源码）

- 通过 graphify 查询、全仓引用搜索和 TypeScript 诊断核对删除依据。移除无调用的 terminalStatuses/isTerminal/assertTransition、devicesTable、闲置导入和 generate 的未使用 graphId 参数；实际状态事务、账号锁和数据库迁移保持不变。
- 删除已由 Zod 校验替代的根 Ajv 依赖，同步锁文件；保留 Better Auth 所需的 jose、实际使用的 langchain 与平台 adapter。未删除历史迁移、旧协议拒绝逻辑、一次性切换工具或安全校验。
- DESIGN 改为当前设计入口，删除过时绿色主题/双端工作台说明；架构文档统一协议 3、应用会话、独立执行器、异步 DO 与加密证据事实。部署文档收拢重复版本摘要，README 区分源码 0.4.7 与最近已验收系统安装 0.4.6；历史验收证据保留。
- `npm run typecheck`、158 项 `npm test`（含 UI）、`npm run build`、`npm run check:repo`、`git diff --check` 通过，已核对修改文档的相对文件链接。构建保留大 chunk 与 contracts 同时静态/动态导入提示；未以本次清理展开性能重构。
- `graphify update .` 成功更新源码图：4282 节点、6752 边、373 社区。仍缺少 tree_sitter_sql，admin-panel/auth-gate 两个 TSX 存在部分提取警告；未执行文档语义重新提取，不声称图覆盖全部文档或 SQL。
- 本轮没有修改 UI 行为、执行器实现或数据库，没有重新打包、安装、部署、调用真实模型或操作真实任务；上述检查不扩展此前现场验收范围。


## 2026-11-04 0.4.7 版本检查与空闲更新（本地候选）

- 实现启动 15 秒/每 6 小时检查、手动检查、Windows 提醒、Main 原生确认、CF 下载、大小和 SHA-256/SHA-1 校验、空闲 Squirrel 安装重启。安装器只接收应用自有本地 feed；更新地址固定，不使用配对地址或远程文件内的任意 URL。自启动使用 Squirrel 的稳定启动入口，迁移已有启用偏好，避免指向旧版本目录。
- 158 项完整测试通过（含 UI）。新增 14 项覆盖真实 Poller/Host/Updater 协作、领取响应丢失后的同编号解析、人工等待、进程清理、在途 RPC、回传失败、重复安装门闩、版本校验、文件损坏/长度/截断/离线/重定向、CF 代理域名限制与凭据剥离、共享 UI 请求。类型检查、Web build、仓库检查与差异格式检查通过；Web 保留既有大 chunk 提醒。
- 最终 Windows 0.4.7 make 与 packaged smoke 通过，报告版本为 0.4.7，时间晚于最终 ASAR；Setup 为 363063808 字节，路径 `apps/desktop/out/make/squirrel.windows/x64/TaskRelay Setup.exe`。包内 smoke 仅证明独立 Stagehand/资源/原生依赖及自建站操作，不证明自动更新本身。真实本机 Update.exe 仅执行 `--checkForUpdate`，识别本地 feed 的 futureVersion=0.4.7；它报告 currentVersion=0.4.5，属于工具环境可见副本，不能当作系统安装 0.4.6 已升级或真实应用更新证据。
- 本地 workerd 正式 Worker 路径：latest GET/HEAD=200、POST=405、未知文件=404；初始通道返回 `{release:null}`，无 Location。CF 流式代理和客户端拒绝重定向有隔离网络测试，未发布真实更新文件或执行生产 CF 下载。
- 浏览器窄窗口/键盘/错误与等待状态检查见 UI-REVIEW。`prepare-update.mjs` 对现存旧版清单明确返回 `RELEASE_ACCEPTANCE_REQUIRED`，没有生成伪造的 0.4.7 发布候选。没有复用 0.4.6 的安装 smoke。
- 源码图已更新为 4317 节点/6791 边/371 社区；保留既有 SQL 解析器缺失、admin-panel/auth-gate 两个 TSX 部分抽取警告。
- **未完成的发布验收**：0.4.7 系统安装/快捷方式/ASAR、安装 smoke、真实跨版本安装重启及自启动、生产 CF 更新通道和 GitHub Release、干净 Windows、真实任务运行中升级与连续观察。本轮未部署云端、未替换当前安装、不调用真实模型、不改生产数据；旧客户端首次启用需安装新包。`desktop-releases.json` 保持空目录，不能声称线上更新已启用。

## 2026-11-04 0.4.6 安装自检修复与 GitHub 工程入口

- 复现 0.4.5 安装自检：页面已经载入，DOM 中存在查询文字，但 Stagehand locator 仍在 20 秒后超时。调试证据显示安装资源的 content-script.js 磁盘 SHA-256 正确，Chromium 的 scriptParsed 却为 length=0、空内容哈希；同一浏览器读取构建目录或新建运行目录的同字节扩展可正常返回。已定位到安装路径下内容脚本加载行为，未据此断言 Windows/Chromium 更底层原因。
- 新增 Main 的 prepareExtension：按完整文件集合与 SHA-256 准备应用自有内容目录，原子发布并校验，缓存损坏/额外文件/符号链接拒绝加载。正式启动和 smoke 共用此流程，保持 Stagehand 4.3.0，不改 SDK、不延长 locator 超时、不改系统 ACL 或关闭浏览器保护。
- smoke 增加实际版本/程序/资源/扩展路径及原始 ASAR 哈希；使用 Electron original-fs 读取归档字节，启动失败/子进程提前退出时也清理测试资源，重启前核对并恢复自有测试浏览器。发布清单校验报告版本与 ASAR，不再按 LOCALAPPDATA 猜安装路径，并显式记录 sourceDirty。
- typecheck、**144 项完整测试**（含三项正式扩展准备回归）、Web build、check:repo、0.4.6 make、最终打包及实际安装 smoke 通过。最终两份报告均记录读取、提取、监测、前导零与错误码拒绝，表单提交/签到/错误验证码次数各为 1。初次自检因新增 ASAR 哈希读取方式错误失败，已改用 original-fs 并重新完整打包；只采用最终新报告。
- 通过系统 Explorer 安装，并从实际桌面 TaskRelay.lnk 打开，原生窗口确认系统 `AppData/Local/TaskRelay/app-0.4.6/TaskRelay.exe`、在线等待、0.4.6 与一屏展示；不是 LocalCache 副本。系统物理路径（本机 UNC 读取）与构建 ASAR 均为 `5a5fea6cf2fe6933ee3d6840d6eadfe0cde0f4ac5b847d0d07cf42985b0096d9`。安装包 SHA-256：`658d72d57a31f3407bb70c8fd5eb0183f4ef7025ab82b3b7493b567ae9b90c9a`。
- 新清单 `out/release-manifest.json` 指向系统安装；生成时源码尚未提交，sourceDirty=true，不冒充干净 tag 构建。日志、对照探针和截图在忽略目录 `.cache/release-046/`；源码图为 4248 节点/6599 边/375 社区，保留既有 SQL 解析器缺失与 TSX 部分抽取限制。
- README 补齐功能边界、架构图、开发/手动更新/验收入口，新增 CHANGELOG；CI 配置 Ubuntu/Windows + Node 24，固定 Actions SHA，最小读取权限，无生产密钥。首次云端运行结果以推送后的 GitHub Actions 为准，不能用本机测试替代。
- 本轮没有发布 GitHub Release 或云端版本，没有恢复业务验收、增加真实模型请求、改额度或处理旧 unknown。干净 Windows、非 GPT、现场完整故障流程和长期观察仍待验收。

## 2026-11-04 0.4.5 执行器一屏展示

- 用户补充要求完整内容一屏展示。ExecutorApp 收紧 Card、FieldGroup 和页面间距，暂停说明放入对应 FieldContent，保留字号、控件和异常内容的滚动兜底。
- typecheck、25 项 UI 测试、Web build、check:repo、make、本次 packaged smoke 通过。源码图更新为 4190 节点/6520 边/374 社区，既有 SQL 解析器缺失及两个 TSX 部分抽取警告保留。
- 已通过系统 Explorer 更新，并从实际桌面快捷方式打开。原生工具确认进程路径为 `C:/Users/96227/AppData/Local/TaskRelay/app-0.4.5/TaskRelay.exe`，无 LocalCache；界面显示在线等待、版本 0.4.5。默认窗口中从标题到页尾说明、版本号全部可见，右侧无滚动条。截图 `.cache/acceptance-042/single-screen-installed.png`；未验证最小窗口及其他缩放比例。
- Codex 内启动安装程序曾写入 MSIX LocalCache 副本，不能当作系统更新证据。随后从系统 Explorer 安装成功；通过本机 `\\localhost\C$` 路径读取物理系统安装 ASAR，和构建 ASAR 的 SHA-256 均为 `8846e0fbce5af1013e3401b92dc0093d065d452152efee64bceda4d98b2e518a`。
- **安装 smoke 尚未通过**：直接执行 UNC 路径未产生新报告；工具环境的安装副本两次在 query/inner_text 等待 20 秒超时，第二次使用独立测试目录仍失败。尝试从系统 Explorer 启动检查后未观测到新报告，不能记为系统安装 smoke 通过。`out/installed-smoke.json` 保留失败结果，未生成新的发布清单；既有 `out/release-manifest.json` 仍属于 0.4.4，不是 0.4.5 验收证据。实际窗口布局检查与上述自动化检查分开记录。
- 本轮没有恢复业务任务验收、调用真实模型或部署云端，原 unknown、默认额度和待验收项目不变。干净 Windows、真实网站闭环与连续观察不在本次 UI 验证范围。

## 2026-11-04 0.4.4 隐藏执行器滚动条

- 用户要求去掉截图中的右侧滚动条。ExecutorApp 改为视口高度的内部滚动容器，隐藏滚动条但保留滚动能力；未改变任务执行、授权或云端版本。
- typecheck、25 项 UI 测试、Web build、check:repo、make、本次 packaged/installed smoke 通过。源码图更新为 4188 节点/6516 边；仍有 SQL 解析依赖缺失及两个既有 TSX 部分抽取警告。
- 打包曾因 GitHub 校验文件 TLS 下载失败阻塞，Forge 改用同版本官方 electron 包附带 checksums.json，缓存 ZIP 仍通过 SHA-256 校验，没有禁用完整性检查。
- 已通过系统 Explorer 安装 0.4.4，并从桌面 TaskRelay.lnk 打开；进程在系统 app-0.4.4 目录，窗口显示 0.4.4、在线等待。原生窗口目视确认右侧滚动条消失，滚轮仍可到达底部版本信息。仅关闭本次新开的安装 Explorer 窗口，用户原目录保留。
- 安装/构建 ASAR 均为 `51b7d4fe0703e3183137759a4bd09ae560aab51f8231a40625249a182f47f83b`；安装包 SHA-256 为 `006c3a0bee5da9215ed8098365c89ecfacc9e4b89a2edbb0f90de6a229c70132`。新 `out/release-manifest.json` 指向系统目录，无 LocalCache；未提交工作区的 sourceCommit 仅是基线。
- 本轮未恢复上一节暂停的任务验收，未新增运行、模型调用或修改启动额度。日志为 `.cache/acceptance-042/scrollbar-*.log`，不据此声称 unknown 核查、人工协助闭环、干净 Windows 或长期观察已完成。

## 2026-11-04 0.4.3 修复完成，现场验收由用户暂停

此节覆盖下方 0.4.2 的最终版本与验证数量。用户在系统快捷方式复验时按 Esc 停止 Computer Use，已停止界面操作，待执行项目不记为通过。

- 现场 `run_ae0010ad117d4c9dbe329c526e41331f` 的 information challenge 缺少 target，消费后报 CHALLENGE_TARGET_REQUIRED，进入 unknown。challenge 已 expired、secret 已清理；未重放或解锁，原运行与账号锁保留供只读核查。
- 已修复：共享协议要求 code/information/scan 目标；生产规划无目标输出触发一次结构化修复；后端拒绝无目标挑战；执行器在创建协助前检查页面目标。需要批准的点击由具体 high_impact 动作产生绑定批准卡。
- 最终 typecheck、**141 项完整测试**、check:repo、Web build、0.4.3 make、0.4.3 packaged smoke 通过。新增三项回归分别命中生产规划、后端创建、实际 execute。源码图已更新至 4185 节点/6513 边；8 个 SQL 缺少 tree_sitter_sql，两个既有 TSX 仅部分抽取。
- 最终 Worker **`dfdaf69c-d9e9-4c58-ad91-0d084bf14167`**。0.4.3 安装包已由系统 Explorer 执行，系统进程已观测为 `AppData/Local/TaskRelay/app-0.4.3/TaskRelay.exe`；随后快捷方式、安装 ASAR 对照及安装 smoke 尚未完成。`out/release-manifest.json` 仍是此前 0.4.2 记录，不能作为 0.4.3 清单。
- 用户允许临时将 owner 日启动从 5 调至 8，尚未新增启动就停止界面操作；已恢复为 **5**。模型/对话额度未变，没有新增周期任务、付费服务或注册权限。0.4.3 协助复验仅生成待确认草稿，未确认、未执行。
- 待继续：安装目录 smoke/哈希/快捷方式；0.4.3 人工信息和批准闭环；上述 unknown 的只读核查；提交后中断及只读恢复；定时执行。用户确认暂无非 GPT 配置和第二台 Windows，此两项与七天观察仍为外部环境/时间缺口。
- 虚构验收站仅 `/cancel` 增加计数已写入后延迟 15 秒响应的故障窗口，Worker `024e038b-35c6-46f8-ad56-822ef94f0c3c`；尚未触发该窗口。每用例最多 10 次、2026-11-05 00:00 UTC 后拒绝写入的边界不变。

## 2026-11-04 完整性修复与 0.4.2 验收

本节是最新基线；下方有日期的暂停、版本、额度及“未修复”记录是当时事实，不代表当前状态。用户已授权按完整性分析执行，认证敏感步骤仍沿用此前暂缓范围；不提高额度、不开放注册。

### 已完成的修复

- Host 心跳返回后的代次校验、停止期间 RPC 阻断；浏览器启动和关闭互斥，关闭能取消尚未 spawn 的启动；退出清理失败继续阻止新任务。
- 恢复识别持久化 unknown，复用原 finish outbox 键保留已排队终态；execute 在敏感消费/凭据异步返回后再次检查停止，保留写入不确定性。
- 历史报告从 UI 到 ai_turns、alarm、运行快照与步骤均绑定所选 runId；跨用户/任务及缺少绑定明确拒绝。
- 成功判据明确为单段字面原文，对常见多段拼接返回澄清；这是有限歧义保护，不是完整多条件协议。
- 网页显示个人和 UTC 平台预算、重置时间；排队原因来自当前已知阻塞条件；超过一小时的调度时隙直接跳过。
- 现场发现创建助手混淆“规划协助”和“在创建对话索取敏感值”，已补充边界提示。普通聊天不得收集密码/验证码；执行时仍走专用协助通道。

### 源码、构建与安装证据

- typecheck、完整 **138 项测试**（含实际共享组件 **25 项**）、check:repo、Web build 通过。新增 12 项直接调用正式 ExecutorHost/execute 的故障用例；SDK、进程、网络以隔离 adapter 替代，因此不冒充整机故障测试。补充提交前 checkpoint/云端 intent 与实际 click 的顺序断言通过。
- `scripts/test-free-runtime.mjs` 通过真实本地 workerd 的网关、alarm/outbox、重复请求、1.1 MB 加密证据及通知撤销检查；不是线上模型证明。构建仍提示既有 500 kB chunk 和静态/动态重复导入。
- Windows **0.4.2** 已 `npm run make`，本次 `out/packaged-smoke.json` 与 `out/installed-smoke.json` 均通过；仅证明独立 Stagehand 4.3.0/原生加载/自建站操作，不等于 execute 故障流程。
- 系统 Explorer 运行本次安装包，桌面 `TaskRelay.lnk` 打开系统 `C:/Users/96227/AppData/Local/TaskRelay/app-0.4.2/TaskRelay.exe`，窗口显示 0.4.2、在线等待，原设备授权保留。安装 ASAR 的 realpath 无 LocalCache，SHA-256 与构建均为 `e6d1d15db54d5f5021cbd20798f80d22d07c196f9812ec904fbd1a47c3fcf5a6`；安装包 SHA-256 为 `5b0a6159494688a3507e50028b9caa330bf547c1bea96c951ab6be630569b27b`。
- 清单为 `out/release-manifest.json`；当前改动未提交，清单 sourceCommit 是 Git 基线，不代表全部源码。测试/构建日志与网页证据在忽略目录 `.cache/acceptance-042/`。
- 生产已应用 additive `0008_report_run.sql`。初版 Worker `793ab477-b835-4eea-9650-4b423a251765`；人工协助提示修正版 **`ee191cf7-e7cc-4a3c-a934-a308367ebc06`**。MASTER_KEY 和既有密文不变，Free、六类 SQLite DO、无生产 R2、注册关闭保留。匿名/bearer 越权检查通过。

### 本轮真实链路

1. **表单仅提交一次**：`run_a2532d7fafa345adab9ecd6d60c93442`，系统安装 0.4.2、生产云端、真实 Responses/gpt-6-luna 与独立虚构站共同参与。填写 QA1103 后提交，程序核验“已提交次数：1”，状态 succeeded；独立 D1 `/form` 计数从 0 到 1，其余用例当时仍 0。不是 smoke，未访问业务账号。截图 `form-success.png`。
2. **历史报告**：同一任务已出现上述成功运行后，在“运行记录”选择前一天已取消的 `run_8f2b3f8e214d4699a1bddf080e0867df`，真实模型报告明确引用该运行编号、已取消且无步骤证据，没有套用新运行的成功结果。截图 `historical-report.png`。
3. **预算与手机布局**：真实生产页显示两套额度及 00:00/08:00 重置点；390×844 下预算正常换行、底部输入区可见，scrollWidth=390；820×700 下 scrollWidth=820。未替代实体手机、输入法及超长历史验证。截图 `mobile-budgets.png`。

### 仍需外部环境或时间的门槛

- 当前仅有 Responses 的 GPT 配置，没有可用非 GPT 服务；没有第二台干净 Windows 或真实第二用户/设备。本轮不声明这些验收通过。
- 七天观察不能由一次会话替代；2026-11-04 为首日现场样本，后续需逐日记录成功/失败/unknown、设备心跳、outbox 与免费额度。没有创建自动执行或扩大授权的后台任务。
- 真实邮件/密码/人机验证等用户此前指定暂缓的认证步骤、签名安装、独立 Windows 卸载/升级、真实断电/睡眠与跨日长时间运行仍需单独验收。

## 2026-11-03 用户视角扩展验收（23:08 批次）

**结论：本轮已完成下面标明的真实操作与修复复测，不能宣称全流程全部通过。** 用户明确将邮件、登录、验证码、设置密码等认证敏感步骤列为待验收；执行额度已使用 7/5，另有用户的百度任务排队。临时提高额度会启动该任务，尚未获得本轮询问的答复，所以没有调整额度或消耗额外启动次数。

环境为正式网站 `https://tr.zhangheng.eu.org`、现有 owner 登录会话、真实 Edge、系统安装的 Windows 0.4.1。最终 Worker 为 `6f75a793-92ce-4efc-a940-bdf4876b963b`。本轮仅更新网页及验收夹具；Windows 当前使用独立 `ExecutorApp`，不包含本次修改的任务对话/设置组件，因此没有重新打包或替换 0.4.1。

### 真实产品操作台账

| 编号 | 用户流程 | 结果及证据范围 |
| --- | --- | --- |
| U01 | 已登录用户打开独立验收页、刷新 | 通过；恢复任务列表、现有授权设备和聊天；未重新登录 |
| U02 | 任务/设置/运行记录导航 | 通过；移动抽屉进入设置后关闭；未对用户原标签页做操作 |
| U03 | 搜索命中、无匹配、清空搜索 | 通过；匹配任务正确，无匹配列表为空，清空恢复 |
| U04 | 新任务缺少网站地址 | 通过；只追问网站，没有创建任务或请求模型（对话额度仍计数） |
| U05 | 刷新恢复创建对话 | 通过；缺失网站的用户消息与追问仍在 |
| U06 | 补齐网站、目标、账号、手动时间及授权 | 通过生成确认卡；仅生成草稿时侧栏没有新任务。多段成功条件的质量问题见下文 |
| U07 | 详细配置：手动/一次性/周期选项 | 表单操作通过；一次性显示本机时区、周期显示 Cron 和 Asia/Shanghai。未实际等待定时触发 |
| U08 | 非法 HTTP 本机地址、修正后继续 | 发现并修复；旧版后端拒绝但确认卡锁死。新版表单和确认前拒绝，仍可编辑；真实网页复测通过 |
| U09 | 修改入口地址不自动扩大允许站点 | 修复；移除编辑器自动加入新 origin；实际共享组件回归验证未授权新站点不能提交 |
| U10 | 确认任务、入队、取消排队 | 通过；生成唯一任务与唯一运行，取消后数据库为 cancelled、write_pending=0 |
| U11 | 取消后未写入目标站点 | 通过；隔离验收站 `/form` 仍显示已提交次数 0；没有启动 Executor |
| U12 | 异步聊天等待状态 | 发现并修复；202 返回后“正在回复…”持续显示，直到实际完成；源码组件测试和部署网页均通过 |
| U13 | 记忆新增、修改、重新进入页面读取 | 通过；空白不可保存；修改后的 QA1103 偏好可见，没有重复新增 |
| U14 | 真实模型使用已确认记忆 | 通过；模型正确回答验收标记 QA1103、先结论再编号步骤；本轮取消报告也使用了该格式 |
| U15 | 普通聊天请求修改调度 | 通过；仅返回调整任务卡提示；数据库任务 version=1、schedule=manual、运行数仍为 1 |
| U16 | 取消运行生成报告 | 通过；真实模型明确说明已取消、无执行证据、不能确认提交成功，没有编造结果 |
| U17 | 历史运行列表及选中失败记录 | 通过；成功/失败/取消分别可见；选中历史 Schema 失败显示该次错误。历史报告绑定另列风险 |
| U18 | 已完成运行的步骤、结果、模型用量 | 通过读取既有成功记录；展开实际 1396 tokens、费用未知，JSON 结果与证据入口可见；不是本轮重新执行成功 |
| U19 | 模型新增表单、自由模型名、协议、取消 | UI 通过；可输入非 GPT 名称并选择 Responses，取消后仍仅原模型 v2。没有保存新密钥或声称非 GPT 调用通过 |
| U20 | 站点账号空态、添加表单、取消 | UI 通过；未录入密码、未保存或登录真实账号 |
| U21 | 设备、管理员配额、数据保留页面 | 只读通过；设备最近连接、owner 每日启动 5、模型 200、聊天 50、保留 30 天可见；未吊销或改配额 |
| U22 | 手机 390×844 设置布局 | 发现并修复标签高度；标签最下沿 172px、面板顶部 183px，无覆盖；页面宽与 scrollWidth 均为 390 |
| U23 | 窄桌面 820×700 设置布局 | 通过；标签最下沿 191px、面板顶部 199px，页面与 scrollWidth 均为 820；最后已恢复默认视口 |
| U24 | 键盘与手机聊天 | 实际 Enter 发送、设置标签 ArrowRight 切换通过；手机长报告滚动和底部输入区可见。Shift+Enter/中文组合态另由实际 Composer 回归覆盖，未冒充真实 IME 验收 |
| U25 | Windows 暂停/恢复领取 | 通过；UI 先显示已暂停领取，再恢复在线等待任务；未修改系统自启动 |
| U26 | 关闭主窗口并从桌面快捷方式重开 | 通过；关闭后窗口消失，四个原安装目录进程仍在；系统 Explorer 打开真实 TaskRelay.lnk 后恢复原窗口和在线状态 |
| U27 | Windows 导出诊断 | 通过；系统另存为导出 788 字节 JSON；仅 version/platform/arch/state/schema/journal/outboxCount，outbox=0；敏感字段模式检查未命中，没有 Profile/SQLite 文件 |
| U28 | 主题入口 | 菜单正常，提供系统/浅色/深色；未修改用户原主题，不能算三主题全量视觉验收 |

### 本轮修复和验证

1. `TaskCompose`/`Conversation` 等待提示与服务端 activeTurn 对齐，解决 HTTP 202 后假空闲。
2. 编辑器及首次确认使用现有 `publicUrl`/`allowedNavigation`；非法地址在持久化确认尝试之前被拒绝，允许修正；新站点不再被隐式添加到授权列表。修正成功后清除旧错误。网络结果不确定的既有幂等重试保护保留。
3. 已取消且无步骤的运行不再显示“等待取消确认”；明确显示“本次运行没有步骤记录”。
4. queued 文案改为“排队中”，说明需同时具备可用设备与执行额度，避免将所有排队原因归为设备离线；尚未细分每一条任务的精确阻塞原因。
5. 设置 TabsList 的默认 orientation 高度覆盖了普通 h-auto，导致手机换行溢出。现按相同 variant 覆盖为 auto，并调整 TabsTrigger 高度；390/820px 实测通过。

最终 `npm test` **119 项通过**，其中实际共享组件 UI 测试 **23 项**；typecheck、check:repo、Web build 通过。构建仍有既有 chunk 大小和混合静态/动态导入提示。`graphify update .` 成功；仍有 tree_sitter_sql 缺失及 admin-panel/auth-gate 两个既有 TSX 局部解析警告。此处不是干净 Windows、真实多设备或长期运行证明。

### 已发现但未关闭的问题

- **多段成功条件会被模型拼成不存在的单段文字。** 实际草稿生成 `QA1103-SUBMITTED；已提交次数：1`，而页面是两个独立段落；当前 text_present 是字面匹配。验收任务手工更正为 `已提交次数：1`。后续需明确单段字面值与多条件协议，不能仅用模型宣称成功替代程序核验。
- **历史报告缺少所选运行绑定（源码核对）。** 页面选中旧运行后，“生成报告”仍只发送 mode=report；服务端读取最近三次运行和最新运行步骤，未传所选 runId。当前运行报告 U16 已验证，不能据此声明任意历史运行报告正确。这一项尚未实测修复。

### 待验收与当前保留状态

- 用户指定暂缓：注册/登录、邮件投递与链接、找回/修改密码、人机验证、敏感站点账号操作。
- 待额度处理确认：真实 Executor 完成虚构表单一次提交、人工信息回复（前导零/大小写）、批准/拒绝、运行中取消、unknown 后只读核查、定时触发。相关源码测试通过不替代真实链路。
- 尚未覆盖：多设备/多用户并发、设备吊销与重新配对、真实网络中断/断电/重启恢复、50 条以上历史分页/摘要压缩阈值、自动保留期清理、干净 Windows、真实 Chat Completions/非 GPT 浏览器闭环、多日免费额度观察。
- 新建测试任务 `task_e1d34a14ffe4c5e7219a0b8512fe0323b49b0115`，唯一运行 `run_8f2b3f8e214d4699a1bddf080e0867df` 已取消且 write_pending=0；保持手动、待试运行，不会周期启动。用于复测的报告及聊天保留。
- 用户百度任务 `run_3e6879e4445f4f509c034251768278cc` 保持原队列；未修改/取消它。owner 日启动仍为 5，消费仍为 7；最终实际 UI 模型 48/200、聊天 23/50。
- 本轮唯一新增的 QA1103 测试记忆保留，已询问是否永久删除但尚无答复；没有清空任何用户历史。
- 独立验收站 `https://taskrelay-acceptance.zhangheng.workers.dev`，Worker `taskrelay-acceptance`，D1 `taskrelay-acceptance-20261103`（`0f55a3b6-df5e-443c-99d1-b0daebea8cc6`）。只有四个固定虚构用例，每例最多 10 次写入，2026-11-05 00:00 UTC 后拒绝写入。没有模型、认证、生产数据库或密钥绑定，未开通付费服务。源码为 `scripts/acceptance-site/worker.mjs`。

证据：`.cache/qa1103-tests.log`、`qa1103-ui.log`、`qa1103-typecheck.log`、`qa1103-build.log`、`qa1103-deploy.log`、`qa1103-graph.log`、`qa1103-diagnostics.json`。截图：`.cache/ai-live/qa1103-mobile-settings.png`、`qa1103-async-pending.png`、`qa1103-final-report.png`。截图、诊断、部署配置及构建产物均在忽略目录，未提交。

## 2026-11-03 Cloudflare Free 与 Windows 0.4.1

本节为最新发布记录；后面的 0.3.0 CPU 阻断描述保留作历史。

- 生产已应用 additive `0007_free_runtime.sql`，当前 Worker 为 `0f3b09de-f7b3-4c53-b8fa-17e3e56dc918`。仍为 Free；没有设置不受支持的 cpu_ms、开通 Paid 或改变主密钥。六个 SQLite DO 绑定生效，生产 R2 绑定已移除。公开注册保持关闭。
- `npm test` **116 项通过**（含 20 项实际 React 组件测试），typecheck、check:repo、Web 构建通过。`scripts/test-free-runtime.mjs` 在真实本地 workerd 验证网关鉴权、202 回合/重复请求、alarm 执行、1.1 MB 加密分块证据、WebSocket 升级/消息/设备撤销关闭、Stagehand 2020-12 Schema 解释校验；模型使用隔离夹具，不能代替真实地区证据。
- 0.4.1 安装器 363059712 字节，SHA-256 `9b61b22183c8c03b534daebb8fb0f58aa57adb8dc61aacddee5ef88e2d40c004`。通过系统 Explorer 安装并从实际桌面 `TaskRelay.lnk` 启动，进程路径为 `C:/Users/96227/AppData/Local/TaskRelay/app-0.4.1/TaskRelay.exe`。安装/构建 ASAR 都为 `EC13AF514459CF03653F031C75AE7A60150767829610A4F2573CF64303C1E2D1`；release-manifest 指向系统目录，无 LocalCache 重定向。包内与安装 smoke 均为本次新报告并通过。
- 正式 Edge 保留原登录与设备授权。真实 Responses 模型完成创建草稿、同会话多轮修改和确认卡自动更新；刷新后历史仍在。发现并修复同版本 running→done 不显示确认卡及下一条消息被旧 requestId 阻止的问题，新增生产共享组件回归测试。任务详情改为订阅与 60 秒兜底，后台标签页停止读取。
- 第一轮真实执行被系统 fake-IP DNS（198.18.1.19）挡住，保留失败记录 `run_fa4ffc1a52f84739a99beb85e8607ccd`。0.4.1 使用固定 HTTPS DNS、校验全部答案并固定公网连接；回归测试验证 fake-IP、私网和混合不安全答案仍拒绝。
- 第二轮 `run_7af88340b91944a89f2c5a6b65fc6a46` 已进入真实 ExecutorHost/runtime.execute 与部署模型规划。测试判据误用正文不包含的标题“Example Domain”，程序没有误报成功；报告准确说明运行尚无成功证据。网站取消后云端为 cancelled、write_pending=0，执行器释放后才能领取下一次。未重复任何站点写操作。
- 第三轮 `run_001ebea40cd34c78ad6ff2e03b786b4d` 触发原有 Stagehand Schema 适配错误：真实 SDK 发出 2020-12 Schema，旧 Ajv 路径拒绝请求。云端改为锁定版本 Zod 的 `fromJSONSchema` 解释校验，避免运行时动态代码生成，并使用独立 registry；生产路由测试验证错误输出只修复一次，本地 workerd 验证实际转换与类型拒绝。未改变模型出站或关闭内容校验。
- 最终运行 **`run_8f29a89b43f04cfc90145cd6431a850e` succeeded**：系统安装版 0.4.1 经真实 ExecutorHost/runtime.execute、Stagehand 回调和部署模型完成正文提取，程序核对 `This domain is for use in documentation examples`。网站显示已完成、原文证据、提取 JSON、实际用量 1396 tokens（未配单价，费用未知）；随后真实模型生成成功报告，准确区分证据与未验证部分。刷新后消息/结果仍存在。
- 最新 tail 的 Stagehand 请求 HTTP 200（配对记录 cpuTime 6/1 ms），报告提交 HTTP 202（12/1 ms）；重计算在 DO，外层保持轻量。抽查从 14:30 UTC 开始的事件未见 exceededCpu。完成回传的并发重复请求出现一次 409，终态仍为 succeeded；本地 outbox 已清空，未发生站点动作重放。这是短时实际请求验证，不是长期负载 SLA。
- 为完成更正判据与 Schema 修复后的验收，将 owner 个人日启动额度临时从 5 调至 7；未修改已消费计数、平台预算或 Cloudflare 套餐。成功后已恢复默认 **5**，验收消耗保留，所以当日显示 7/5，上海时间 11 月 4 日零点重置。最终 maintenance=0、claimsEnabled=1、historyEpoch=3；无排队/运行中/unknown 任务。
- 匿名 user/admin 返回 401，设备 bearer 不能访问 user/admin（403），无 token 的 device/status 为 401，旧 device/user 路径为 403；部署自检通过。
- 源码图已更新：4147 节点、6419 边、371 社区；仍有既有 SQL 依赖缺失和两个 TSX 文件局部解析警告。未将图、截图、密钥、构建产物提交到 Git。

证据位于忽略目录：`.cache/free-runtime-tests-final.log`、`.cache/free-workerd-final.log`、`.cache/free-runtime-deploy-final.log`、`.cache/free-041-packaged-smoke.log`、`.cache/free-041-installed-smoke.log`、`.cache/ai-profile-tail.jsonl`；`out/release-manifest.json` 汇总本次产物与 smoke。tail 仅保存路径/状态/耗时，不保存请求头、正文或密钥。

正式网站截图：`.cache/ai-live/free-041-success.png`、`free-041-mobile.png`；390×844 检查结果滚动、证据展开及底部输入区后恢复默认 viewport。

范围限制：开发机 Windows，非干净机器；真实模型为现有 gpt-6-luna/Responses，未新做 Chat Completions 或非 GPT 双协议闭环；真实站点为只读 example.com，生产验证码/扫码、双设备、断电恢复与连续多日免费额度观察仍未验收。smoke 的自建站表单/验证码不能替代这些生产流程。

## 2026-11-03 Logo 本地接入

- 网站登录页/侧栏/移动页头、独立执行器与 favicon 使用新 TR 图形；Windows 图标资源更新，桌面版本及锁文件同步到 0.2.1。
- 本轮 `npm run typecheck`、19 项 `npm run test:ui`、`npm run check:repo`、`npm run build`、`npm run package` 通过。Web 构建保留既有大 chunk 与静态/动态混合导入提示。
- 打包目录为 `apps/desktop/out/TaskRelay-win32-x64`。新报告 `out/logo-packaged-smoke.json` 的 `passed=true`，Electron 45.2.1、Stagehand 4.3.0、自建站读取/监测/签到/表单及前导零检查通过。该 smoke 不调用完整 `runtime.execute()` / `ExecutorHost`，不代表真实模型或真实网站闭环。
- 本轮未部署、未制作新安装器、未更新系统已安装客户端，未执行安装入口/安装哈希、干净 Windows 或连续观察验收。浏览器视觉复验被工具限制终止，细节见 [UI-REVIEW.md](UI-REVIEW.md#2026-11-03-tr-logo-接入本地源码与打包)。

日期：2026-11-03。以下区分源代码测试、开发机安装产物测试与尚未完成的外部验收，不将构建通过视为完整交付验收。

## 最新批次：AI Elements 与 Windows 0.1.1

- 源码：桌面构建提交 `7f9646f`；AI Elements 分阶段提交 `0f7c042`、`b8e5836`，焦点与保存状态修复 `380f44b`、`99c265b`。最后的文档/清单路径补充不改变安装产物。
- 检查：**82 项测试通过，其中 14 项真实 React UI 组件测试**；typecheck、Web/Worker build、check:repo 通过。组件测试验证实际 Transport 请求、确认边界、敏感回复绑定/清理及轮询竞态；JSDOM 不代表布局或 Electron IPC 验收。
- 浏览器：390×844 手机、760×700 窄窗口、键盘输入、失败重试、确认/拒绝、验证码等待、离线、24 条历史滚动与 Trace 结果展示已检查，详见 [UI-REVIEW.md](UI-REVIEW.md)。实体输入法候选框未测试。
- 生产：Worker **`9ab1a0cb-49d9-474b-9956-dc2cbd5384d0`**，Web 界面源码 `99c265b`、资源 `index-JYn3oFKh.js`。新域名真实 `taskrelay v2 / gpt-6-luna / Responses` 生成待确认任务卡，未创建或执行生产任务；`2026-11-03T08:31:32.195Z` 连接、工具和严格 Schema 通过，图像未测。
- 出站：`cloud-self-check --egress --probe-existing` 通过；普通请求 trace 为 `CN/AMS`，美国 jurisdiction 后台请求为 **`US/DFW`**。本轮未修改云端模型/出站/认证/调度或 wrangler 配置，临时诊断设备与配置已清理。
- Windows：Forge Squirrel **0.1.1** 构建通过，安装包 `TaskRelay Setup.exe` 为 **363033600 字节**，SHA-256 **`f5da2a325c4bb36f5b5a6ce02ad0356c341c01738f1ef754f519f7ef8162a56e`**。新 `app.asar` SHA-256 为 `44e8b7568156ada8aeb159e7f2e803f16d0bb4ca74c8be04c12b2d52eac6cc27`。
- 原生依赖：本次 packaged/installed smoke 均通过，实际 Electron 45.2.1、Node 24.22.1、Stagehand 4.3.0 原生 ESM 和内置 Chromium；四类自建站、错误验证码、前导零、签到/表单各一次。使用确定性模型回调，仍未覆盖 `runtime.execute` / `ExecutorHost` 的完整流程。

用户指出仍出现绿色旧界面后，核对发现已安装 ASAR 的哈希与最早旧版一致；此前直接打开新构建不能证明系统入口已升级。现已提升版本、重新构建并安装 0.1.1。Codex MSIX 宿主内的安装实际重定向到 `LocalCache`，因此另从 Windows 运行入口安装同一包，再通过桌面 `TaskRelay.lnk` 启动。原生窗口清单确认进程为系统目录 `C:/Users/96227/AppData/Local/TaskRelay/app-0.1.1/TaskRelay.exe`，实际窗口的任务侧栏和设置已是新版共享 UI。

宿主内升级前本地 unfinished/outbox 均为 0；已备份 SQLite，升级后 schema 1 和配置摘要一致。**该备份与配置比较仅覆盖 Codex 重定向的数据目录**，不据此宣称系统 Roaming 数据已做相同比较。`out/release-manifest.json` 记录本次产物、报告新鲜度和解析后的安装路径；旧的 `ui-release-manifest.json` / `ai-elements-release-manifest.json` 属于历史批次。

系统入口最终复验：通过 Windows 运行入口执行 `Get-FileHash`，实际系统 ASAR 与上方新构建哈希完全一致（`out/system-hash.json`）。再从该目录直接启动带独立测试数据目录的 `--taskrelay-smoke`，`out/system-installed-smoke.json` 本次新报告 `passed=true`、submissions/checkins/wrongCodes 均为 1。该结果独立于 Codex 宿主重定向副本。最终线上界面截图为 `out/ui-review/ai-elements-production-final.png`。

构建保留约 605 KB 的客户端 chunk 及既有动态/静态 import 提示；Graphify 已更新，缺少 SQL parser 的警告不代表 SQL 被解析。真实 GPT/非 GPT 浏览器任务闭环、真实 Chat 服务、托盘/完整 IPC 故障、干净 Windows、中文/空格安装路径及七天观察仍未完成，下方现场表保持待执行。

## 历史批次：0.1.0

以下版本、测试数量、安装哈希和窗口限制属于各自记录时点；当前结果以上方最新批次为准。

结构化输出重构复验：48 项源码测试通过。新增 23 项生产路由测试，删除 1 项只测试未接入 helper 的用例。覆盖 plan/Zod 与 Stagehand/Ajv、Chat/Responses、Schema/JSON、单次修复、版本固定、实际/未知用量、地区约束和传输错误不重试；经过真实 egress/EgressState，外部 HTTP 与平台存储使用隔离 adapter，未重新调用真实模型或部署。

共享 UI 与对话创建复验：总计 **60 项源码测试通过**，另新增 5 项多轮草稿/显式确认测试、7 项旧草稿/普通聊天/验证码回复生产路由测试。typecheck、Web/Worker build 和静态检查通过；Forge Squirrel 已重新构建，当前打包 smoke 通过（实际 Electron/Stagehand/Chrome，四类自建站、错误验证码、前导零、每种写入各一次）。本轮安装包尚未重新安装；下表安装目录证据属于此前基线，不代表最新包安装验收。

默认主题与聊天复验见 [UI-REVIEW.md](UI-REVIEW.md)：1280 桌面、390 手机、760 窄窗口，补充信息、确认卡、编辑、错误重试、敏感回复清理、离线和键盘操作。没有把演示 Transport 的结果记为真实云端模型/设备闭环。构建仍提示客户端单包约 587 KB（gzip 183 KB）及已有共享协议动态导入未拆包警告，构建成功。

严格 Schema 部署及真实模型复验：Worker 版本 `99ca685e-e277-431a-aa2e-0c4260f770e2`。严格 Schema 兼容修复后 **65/65 测试、typecheck、build、check:repo 通过**。原 workers.dev 设备 API 经实际 `gpt-6-luna / Responses` 成功生成“验收草稿”（HTTP 200），只生成预览，未创建或执行任务。能力复验于 `2026-11-03T07:31:44.933Z` 通过连接、工具和严格 Schema。

**新域名地区拒绝已修复：** 此前新域名在浏览器和设备入口均返回 `MODEL_HTTP_403_UNSUPPORTED_REGION`，相同配置在原地址返回 200；独立后台 trace 虽为美国，不能证明推理请求成功。排查发现 `submit` 后从访客链路反复 RPC `wait`，可能在模型配置/DNS 异步准备期间替换 Durable Object 当前 I/O 上下文。现改为单次 `submitAndWait`，对象内部等待，不在 alarm 执行期间发起新 RPC；仍只由美国 jurisdiction 的 alarm 调用模型。未伪造地区头、换模型或绕过失败重放。

当前 Worker 版本 **`84bacc38-c361-400a-8675-d4bc86d7ec94`**。2026-11-03 07:53 UTC 新旧域名设备 API 的同一 `gpt-6-luna / Responses` 草稿请求均返回 **200**；随后新域名通过 Access 的真实浏览器对话生成“新域名验收草稿”确认卡。新域名网页能力测试于 **`2026-11-03T07:54:57.672Z`** 通过连接、工具、严格 Schema，模型仍为原 v2。图像未测试。没有点击“创建并试运行”，未创建或执行任务。证据为 `out/region-check.json` 和 `out/ui-review/production-region-fixed.png`；诊断设备已清理。

本次 **68/68 源码测试、typecheck、build、check:repo 通过**。新增单次 RPC 等待成功/失败、终态确认失败不丢结果、90 秒超时用例，原生产路由测试改用真实 `submitAndWait` 状态路径。内存 adapter 不模拟 Cloudflare 的实际 I/O 上下文；新域名浏览器/设备请求的真实结果单独记录如上。自检脚本默认新域名，支持白名单内的 `--origin` 对照旧地址。本次仅修改云端出站及诊断，无桌面重新打包。

本轮产物记录：`out/ui-release-manifest.json`（UI 源码 `995ba8b`；后续修复仅云端模型代码），安装包 SHA-256 `3917d7aa0853773a824e4665c77386e3e02c339b146e82b46b20a2d8072bfb1c`。`out/production-compose-check.json` 保存两入口的脱敏结果；临时诊断设备与模型配置均已清理。旧 `out/release-manifest.json` 属于此前基线。

| 项目                         | 当前证据与范围                                                                                                                                                                                                        |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TypeScript / 网站构建        | 已通过，使用实际依赖和 Workers Vite 构建                                                                                                                                                                              |
| 可靠性和 API 测试            | 26 项通过：原子领取、幂等、时区/补跑、验证码绑定/消费/过期、多轮验证、旧租约拒绝、重复提交拦截、写入后失败保守锁定、只读核查释放、上游错误脱敏/拒绝重定向、出站作业加密清理与中断不重放、地区约束不可用时拒绝直连回退 |
| Cloudflare 部署              | Workers、D1 四个迁移、私有 R2、每分钟 Cron、Access、美国区域 ModelEgress 已配置；匿名网站跳转登录，设备 API 拒绝无令牌请求                                                                                            |
| 生产模型配置保存             | 真实 Workers 自检：D1/加密/DNS 通过；完整 Responses 地址规范化后保存返回 201；测试配置已删除，没有使用真实 API Key                                                                                                    |
| 真实模型能力与地区           | 2026-11-03 04:46:24 UTC：原有 `gpt-6-luna / Responses` 连接、工具、严格 Schema 全部通过；独立后台出站 trace 为 `US/IAD`，先前 HK 地区拒绝已消除。图像未验证，非 GPT 未配置                                            |
| 打包后 Stagehand             | 开发机实际 TaskRelay.exe → utilityProcess → Stagehand 4.3.0 原生 ESM → 内置 Chrome 156.0.8078.80 已通过                                                                                                               |
| 安装目录实际运行             | 最终安装包再次安装退出码 0，已安装 `app.asar` 与构建产物 SHA-256 一致；安装目录启动四类自建站测试通过，见 `out/installed-smoke.json`。已修正 MSIX 文件重定向导致原生浏览器 spawn 失败的问题                           |
| 四类自建站任务               | 打包产物中完成查询/提取、监测、登录签到、普通表单；错误验证码被拒绝，`0012aB` 原样保留；签到与表单计数各一次。确定性模型回调，并非真实 LLM                                                                            |
| 中文/空格数据路径            | 打包测试使用 `out/中文 路径 smoke`，通过                                                                                                                                                                              |
| UI                           | 1440 桌面、390 手机、760 窄窗口及模型/任务表单已捕获；演示数据明确标识，仅在本地。六项独立审查修复通过，结论仅覆盖该修复批次，见 `docs/UI-REVIEW.md`                                                                  |
| 安装包                       | Forge Squirrel 构建成功；开发机静默安装退出码 0；构建/哈希记录在 `out/release-manifest.json`。当前环境为 Codex MSIX 宿主，不是干净 Windows                                                                            |
| GPT + 非 GPT 真实闭环        | 待用户配置两个可用服务和授权目标网站；不能以模拟模型适配测试代替                                                                                                                                                      |
| Chat / Responses 真实服务    | 两种适配单元测试通过；Responses 真实能力测试通过；真实 Chat 服务与完整浏览器任务闭环待验证                                                                                                                            |
| 扫码 / 外部确认 / 不支持验证 | 对话、短期图片、绑定/消费/复核代码已实现；真实扫码/外部确认及不支持类型的现场验收待执行                                                                                                                               |
| 崩溃、断网、休眠、锁屏       | D1 故障语义及打包进程基础测试通过；真实断网、睡眠恢复、提交时强杀等整机故障注入待执行                                                                                                                                 |
| 无 Node 的干净 Windows       | 待独立 Windows x64 环境安装、运行、升级、卸载；本机已有开发工具，不具备该验收条件                                                                                                                                     |
| 连续 7 天观察                | 未开始。须在本人授权网站及真实模型通过后执行，不可补写为通过                                                                                                                                                          |

源码走读补充：现有打包/安装 smoke 走 `apps/desktop/src/executor/entry.ts` 中的独立 Stagehand 流程，未调用 `runtime.execute()` 或 `ExecutorHost`，因此四类自建站操作通过不能替代完整调度、租约、检查点和恢复验证。源码测试的 D1 adapter 使用 Node SQLite stand-in，不代表已完成 Cloudflare D1 的真实并发验证。

开发机原生窗口的最后一次可视检查受系统锁屏影响，不能据此确认托盘、窗口关闭、显式退出和设备授权交互已完成现场验收。同版本重新安装也不等于跨版本升级验收。

## 现场验证表

当前第一批结果见本文顶部 2026-11-04 记录；更早的部署/安装汇总表保留原批次范围。

记录时补充日期、版本/安装包 SHA-256、设备环境、模型提供方与协议、任务/运行 ID、预期、实际和证据路径；不得记录 API Key、密码或验证码。

| 场景                                    | 状态                                | 实际结果/证据                |
| --------------------------------------- | ----------------------------------- | ---------------------------- |
| GPT 查询提取（Responses）               | 虚构站闭环通过；外部业务站待验收 | 2026-11-04，0.4.8，见顶部一次性/周期任务 |
| 非 GPT 普通表单（Chat Completions）     | 待执行                              |                              |
| 授权真实网站登录签到/监测               | 待执行                              |                              |
| 错误/过期/前导零/重复回复/多轮验证码    | 虚构信息回复前导零/大小写及单次消费通过；其余真实站待执行 | 0.4.8 协助＋批准；不是 CAPTCHA 现场验收 |
| 扫码完成后实际状态复核                  | 待执行                              |                              |
| 提交前/提交后崩溃与断网回传             | 提交后独立进程强杀与只读恢复通过；提交前/整机断网待执行 | 0.4.8，cancel 计数保持 1，见顶部运行编号 |
| 批准/拒绝与一次性/周期调度             | 第一批现场结果见顶部记录 | 真实生产网站与安装执行器，虚构站数据 |
| Renderer 重载不重启任务、旧进程消息隔离 | 代码守卫已实现；整机验证待执行      |                              |
| 干净 Windows 安装/升级/卸载             | 待执行                              |                              |
| 中文/空格安装路径                       | 待执行                              | 数据路径测试不能替代安装路径 |

## 七天观察

| 天  | 日期   | 任务/成功/失败/待核查/协助 | 证据与处置 |
| --- | ------ | -------------------------- | ---------- |
| 1   | 未开始 |                            |            |
| 2   | 未开始 |                            |            |
| 3   | 未开始 |                            |            |
| 4   | 未开始 |                            |            |
| 5   | 未开始 |                            |            |
| 6   | 未开始 |                            |            |
| 7   | 未开始 |                            |            |

安装包目前未配置代码签名证书。依赖审计修复了 Zod 与 Drizzle 的高危项；仍有 Forge/Squirrel 构建工具链的 moderate 间接依赖告警，未通过强制降级破坏固定 Stagehand/Forge 版本。不能据此宣称安全审计或正式发布验收完成。
# 多人改造阶段记录：邮件接入（2026-11-03）

- 已切换源码认证发信至 Brevo；Cloudflare `BREVO_API_KEY` 已确认是加密 Secret。域名 `mail.zhangheng.eu.org` 与发件人 `noreply@mail.zhangheng.eu.org` 已由 Brevo 验证。
- 使用生产 Secret 的临时远程预览调用 Brevo 账号接口返回 200，发信功能启用。经用户指定，仅向 `962271461@qq.com` 发送一封测试邮件；北京时间 18:27 的 Brevo 日志显示 `Delivered`。此项证明发信链路可用，不代替线上注册/重置全过程。
- 类型检查、完整 88 项测试、Web 构建、仓库检查和 `git diff --check` 通过。新增真实 Better Auth 入口测试覆盖邮箱未验证禁止登录、邮件验证、重置和令牌重复消费拒绝、密码变更后撤销会话；上游邮件为隔离模拟。多用户测试使用 SQLite D1 stand-in。
- 源码图更新完成（3940 节点、5677 边）；SQL 因缺少 `tree_sitter_sql` 未提取，`admin-panel.tsx`、`auth-gate.tsx` 被图工具报告部分提取。此为图工具覆盖限制，不能声称完整源码覆盖。
- 尚未执行多人版本生产迁移、开放注册、真实 D1 重置中断/并发测试、跨用户完整资源矩阵、设备迁移现场验收、真实执行恢复、Windows 0.2.0 打包安装及入口哈希验收。既有生产版本和 Access 仍保留，`REGISTRATION_OPEN=0`。

## 2026-11-03 多人网站正式部署与 0.2.0 执行器（注册关闭）

本节覆盖此前“尚未部署”的阶段记录，不表示全部开放验收完成。

- Worker：`474acbbc-c01e-4555-9261-c58070a2b9e9`；生产 D1 `0005_multiuser.sql` 已迁移。已有模型配置、密文和 `MASTER_KEY` 保留。迁移前业务表任务/账号/运行/设备均为空，模型用量等旧记录保留；完整 SQL 备份仅位于忽略的私有目录 `.cache/deploy-20261103/`。
- 管理员已在正式网站完成邮箱注册与真实验证链接，D1 确认 `emailVerified=1`、`legacy_owner/admin` 和有效会话。Brevo 发信密钥为加密 Secret。现有模型在新管理员接口完成真实连接、工具及严格 Schema 验证（10:42 UTC），模型预占额度与实际用量均归属 owner。
- 两个域名已统一应用认证。匿名 user/admin 返回 401；Bearer 访问 user/admin 返回 403；旧 `/api/device/user/snapshot` 返回 403；无令牌 `/api/device/status` 返回 401；health 协议 2。`cloud-self-check.mjs` 已移除临时设备管理旁路，改为上述公开权限检查。
- 独立真实 D1 临时库：真实 Better Auth adapter 登录及 member 绑定、非管理员拒绝；8 个并发模型预占仅成功 2 个；3 个同令牌密码重置仅 1 个成功、旧会话失效；注入密码写入失败时旧密码保留、令牌不可重放；2 个设备并发领取同一用户只成功 1 个，领取重试只计 1 次启动。临时预览和数据库均已清理。该验证没有给真实用户重置密码，也没有额外发信。
- 源码验证：`npm run typecheck`、`npm test`（91 项）、`npm run check:repo`、`git diff --check` 通过；网站构建及部署通过。跨用户回归覆盖真实有效的账号引用、任务聊天、含用量报告、协助回复、证据，以及相同创建幂等编号产生各自的任务。认证数据库异常测试确认响应和控制台均不泄露查询参数。
- `graphify update .` 已完成：3941 节点、5682 边、360 社区。缺少 `tree_sitter_sql`，5 个 SQL 文件未抽取；两个 TSX 文件被图解析器标记为部分抽取，TypeScript 检查通过。不得将图称为无缺口。
- Windows 0.2.0：完成 `npm run make`、本次 packaged/installed smoke，Stagehand 4.3.0 和原生加载通过。实际桌面快捷方式目标为 `%LOCALAPPDATA%/TaskRelay/TaskRelay.exe`，启动进程位于 `app-0.2.0/TaskRelay.exe`；窗口显示 0.2.0 独立执行器。安装/构建 `app.asar` SHA-256 均为 `3bbced238873bda3d42bc28b69595750071ef4eaf7711860882521dc03cc0bd8`。安装包 SHA-256：`62d1da1211960786605e999af16be7497c7a948a91bb51ce16528652f7276ccf`。清单 `out/release-manifest.json`；源码目前是未提交工作区，清单 sourceCommit 只是 Git 基线，不能当作本次完整源码提交。
- 本地升级前检查未完成 journal/outbox 均为 0，SQLite 文件已备份；升级后 schema 2、旧管理 cache 为空。管理员已明确批准“爸爸的电脑”，设备 `device_f4c4adc8068c4594ba35b8d118eb003c` 为协议 2，心跳在线。

### 真实 execute / ExecutorHost 路径

本次实际安装客户端、生产网站、D1 和美国模型链路共同参与；下面不是 smoke 结果。

1. `run_b95318b720cd4ab5af81ef153fc47d1d`：公网代理检查拒绝本机 Fake-IP，任务 failed，`write_pending=0`、`may_have_written=0`，未发生写入。`example.com` 当时解析为 `198.18.1.19`。
2. 用户明确允许仅调整 `example.com` 的真实 DNS。Clash Verge 全局扩展脚本为该精确域名增加 fake-ip-filter，保留现有条目和节点选择；重载后解析为公网地址。界面坐标偏移曾误选“韩国自动”，已立即通过本机接口恢复并核对为原“自动选择”。原脚本与配置备份留在 Clash 自己的配置目录，未写入仓库。
3. `run_53e07dbbe59d46ff9d97ddb63e3f4074`：能实际读取页面，但可见正文不包含原判据 `Example Domain`，程序没有误报成功。网站发起取消后运行进入 cancelled；无写入，账号锁释放。这验证了真实云端取消到执行器的路径。
4. 同一任务通过正常“调整任务 → 确认卡 → 保存并试运行”改为匹配实际正文。`run_121ccc7c79b7498d88db8ec32bc934b2` 于北京时间 18:58 成功；客户端完成加载、程序核验与证据回传，网站展示“已完成”。未登录、填写、提交或点击外链。测试站点正文不适合作为长期监控服务，本次没有创建周期任务。
5. 验收结束恢复 `claimsEnabled=0`，`REGISTRATION_OPEN=0`。三次真实运行均为终态，无排队/运行中任务、无账号锁；现场启动次数累计 3（失败/取消不返还），模型请求 21、创建/调整对话 2。成功截图：`.cache/deploy-20261103/website-execution-passed.png`。

### 尚未完成的开放门槛

- 两台独立物理 Windows 设备与两名真实用户的公平分配、账号固定设备、离线等待、迁移后重新登录；目前并发证据来自隔离真实 D1 和本机单设备。
- 完整 execute/ExecutorHost 的断网、进程重启、提交后结果未知及旧进程回传现场故障注入；已做的取消和安全失败不代替这些路径。
- 真实密码重置邮件链接和浏览器端流程、真实 Turnstile 令牌重放、完整手机/键盘/错误态复验。
- 干净 Windows 安装、非 GPT 完整浏览器执行、连续观察。公开注册与领取继续关闭，不因上述阶段通过而自动开放。

## 2026-11-03 配对提示修复部署

- Worker `ad744a3c-5dbd-435d-bc5f-06f2b77bbd91` 已发布；仅网站配对生命周期和提示修复，无数据库迁移或执行器重装。注册仍关闭，未调整领取开关。
- `npm run typecheck`、19 项 UI 测试、网站构建通过。源码图更新为 3954 节点、5719 边；原有缺少 SQL 解析依赖及两个 TSX 部分抽取的限制仍存在。
- 真实浏览器确认旧链接清理、中文过期说明、关闭与刷新不复现；设备连接和已完成任务保留。证据：`.cache/deploy-20261103/pairing-error-fixed.png`。本次未新增设备授权或任务执行。

## 2026-11-03 创建对话重复追问 HTTPS 修复

- 生产版本 `4c9080de-673d-4d2a-bfd1-0fd781667c5d`，后端识别 `www.baidu.com` 并补全 HTTPS；完整消息和确认卡流程保留。无数据库迁移，无客户端更新，未修改注册/领取开关。
- 类型检查、完整 102 项测试、仓库检查、网站构建和部署通过。真实 compose 路由回归覆盖 Chat Completions/Responses、多轮补充、草稿不落库、站点越权拒绝、助手消息不授权，以及无效/私网/带凭据地址。Hono CLI 健康检查通过。
- 源码图更新完成（3959 节点、5731 边）；缺少 SQL 解析器及两个 TSX 部分抽取的限制仍存在。
- 生产浏览器使用截图同样的两轮输入完成验收：每天查看网站上的最新信息 → www.baidu.com。真实模型转而追问具体信息、成功判据和时间，不再索要协议。该验收产生 2 次对话额度及 1 次模型请求，没有创建任务或运行；截图 `.cache/deploy-20261103/domain-compose-fixed.png`。


## 2026-11-03 LangChain / LangGraph 0.3.0 候选

当前为源码和候选产物验收，尚未发布新 Worker、安装替换系统 0.2.0 或执行生产清理。线上只读预检：1 台授权设备仍为协议 2；无进行中/unknown 运行、无账号锁，领取暂停。本机系统及 Codex 重定向数据目录的 outbox、未完成 journal、uncertain 均为 0；没有读取或输出设备令牌。

已完成：

- `npm run typecheck`、完整 **107 项测试**、`npm run check:repo` 通过。新增生产路径验证覆盖完整历史分页（205 条）、D1 typed checkpoint/pending writes/恢复、store 隔离与加密、同消息并发、旧版本拒绝、确认创建/修改幂等、摘要和用户纠正、unknown 报告事实、敏感回复隔离、调用结果先保存再 ACK、未知调用不重放、历史删除后禁止回填、额度继承、本地清理和设备升级前置条件。
- Web/Worker 构建通过；Hono CLI 调用实际 `app` 的 `/api/health` 返回协议 3。Wrangler 在隔离本地目录成功应用 0001–0006 迁移。这不代替真实 D1 并发测试。
- Worker 本地 startup profile 已生成，观测窗口约 146 ms，active 约 66 ms；这是本机 workerd 数值，不是线上启动时间。构建仍有前端 chunk 超过 500 kB、contracts 动静态重复导入提示。
- 共享界面真实 Edge 的桌面/390×844 夹具检查通过任务卡和记忆显式保存；细项与局限见 UI-REVIEW。
- 源码图更新成功：4060 节点、6113 边；仍缺少 tree_sitter_sql，两个既有 TSX 文件部分抽取。已包含切换脚本，不把解析缺口算成源码错误。

发布前仍需：新生产构建的真实 D1 并发、Chat Completions/Responses 真实模型与美国地区证据、系统入口 0.3.0 安装和 ASAR 校验、独立 Windows、完整 execute/ExecutorHost 故障注入、多设备和连续观察。清理入口会拒绝未知写入、锁、未就绪设备或活动 AI 回合；上述门槛未完成时不应添加清理命令的验证确认参数。没有改动 MASTER_KEY、账号凭据、模型密钥或设备授权。

证据文件位于忽略目录 `.cache/ai-full.log`、`.cache/ai-build-final.log`、`.cache/ai-migrations-final.log`、`.cache/ai-startup.log`、`.cache/ai-production-preflight.json`、`.cache/ai-remote-safety.json`、`.cache/ai-package-final.log`；文件仅表示实际对应检查，不将历史部署结果当作本次通过。


0.3.0 候选产物补充：`apps/desktop/out/make/squirrel.windows/x64/TaskRelay Setup.exe`（363012608 字节）已生成；包内版本与锁文件均为 0.3.0。构建 ASAR SHA-256：`DCEA21B5824AF81339DAA2E515C5EC1E856D80C325F48D4FFAC31A7A470A8B93`。本次 `npm run test:smoke` 通过，鲜活报告为 `out/packaged-smoke.json`；验证了打包后的 Stagehand 4.3.0、原生 ESM 加载和自建站读取/表单/验证码等操作。此 smoke **没有调用 runtime.execute 或 ExecutorHost，也没有调用真实模型**。尚无新版本安装目录 smoke、系统入口/安装 ASAR 对照或发布清单，不能视为已安装交付。

## 2026-11-03 0.3.0 部署与现场阻断

已部署和安装，但完整用户流程未通过，不能开放执行：

- 生产 D1 已应用 `0006_ai.sql`。首个 Worker 为 `b53be1f2-0884-43a5-bb9e-ec33e44ba4ff`，错误提示修复后的线上版本为 `c40a43b7-d26b-4658-bf12-8b35597212e6`。后者启动时间 56 ms；这不是请求 CPU 耗时。
- 通过系统资源管理器安装 0.3.0，随后从真实桌面 `TaskRelay.lnk` 启动。进程位于 `C:/Users/96227/AppData/Local/TaskRelay/app-0.3.0`；安装 ASAR 与候选哈希一致。新的 `out/installed-smoke.json` 通过，`out/release-manifest.json` 指向系统目录，无 LocalCache 重定向。
- 发现此前已授权数据实际在 Codex `LocalCache/Roaming/TaskRelay`，系统 Roaming 目录为空。停机核查两侧 outbox/未终结 journal 为 0 后，将原加密 config、已结束 journal、profiles 及对应 Local State 的 OS 加密上下文迁入系统目录；未解密令牌，未覆盖 schema 3，源目录保留。系统入口成功使用原设备授权升级为协议 3。
- 匿名及 bearer 越权检查通过。真实 D1 上运行与会话入口同样的版本 CAS 条件，两个并发更新的影响行数为 `[0,1]`，会话版本只增加一次；专用探针已删除。既有 Responses 模型的连接、工具及 Schema 能力测试通过，但这不代表 LangGraph 业务请求通过。
- 经用户授权执行历史切换。没有提取浏览器 Cookie；使用 Cloudflare 管理连接执行与 lifecycle 相同的 SQL 批处理，并额外在 guard 内比对已审查数量。阻断项为 0，证据表为 0，无 R2 删除。保留数量：用户 1、认证账号 1、认证会话 2、成员 1、站点账号 0、模型版本 2、设备 1、额度预留 33；历史表归零，3 次运行额度转存 quota_carry。客户端观察 historyEpoch=3 后自行清理 cache/journal，token/config/profiles 保留。
- 网站既有登录保持，记忆新增、修改及重新进入后的读取成功，D1 中测试偏好无明文匹配。任务原始消息刷新后保留。测试没有确认任务卡，没有新建任务或启动浏览器运行。
- 业务请求现场失败：Cloudflare 日志记录 compose 和 `/api/admin/settings/check?egress=1` 为 `exceededCpu`，HTTP 503/错误 1102。尝试配置 `limits.cpu_ms=1000` 被部署 API 以 **100328 / CPU limits are not supported for the Free plan** 拒绝；该配置尚未上线，线上仍是上述 c40a 版本。当前 Workers Free 不足以稳定承载本实现。用户已收到是否开通 Workers Paid 的选择，未代为开通订阅。
- 被中断的模型/对话保持 unknown，不自动重放。修复网站把所有非 JSON 响应误报为登录错误，以及成功刷新后遗留旧轮询错误。类型检查、19 项 UI 测试和 Web 构建通过；源码图更新成功，既有 SQL/TSX 解析限制不变。桌面执行器不引用 useThread，0.3.0 安装包未被同版本替换。

证据：`.cache/ai-live/deploy.log`、`deploy-fix.log`、`deploy-cpu.log`、`installed-smoke.log`、`ui-tests.log`、`events-sanitized.json`。本次尚未完成：LangGraph 成功生成确认卡、真实执行/报告、两协议完整闭环、协助流程、完整手机历史滚动、独立机器和故障注入。不能把旧版成功记录或 smoke 当作这些流程的通过证据。

最终安全状态：maintenance=1、claimsEnabled=0、公开注册关闭、historyEpoch=3。临时记忆已从真实网站删除并核对 ai_memories=0；保留 2 条 unknown 对话作为失败证据，没有新任务或运行。截图 `.cache/ai-live/memory-cleanup.png` 和 `cpu-limit.png`。等待用户处理套餐后继续，未宣布全流程通过。

## 2026-11-03 CPU 优化与线上复测

- 已部署优化版 Worker `56931d6b-6fc8-43ae-9741-bc3b18a457ec`，启动时间 54 ms。没有购买套餐，也没有改动密钥、协议或桌面安装包。
- 优化包括：按静态配置复用认证实例；使用原生 Base64 与紧凑 typed 检查点编码；缓存静态 JSON Schema；模型配置读取不解密凭据；历史预算线性裁剪；合并无外部动作的图节点。保留每次会话数据库校验、owner/版本守卫、同步检查点和美国出站链路。
- 同一批本机 workerd 合成请求，各组 24 次，crypto/checkpoint 每次 10 个往返。采样 active CPU 均值如下，包含本地 D1 绑定和 GC，不是 Cloudflare 请求计费数据，也不是线上 SLA：

| 路径 | 优化前 ms/操作 | 优化后 ms/操作 |
| --- | ---: | ---: |
| 已登录读取 | 9.01 | 8.30 |
| 加密往返 | 1.07 | 0.38 |
| 检查点往返 | 7.18 | 3.57 |
| 结构化图 | 32.65 | 25.24 |
| 创建对话入口 | 64.33 | 52.94 |

- 类型检查、110 项测试、仓库检查、Web 构建通过。新回归覆盖 typed 消息/旧检查点读取、AAD 隔离、认证配置隔离和配置读取不解密凭据。源码图更新至 4086 节点、6217 边；SQL 依赖缺失和两个 TSX 部分抽取的限制仍在。
- 真实网站提交了一条新的只读 example.com 草稿请求。仍返回 HTTP 503，tail 明确记录 `exceededCpu`，该事件报告 cpuTime=1930 ms、wallTime=10508 ms；随后 snapshot 也出现 cpuTime=10 ms 的 exceededCpu。这些是事件日志原值，不能据此把免费套餐硬阈值解释为 1930 ms，也不能用本地均值替代线上结果。
- 网站显示异常响应，没有确认卡，没有确认任务或启动运行。复测后恢复 maintenance=1，claimsEnabled=0、公开注册关闭、historyEpoch=3；D1 核对 tasks=0、runs=0、ai_memories=0。新中断回合交由原有 180 秒过期机制转为 unknown，不重发模型请求。
- 等待超时后通过网站重新读取历史，核对 ai_turns 共 3 条 unknown、active_turn 数量为 0，新增原始消息仍可见。此时 ai_calls 为 2 条 unknown、1 条 reserved，后者仍待定时清理，未人为改写或重放。
- 完整用户流程仍未通过。当前结果说明常规 CPU 优化有收益，但没有解决 Free 环境的线上阻断；后续需要用户开通适当套餐后重新验收，或另行评估更大范围的请求拆分，不能降低鉴权、检查点或出站约束以求通过。

证据：`.cache/ai-profile/workerd-before/summary.json`、`workerd-after/summary.json` 及各 CPU profiles；`.cache/ai-profile-deploy.log`、`.cache/ai-profile-tests.log`、`.cache/ai-profile-tail.jsonl`（只保留路径、状态、CPU/时长，不保存请求头、正文或密钥）；页面截图 `.cache/ai-live/cpu-after-optimization.png`。Node process.cpuUsage 的 Windows 粗粒度采样仅作探索，不作为上述对照数据。
