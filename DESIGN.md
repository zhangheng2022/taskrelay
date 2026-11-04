# TaskRelay 设计入口

网站承载用户任务、对话、确认与结果；Windows 客户端仅为独立执行器。旧版绿色工作台及双端任务编辑设计已被当前产品方向替代。

- 产品目标与职责：[PRODUCT.md](PRODUCT.md)。
- UI 组件与交互约定：[AGENTS.md 的 UI 专项要求](AGENTS.md#ui-专项要求)。
- 主题与布局实现：[共享样式](packages/ui/src/styles.css)、[网站工作台](packages/ui/src/app.tsx)、[执行器界面](packages/ui/src/executor-app.tsx)。
- 实际界面检查与未验证范围：[UI-REVIEW.md](docs/UI-REVIEW.md)。

颜色、字号、间距和断点以当前源码为准，不在本文件复制第二套数值规范。默认中性色及浅色、深色、系统主题沿用共享语义 tokens。
