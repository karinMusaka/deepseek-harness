# Agent Note: 静态双半包，启动时从磁盘装载

Status: implemented

[English](2026-09-10-static-dual-half-packages.md) | 中文

## Problem

`cordis_define` 出的动态包（参见[自引用工具集](../../implemented/feature/2026-07-08-self-referential-cordis-toolset.md)）只活在 host 进程的内存里：一次重启就会忘掉每一个定义，而浏览器半也从不会在页面刷新时恢复——一个页面只在有人回答了一条全新的 `cordis/request-run` 时才会运行它。这对工具集自己的信任模型是对的（每次运行都由一个人来授权），但也意味着一个由 chat 会话写出并反复打磨过的包，活不过定义它的那个进程。

推荐的晋升路径——经[客户端插件装载模型](../architecture/2026-07-23-client-plugin-loading-model.md)把包重写成一个带类型化 `@Remote` 方法与已构建 TSX bundle 的普通 Cordis 插件——要花掉真实的工程时间：对于已经在日常使用中的、约七千行的双半包来说是数周。这条路径还会重新发明动态运行时已经有的机制：host 半的 `node:vm` 沙箱与注册 guard,以及浏览器半的闭包求值、模块就位与拆卸。一个在求值模型上没有正确性理由需要改变的包，不该被逼着走这条路。

## Decision

`@deepseek-ai/dsh-cordis-static-packages` 是一个启动时的 loader,面向保存在磁盘上、以 `cordis_define` 所接受的同一种动态包方言写成的双半包。它的 `packages` 配置字段列出 `{ id, name, sourceDir, host?, client? }` 各行；构造时校验它们（重复的 id、相对路径的 `sourceDir`,或者两半都没配名，都会让构造函数本身抛出），并读取、求值、挂载每一个已配置的 host 半。

host 半求值直接复用 [`@deepseek-ai/dsh-cordis-host-runner`](../../../../packages/extensions/cordis-host-runner/README.md) 的原语：`createSandbox`、`evaluateHostCode`、`startHostHalf`、`isPlugin` 与 `normalizeHandler`,如今从该包导出正是为了让静态 loader 共用它们，而不是重新实现一套沙箱。因此一个静态 host 半运行在与 `cordis_define` 出的包完全相同的 `node:vm` 超时与注册 guard 之下；一个从 chat 会话晋升出来的包能保留原有行为不变。任一包的读取／求值／挂载失败都会记在该条目上（`hostState: 'failed'`、`error`）,并经 `ctx.logger.error` 记日志，而从不抛出——一个坏掉的包绝不能连累其他包，因为 loader 带起的是一份运维方审定过的清单，而不是一次模型发起的单次调用。

配置文件就是运维方的授权。与 `cordis_define` 的 run 往返不同，这里不会逐次向人发问：把某个包的 `sourceDir` 列进 `cordis.yml`／`cordis.patch.yml` 再重启进程，就是完整的批准动作，与自引用工具集 Agent Note 已经赋予动态包的信任立场一致。注册表本身与动态 runner 一样，只是进程内存；磁盘上的源文件才是唯一的持久状态，编辑它们要在下一次重启才生效，而不是实时生效。

浏览器半由 `@deepseek-ai/dsh-cordis-static-packages-client` 装载，这个客户端插件经 `staticCordisPackages` Remote namespace 列出已配置的包，取回每个浏览器半源码，并经 `@deepseek-ai/dsh-cordis-client-runner` 的 runner 契约面装载它——而不是直接 import 那个包的运行时模块，因为在客户端插件装载模型下，插件对插件的取值 import 是构建错误；`ctx` 服务才是受准许的路径。为此，那个 runner 契约面新增了两个扩展点：`load(half, overrides?)` 接受 `DynamicCordisLoadOverrides`(`invoke`、`reportGuardFailure`、`reportRenderFailure`),让一个不属于任何 host-runner 定义的浏览器半，能把 `host.call` 与失败上报路由给静态客户端，而不是 host-runner 那套按 Agent 限定的路径；`unload(pluginId, pluginRunId)` 是静态包所需的可等待拆卸，因为它没有 host 侧的 stop 可以播报一条 `retract` 事件。`ctx.dynamicCordisRunner.loadStatic`／`unloadStatic` 就是这个契约面面向静态包的两个包装。

`packages/api/remotes` 把 `staticCordisPackages` namespace 与既有的 `dynamicCordisRunner` 一并挂载，`packages/bundle/web-app` 的 patch 发布了这两个新行——host 行带一份空的 `packages` 列表，因此一次部署经自己的 `cordis.patch.yml` 按 id 覆盖这一行的 config 来列出自己的包，与其他每一个组合包行使用的是同一套覆盖机制。

## Alternatives considered

**全面重写成静态插件。** 作为每个包的默认路径被否决：对于维护者希望往后都用类型化 `@Remote` 方法与已编译 bundle 的包来说这是对的，但对于让一个已验证过的 chat 撰写的包活过重启这件事来说，这并不是必须的。静态 loader 不会挡住之后的重写；它只是移除了立刻重写的虚假紧迫性。

**在启动时把每个静态包重新 define 进动态注册表。** 曾考虑过，因为这样能原样复用动态 runner 的注册表。被否决：`runHostHalf` 要求拥有该定义的 Agent 的授权上下文，而这份注册表的内部约定假定的是一次模型发起的 `define`／`run` 配对，所以在启动时重新 define 仍然需要一次页面侧的 run 请求，实际上等于每次重启都要有一次批准——正是这个 loader 想要去掉的那份摩擦。

**保持包动态，另配一个恢复 skill。** 被否决：它每次重启仍要花一条 chat 消息加上按包数量的 N 次批准，外加每个已打开页面一次手动刷新点击，而这些都是一份配置文件不需要再付一次的代价。

**仓库之外的一个 profile 包，提供一条 HTTP 路由。** 被否决：类型化 Remote namespace 只为仓库内的包生成，所以这条路径需要在共享 tsdown preset 之外手写一套客户端 bundle 构建，重复了 `dsh-cordis-client-runner` 已经免费提供的机制。

## Consequences

一个已配置的包能活过一次进程重启，一旦它的 host 半重新运行起来，每个重新连接的页面都会把它取回并重新装载——不存在显式的「恢复」步骤，因为除了再跑一次 loader 之外没有别的东西需要恢复。代价是一个静态包的 `id` 与动态 runner 的模块 id 空间共用，所以静态 id 与 chat 会话中定义的 id 不能撞名，而热编辑也没有了：改一次 `host`／`client` 文件需要重启进程，不像 `cordis_define` 调用那样在下一次运行时就生效。操作 `cordis_define` 出的包的那个面板里，也没有静态包对应的一行；一次启动期失败只能经 `list()` 或进程日志看到，没有任何主动推送。这个决定明确摆出来的取舍是授权粒度：工具集那套逐次运行的人工批准，变成了一次性的、配置文件级别的决定——这适合一个运维方已经审过、希望无人值守运行的包。
