# Agent Note：composer 模型选择器的按模型显示/隐藏

Status: implemented

[English](2026-09-24-model-picker-visibility.md) | 中文

## 问题

composer 模型选择器与 `/model` 弹窗会列出每个已配置提供方公布的每一个模型，用户没有办法把这份列表裁剪到自己实际会用的模型。一个配置了多个提供方 catalog 的用户（一条服务几十个模型的 pi-ai 路由、DeepSeek 自己的 catalog）每次打开都会看到一份冗长且不分主次的菜单。settings 界面此前没有任何持久化的按模型偏好，而两个选择入口（`ModelSelect` 与 `/model` popupSelect）本来就共用每会话一份的 `ModelDirectory`，因此任何修复都必须落在这一个共享点上，而不是在每个入口各自的渲染逻辑里各写一遍。

## 决策

`ModelDirectory`（`packages/client/ui-model-selection/src/client/directory.ts`）是唯一的执行点：它按照一份持久化的 `hiddenModels` 偏好过滤两个选择入口都渲染的建议 `groups`，除此之外什么都不做——`session.models` 与 `session.selectModel` 保持与 Host 公布的完全一致。过滤放在客户端而非服务端（`packages/host/apiproxy/src/api-proxy.ts` 中的 `buildModelCatalog` 未被触碰），因为 Host catalog 明确是建议性质——现有 README 文案早已确立目录成员关系从不影响可路由性——把影响路由的 catalog 与只影响展示的偏好分处两层，意味着一个仍是某人当前选择的隐藏模型能照常经由未过滤的 Host 响应路由，wire 层无需任何特殊处理。

持久化 namespace（`ui-model-selection`，字段 `hiddenModels: Record<provider, string[]>`）由 `ui-model-selection` 自己的 node 侧（`packages/client/ui-model-selection/src/index.ts`）注册，完全遵循 `ui-theme` 的模式：`ctx.inject(['settings'], …)` 包裹 `settings.register`，schema 与常量放在两个插件半区共用的小模块（`src/model-visibility-settings.ts`）里。渲染选择器的包持有控制它的那个 namespace，这与 `ui-theme` 为自己的 Appearance 行持有 `ui-theme.preference` 如出一辙——一个功能持有自己的 settings 界面。`ModelDirectoryResolver`（撑起每个会话 `ModelDirectory` 的每连接服务）为这个 namespace 绑定**一份**共享的 `ctx.settingsScope` scope，因为该偏好是用户设置而非会话事实，并把它传入自己构造的每一个 `ModelDirectory`。每个目录私下保留上一次成功加载的**原始**（未过滤）`groups`，并在每次新加载／选择之后，以及共享 scope 的快照每次变化时重新推导**要展示**的 `groups`——这是一次无需网络的重新过滤，与 `ModelDirectoryResolver` 另一条「`settings/document-updated` → 整体重新加载」路径解耦；后者是为了应对无关的 catalog／拓扑变化而存在的，与该 scope 自身的刷新彼此独立地竞速。

当前选择被豁免于隐藏之外：`filterGroups`（`packages/client/ui-model-selection/src/client/visibility.ts`）永远不会移除会话当前选中的那个精确提供方／模型对，只会在下一次 `select()` 时重新推导出一个不同的选择。没有这项豁免，用户就可能隐藏自己正在使用的模型，导致触发器悄悄回退成「选择模型」——这与真正的 catalog 加载失败无法区分，而选择器自身的既有约定早已禁止在「不再公布但仍是当前选择」这一相似情形下出现这种表现。

每一种未就绪状态都遵循「失败即开放」（fail-open）：`ModelDirectory` 读取该 scope 的 `getSnapshot().status`，只要不是 `'ready'`（加载中、`'unavailable'`，或远程浏览器的进程内 `'memory'` 模式），就视为隐藏集合为空。选择器绝不能因为这项偏好自身的传输通道缓慢、缺失，或在当前会话的连接模式下不受支持，而变得空空如也。

`@deepseek-ai/dsh-client-ui-settings-models` 的 Models 页面是唯一的写入方：新增的「选择器中显示的模型」分区列出未经过滤的 Host catalog（`llm.models`，与任何会话自己的建议目录无关）中的每一个提供方分组，每个模型一个复选框，外加每个提供方的全部显示/全部隐藏控件，直接对 `ui-model-selection.hiddenModels.<provider>` 写入 `settings.mutate` 路径 op（某提供方列表清空后用 `unset`，否则用带完整数组的 `set`），并在成功与 `settings-conflict` 两种情形下都重新加载整份页面快照。它无法引入 `ui-model-selection` 的 namespace／字段常量——`packages/client/AGENTS.md` 中对插件包的跨包引入禁令普遍适用，而 `dsh-client-ui-settings-models` 自己的 `apiKey.ts` 早已为 `normalizeApiKey` 的孪生体记录了同样的解法——因此 namespace id 与字段名是带说明注释的镜像字符串字面量，与该页面已经用于 `llm-deepseek`/`llm-pi-ai`（同样不属于它的 namespace）的做法一致。

任务原文里「ja/zh/en」的字面要求被收窄为 zh/en：本仓库没有任何客户端包定义 `ja` locale，`LocaleNamespaceMap` 也没有日语变体，产品文案规则是「中文产品文案；英文注释」——新增第三套 locale 机制没有其他消费方，超出本次改动范围。

## 考虑过的替代方案

**在 `buildModelCatalog`（Host 侧）过滤。** 已拒绝：`session.models`/`llm.models` 是多个界面都会读取的建议性 catalog 约定（选择器本身，以及现在这个用来展示「全部未过滤模型以便取消隐藏」的可见性分区）；把展示偏好并入其中会让 settings 页面自己的「展示全部模型」列表把自己过滤掉，还需要在每次构建 catalog 时都做一次按会话读取按用户偏好的操作。

**在 `ModelDirectory` 内部为每个会话各绑定一份 `settingsScope`。** 已拒绝：该偏好是用户设置而非会话事实，因此在长期存活的 `ModelDirectoryResolver` 上共享一份绑定才是正确的生命周期——避免了每打开一个会话就多一次 `settings.describe` 往返、多一个推送事件监听器，去表达本该是同一份持久值的东西。

**一个两个包都导入的共享 `filterGroups`/`isModelHidden` 模块。** 在核查了客户端 bundle 纯净性关卡（`packages/client/tsdown.client.ts`）与 `packages/client/AGENTS.md` 的导出纪律规则后已拒绝：插件包之间的跨包值引入在 slot/service 之外一律禁止，而 `ui-settings-models` 其实根本不需要过滤逻辑本身（只需要对自己读到的 `hiddenModels` 做一行隐藏集合成员判断）——镜像这两个小字符串常量是相称的；schema 与类型模块的共享仍然只停留在包内，与 `ui-theme/src/theme-settings.ts` 完全一致。

## 后果

隐藏一个模型是纯粹的展示偏好：它从不触及 `session.selectModel`、已组装的请求，也不影响一个已经是当前选择的模型的可路由性，并且它是按用户设置文档整体生效，而非按会话（`packages/client/ui-model-selection/README.md` 的已知限制现已记录这两点）。包测试覆盖了纯过滤辅助函数（`tests/visibility.client.spec.ts`）、目录「无需重新加载即时重过滤」的行为与 fail-open 路径（`tests/browser-plugin.client.spec.ts`）、host namespace 的注册与释放（`tests/host.client.spec.ts`）、settings 页面 store 的软 catalog 加载（`tests/store.client.spec.ts`），以及新分区的渲染/切换/批量切换/冲突行为（`tests/model-visibility-section.client.spec.tsx`），外加一个证明该分区的 `reload` 回调确实会触达真实 `ModelsSettingsStore.load()` 的集成测试。本次未新增无密钥的 web 浏览器快照场景：要表达「在 settings 页面勾选后观察到 composer 选择器变化」这样的跨界面旅程，需要一份录制好的 fixture，或者当前快照测试框架尚不具备的多界面支持——这是一个已上报的缺口，而非已实现的部分。
