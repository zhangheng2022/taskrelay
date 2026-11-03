# 共享默认主题与 AI Elements 交互复验

最新批次为下方「AI Elements 改造」各阶段；前面的检查表是早先默认主题基线，不能替代最新包的安装、IPC 或真实网站验收。

日期：2026-11-03。以本地 Vite `/ui-fixture.html` 渲染真实共享 App，演示 Transport 不连接真实网站或模型。此前独立审查的旧布局记录保留在 Git 历史中，不能代替本次布局证据。

## 实现

- Web 和 Electron Renderer 共用官方 shadcn/ui 默认中性色、浅色/深色/系统主题，移除旧品牌色全局控件覆盖。
- Sidebar 选择任务；Message/Bubble/MessageScroller 展示对话；底部 InputGroup 输入；实际步骤使用可折叠 Trace。没有模拟模型的思考过程。
- 一句话创建，缺失信息继续补充，确认卡展示目标、网站、账号、时间、授权和判据。详细编辑只更新确认卡；点击“创建并试运行”才保存。
- 普通对话不修改授权；“调整任务”生成草稿，确认后保存并重新试运行。未知结果保留账号锁与只读核查入口。
- 敏感协助直接发送到绑定接口，不追加为聊天消息。离线、过期、不支持和已回复状态禁用回复。

## 已执行检查

| 场景 | 结果 |
| --- | --- |
| 1280×800 桌面、390×844 手机、760×700 窄窗口 | 布局可用；手机 DOM 无横向溢出；修复模型说明被按钮挤成竖排的问题 |
| 缺少网址 → 补充网址 → 生成确认卡 → 编辑标题 → 创建 | 成功进入任务对话；补全期间侧栏无新任务 |
| 首次请求超时再重试 | 中文错误提示，保留原输入，重试生成确认卡 |
| 协助演示回复 | 发送后切回普通对话，输入清空，页面文本中不存在演示验证码 |
| 步骤和费用 | 展开实际事件及时间，未配置费用显示“未知” |
| 键盘 | Enter 发送；Shift+Enter 仅换行；设置 Tabs 方向键切换；Escape 关闭模型 Dialog |
| 手机设置和弹窗 | 设置列表分行；模型表单可滚动；标签关联输入框 |
| 桌面专属演示状态 | 暂停领取、自启动、停止和诊断入口保留；离线显示缓存并禁用云端操作 |
| 浅色/深色 | 切换有效，共用默认语义色；跟随系统监听已实现 |
| 热更新后整页重载 | 未出现新的运行时错误；开发中曾有一次 effect 依赖数量变更的 HMR 警告，重载后未新增 |

本机截图：`out/ui-review/mobile-chat.png`、`out/ui-review/desktop-proposal.png`。截图与演示数据均不是生产任务证据，不提交构建/截图产物。

上线后另用已登录浏览器确认 `tr.zhangheng.eu.org` 已加载新版共享 UI，截图为 `out/ui-review/production-domain.png`。该页面真实模型请求的地区失败单独记入 ACCEPTANCE，不属于本地演示通过项。

## 验证边界

本次浏览器交互验证没有使用真实模型、真实目标网站或桌面 IPC。中文输入法组合态保护由代码检查确认，未进行实体输入法候选框现场测试。原生托盘、干净 Windows、跨版本升级、真实断网/休眠和七天观察仍以 ACCEPTANCE 台账为准。首次包构建与打包 smoke 单独记录，不能用它们代替这些现场验证。

## AI Elements 改造 · 第一阶段（2026-11-03）

共享会话采用 Message / muted Bubble、InputGroup 和 Marker；模型选择采用 DropdownMenu RadioGroup，显示真实协议、配置版本及能力。Suggestion 直接发送需求，缺失信息由现有 compose API 追问；发送中显示本轮用户消息，失败恢复输入，草稿仍须明确确认后才创建。详细编辑作为次级入口。

组件 registry 从旧 `new-york` 切换为当前 `radix-nova`，用于获取现行 AI Elements 组件；没有整体覆盖主题、Button 或 Separator。结果仅显示纯文本，无需引入 Shiki 高亮运行依赖。

已通过类型检查、Web 构建及 4 个真实 React 组件测试：Enter/Shift+Enter/IME、快捷建议与创建边界、确认失败的同一幂等请求重试、任意模型名及能力禁用。浏览器夹具已验证建议 → 缺网址追问 → 输入网址；模型传输保持原有 Transport。其余执行/协助与双端检查在后续阶段记录。

## AI Elements 改造 · 第二阶段（2026-11-03）

`run-report.tsx` 使用一个 Trace 组织实际事件、证据和用量，每条事件可独立展开；CodeBlock 展示真实摘要、错误及结果。未知费用保持“未知”，结果未知时保留只读核查入口。`challenge-panel.tsx` 按 Confirmation 的 Item pattern 呈现完整操作与选择：确认提交原后端的显式确认文本及运行/步骤/版本/租约，拒绝请求取消本次运行，界面等待云端确认停止。扫码按钮仅请求检查实际状态。

协助输入按绑定与状态隔离，切步骤、租约或过期即清空；已成功提交的步骤在刷新期间也不能再次提交。敏感内容不加入消息，普通聊天失败保留同一请求标识；旧轮询响应不能覆盖刚完成的对话。

已通过 13 项 UI 组件测试，其中 9 项覆盖执行与协助行为。此前全套 80 项通过，新增的执行报告测试单独通过；最终全套数量以交付验收为准。Web 构建通过，390×844 浏览器确认卡无横向溢出，拒绝操作显示“已请求取消，等待执行器停止”。演示 Transport 不代表真实网站验证。

## AI Elements 改造 · 第三阶段（2026-11-03）

最终源码检查：82 项测试通过，其中 14 项挂载真实共享 UI 的行为测试；typecheck、Web/Worker build、check:repo 通过。键盘复验发现发送期间 disabled 会丢失焦点，已改为只读，发送/模型按钮仍禁用；补充测试确认 IME、不重复发送及回复完成后继续输入。协助输入上限与后端 4000 字符一致，保存中与失败后的重试使用不同文案。

| 场景 | 本轮证据 |
| --- | --- |
| 手机 390×844 | 超时保留输入 → Enter 重试 → 编辑标题 → 更新确认卡 → 明确创建 → 进入任务对话；DOM 宽度与 scrollWidth 同为 390 |
| Confirmation 手机布局 | 完整显示操作、确认和拒绝；拒绝后仅显示取消请求，不宣称执行器已经停止 |
| 窄窗口 760×700 | 验证码错误可修正，正确回复清空输入并进入等待实际核验；普通输入与执行结果布局可用 |
| 历史滚动 | 24 条消息，上翻后经过轮询仍保持 scrollTop=1440；点击“回到最新消息”返回尾部 |
| Trace / CodeBlock | 逐条展开事件；失败事件默认展开；结果为可复制纯文本；用量为真实数值或未知 |
| 离线 | 缓存结果可读；输入和调整任务禁用，显示恢复/重试提示 |
| 模型菜单 / 键盘 | 显示真实非固定名称、Responses/v2/能力；菜单 Escape 关闭；Shift+Enter 不发送，Enter 发送；IME 组合态由组件测试验证，未测试实体候选框 |
| 线上模型 | `tr.zhangheng.eu.org` 的真实 `gpt-6-luna / Responses` 生成待确认卡；没有点击生产“创建并试运行”，没有新增生产任务 |
| 真实 Electron 窗口 | 独立未配对数据目录启动打包 TaskRelay.exe，默认深色共享界面、设备设置、默认关闭自启动正常呈现；未配对、未启动任务。原生点击被系统输入保护中断，暂停开关、托盘等未记为通过 |

证据：`out/ui-review/ai-elements-production-proposal.png`、`ai-elements-mobile-confirmation.png`、`ai-elements-mobile-created.png`、`ai-elements-narrow-run.png`、`ai-elements-native-desktop.png`。除线上草稿外，浏览器场景使用明确标记的演示 Transport。打包/模型地区详情以 ACCEPTANCE 的最新批次为准。

本轮沿用 shadcn 与 React 最佳实践技能；文档基准为 [AI Elements](https://ui.shadcn.com/docs/ai-elements) 及对应 Radix patterns。保留美国 jurisdiction → 单次 submitAndWait → alarm 出站链路，云端模型、协议、认证和调度代码无变更。Graphify 源码图已更新；SQL parser 缺失警告不代表 SQL 已被图工具解析。现有 Vite 大 chunk 与静态/动态混合 import 提示未被掩盖，不影响本次构建通过。

## 已安装界面与交付入口修正

用户截图仍显示绿色旧首页。检查已安装 `app.asar` 后，确认它与旧基线哈希一致；新 Web 或直接运行构建 exe 的结果并未更新该入口。桌面版本已提升为 0.1.1，暂存运行包同步版本，重新构建 Squirrel 并安装。

Codex 宿主中 `%LOCALAPPDATA%` 会重定向到自己的 `LocalCache`。另通过 Windows 系统运行入口安装、从桌面 `TaskRelay.lnk` 启动后，原生窗口清单确认路径为 `C:/Users/96227/AppData/Local/TaskRelay/app-0.1.1/TaskRelay.exe`，没有 `LocalCache`。实际窗口的任务侧栏、模型设置已显示新版默认中性主题。系统版本未配对，未启动生产任务；不把该检查描述为真实任务执行或托盘验收。

版本、产物哈希、安装 smoke 及数据目录的验证范围见 ACCEPTANCE。发布规则已增加版本递增、实际快捷方式、解析路径和安装 ASAR 比对，防止把构建目录或重定向副本误报为用户安装版本。

最后从 Windows 系统入口获取的 ASAR 哈希与构建一致，系统安装目录的独立 smoke 也通过；两份记录分别为 `out/system-hash.json`、`out/system-installed-smoke.json`。线上最终聊天主页为 `out/ui-review/ai-elements-production-final.png`。
