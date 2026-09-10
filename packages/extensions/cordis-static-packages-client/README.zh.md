# @deepseek-ai/dsh-cordis-static-packages-client

[English](README.md) | 中文

静态双半包的浏览器半。激活时向 `staticCordisPackages` namespace 询问 host 装载了哪些包，取回每个浏览器半源码，并经动态包 runner 的契约面（`ctx.dynamicCordisRunner.loadStatic`）就位，`host.call` 路由到静态 loader 的 `invoke`。在 dispose 时卸载它们。这里不会向任何人发问：host 的配置文件已经授权了每一个包。

## 功能

`apply` 经 `ctx.remote.staticCordisPackages.list()` 列出包，然后对每一行带浏览器半且 host 状态不是 `failed` 的包，取回 `clientSource(id)`，并调用 `ctx.dynamicCordisRunner.loadStatic({ pluginId, name, code, invoke, reportGuardFailure, reportRenderFailure })`。`invoke` 路由到 `ctx.remote.staticCordisPackages.invoke(id, method, args)`；一次路由拒绝或 handler 出错都会变成一条点名调用与出错阶段的教学 `Error`。`reportGuardFailure` 与 `reportRenderFailure` 只写浏览器控制台，不走任何 host RPC——静态包没有归属的 Agent 可以上报。dispose 时，这一页装载过的每一个 plugin id 都经 `ctx.dynamicCordisRunner.unloadStatic` 卸载。

列表失败、取源码失败、源码不可提供、或装载失败都会写到浏览器控制台，并跳过那一个包；其他包照常装载。

node 半（`src/index.ts`）是一个空的 `apply`——它存在只是为了让这个插件出现在 host 的 `cordis.yml`／Loader 中；浏览器半经 `exports["./client"]` 发布，由 package.json 的 `dsh.client` 声明发现。本包从不为取值 import `@deepseek-ai/dsh-cordis-client-runner` 或 `@deepseek-ai/dsh-cordis-static-packages`，只 import 类型（`ctx.dynamicCordisRunner` 契约面的类型与 `StaticCordisInvokeResult`）——跨包的插件对插件取值 import 是构建错误，所以到达 loader 的受准许路径是 `ctx.dynamicCordisRunner` 服务。

## 模型体验

没有，因为本包只把 guard 与渲染失败写到浏览器控制台；它撰写的任何东西都不会到达模型。

#### KV Cache 影响

没有。本包既不发送也不接收任何模型可见内容；一个已装载包自己的 host 半才拥有它注册的任何工具或上下文效果。

## 已知限制与暂缓事项

- **只在激活时装载一次，从不重新同步。** 本插件激活之后 host 上新增、移除或改动的包，在没有页面刷新的情况下不会被拾取。
- **不重试。** 某个包的一次列表、取源码或装载失败不会被重试；只有页面刷新会再试一次。
- **失败只写浏览器控制台。** 这里不会把装载失败上报回 host 或任何模型可见的界面。
