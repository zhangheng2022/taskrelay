# UI 实现与检查

## 当前界面

网站使用 packages/ui 的 App、TaskCompose、Conversation、Settings；桌面使用独立 ExecutorApp。共用主题和原语，桌面没有网站的聊天与编辑功能。设备配对确认仍在网站 PairingNotice 完成。

聊天使用 shadcn/ui AI Elements 的 MessageScroller / Message / Bubble、InputGroup 与 Composer、ModelSelector。执行过程按运行合并到 Trace，展示调用次数、读取次数与最后更新时间；展开可查看所有真实记录和脱敏反馈，内部反馈仍可展开。协助问题和最终回复独立显示，重复通知按消息 ID 合并，不能把相同文案的新问题吞掉。交办、执行补充和协助共用输入框；Enter 发送，Shift+Enter 换行，中文组合输入不发送。模型、加载、失败、离线和停止取自真实状态。

本轮移除未被当前产品入口使用的 TaskEditor、RunConditions、RunReport 和 ChallengePanel，设置所需 Field 单独保留。CSS 由宿主入口加载；应用组件可直接挂载测试。

- 侧栏“待协助”读取 execution_help 对应的 waitingHelp，不再读取旧 challenges。
- 从历史记录进入同一聊天，停止始终绑定当前活动运行；历史选择不会重建聊天并丢失输入。
- reported 显示“已回复”，避免把部分完成/受阻报告标为全部完成。
- “调整任务”在菜单关闭后聚焦消息输入框；有活动运行时不能重复点立即运行。
- 无已确认条件的任务不显示调度开关，保存偏好明确说明尚未用于执行。
- 任务详情只说明当前目标、网站、账号、时间和结果报告方式，不把旧 allowedActions 或核验限额展示为当前门槛。

## 2026-11-05 检查范围

本轮完整测试含实际共享组件与 Transport 请求，覆盖当前运行停止、待协助标记、reported 标签、统一回复、截图、恢复读取、消息重试、Enter/Shift+Enter/IME 事件，以及配对确认。完整命令与结果见 [ACCEPTANCE](ACCEPTANCE.md)。

已读取官方 AI Elements 与 Input Group 文档并核对 components.json / 已安装原语。shadcn CLI 的 info/docs/diff 请求因 TLS 失败，未取得在线差异，本轮没有升级组件依赖。

用户要求不控制电脑，实际浏览器/桌面交互检查已停止。本轮**未执行**手机、窄桌面、键盘/真实输入法、历史滚动、主题布局和实际 Electron 视觉验收；JSDOM 通过不能代替这些检查。早期截图与检查结果可从 Git 历史追溯，不作为本轮通过证据。

## 开发预览

2026-11-05 修复后的开发 Transport 按当前 `modelId` / `taskId` 合同创建聊天，任务绑定后载入演示历史、协助和结果。它已独立于页面挂载入口，可直接用于实际 App 回归；不再依赖请求中不存在的 `kind` 字段。

生产 useThread 的最新页刷新与发送保留已加载历史游标，包括已读到底的 null；有新窗口缺口时回补，旧历史请求仅推进自己的边界。Web Transport 的所有订阅共享通知连接，旧连接回调不能操作新连接；隐藏、离线和最后退订清理连接与重试。实际 hook/Transport 回归覆盖上述交错；本轮未开展手机布局、真实输入法或 Electron 视觉检查。

开发服务器仅监听本机。/ui-fixture.html 使用演示 Transport，不访问生产服务；/ui-review.html 用 390 与 768 宽画布展示手机和窄桌面。相关入口不会进入生产构建。

| 入口参数 | 检查场景 |
| --- | --- |
| ?state=new | 新任务 |
| ?state=challenge&history#demo_task | 当前协助与长聊天 |
| ?state=failed&history#demo_task | 历史未知结果 |
| ?state=running#demo_task | 当前运行与停止 |
| ?network=slow | 慢加载 |
| ?network=fail-once | 首次读取失败与重试 |
| ?fail=1 | 消息发送失败 |
| ?auth | 登录页 |
| ?executor&state=offline | 执行器断连 |
| ?executor&update=waiting | 更新等待状态 |

演示页回复不创建真实任务、不调用模型、不执行安装。旧创建确认、拆分挑战回复和独立报告演示已移除。
