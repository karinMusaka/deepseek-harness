# Agent Note: 跨会话记忆——storage-domain 服务加 runtime-context 工具消费方

Status: implemented

[English](2026-09-24-cross-session-memory-service-and-tools.md) | 中文

## Problem

在此之前，harness 中没有任何机制能让 agent（智能体）记住一个跨越会话生命周期的事实、偏好或决策。`dsh-goal` 与 `dsh-tool-todo` 确实持久化状态，但那份状态活在一个会话自己的日志里，对任何其他会话都不可见。[`examples/mcp-memory`](../../../../examples/mcp-memory/README.md) 展示了实现跨会话记忆的唯一既有路径：一个运行在进程之外的第三方 MCP 服务器，只有当模型显式调用该服务器自己的写入／搜索工具时才会被触及。

一条进程内的路径需要：一个由进程内每个会话共享的持久存储；一种将其暴露给模型的方式；以及对既有约束的回应——任何面向模型的内容都必须能从 session 日志重建。一个系统提示词段落在每次组装时都会从活的插件状态重新构建，其本身并不会被记录，因此若把召回的记忆渲染成一个段落，模型将看到任何后续回放都无法恢复的文本。

## Decision

`@deepseek-ai/dsh-memory` 是一个覆盖在 `ctx.storageDomain` 之上的 host-plane 单例 `Service`（`ctx.memory`）：`memory` 存储 domain 中的一张 `entries` 表，每个进程只打开一次，由每个会话共享，承载个人（`scope: 'user'`）与逐项目（`scope: 'project:<path>'`）条目。它是覆盖在既有能力之上的一个普通服务，而不是一个能力 seam：`storage-domain` 已经提供了可替换的底层后端，而 memory 本身只有一种实现，当下也没有第二个提供方需要它，因此在此拆分 Service Definition／Provider／Consumer 角色只会增加不必要的间接层。`@deepseek-ai/dsh-tool-memory` 是唯一的消费方，注册 `memory_remember`／`memory_recall`／`memory_list`／`memory_forget`／`memory_edit`，外加一个 `tool:memory` runtime-context 贡献。

真正在无需显式调用的情况下把召回的记忆送达模型的，是这个 runtime-context 贡献，而不是一个系统提示词段落。`ctx.systemPrompt.context()` 条目是唯一会被 agent loop（智能体循环）记录的一类提示词输入：[`RuntimeContextProjection`](../../../../packages/core/agent-loop/src/runtime-context.ts) 只要渲染出的文本与保留快照不同，就会把它作为一条 `user` 角色 session 事件提交，因此模型实际看到的确切文本始终可以通过回放重建。段落没有这样的保证——它的内容在每次组装时都被现场求值，被持久化的只有 agent 的活配置这一事实，而不是渲染出的文本。因此，为满足「模型可见 ⟺ 已记录」这一约束，记忆召回必须以上下文贡献的形式出现，这与 memory 自身的存储设计无关。

一条已存记忆是任意的用户撰写文本，因此渲染出的快照以 `interpolate: false` 注册。如果不这样做，一条含有形似 `{{…}}` 子串的记忆事实，在 `renderPrompt` 的严格插值下要么会抛出异常（未知引用），要么会被悄悄替换成一个无关的值。`interpolate` 是同时加到 `PromptSection` 与 `PromptContext` 上的一个通用字段，正是为了处理这一类问题——把逐字数据混入原本模板化的提示词输入——而 `dsh-tool-memory` 的这个上下文贡献是它第一个上线的消费方。

作用域刻意保持简单：一个项目的作用域是调用时那个确切工作目录字符串对应的 `project:<cwd>`；一次项目作用域的召回也会带出 `user` 条目（个人记忆会跟随用户进入每个项目），而 `memory_list` 更窄的语义不会。召回按 `accessCount` 降序、再按 `updatedAt` 降序排名，且只做大小写不敏感的子串匹配——没有语义检索，没有 embedding，也没有对已存条目的大小上限。

两个包都需要 `ctx.storageDomain`，而它只由 [`packages/bundle/web-app`](../../../../packages/bundle/web-app/README.md) 挂载；`packages/bundle/headless` 与 ACP 组合并不挂载它，因此在有其他组合包挂载 storage-domain 之前，memory 仍是一项仅限 web-app 的能力。

### 与 `examples/mcp-memory` 的关系

MCP 示例仍是进程外的替代方案：默认关闭，只有在显式调用某个第三方服务器自身的写入／搜索工具时才会被触及，数据完全存放在 harness 的 session 与存储模型之外，session 日志中也不会留下被召回内容的记录。`dsh-memory`／`dsh-tool-memory` 则是进程内的：web-app 组合包默认挂载该服务，agent preset 按 agent 挂载工具 Consumer；除了显式的 `memory_recall` 工具之外，还会自动把召回结果作为一条已记录的 runtime-context 快照呈现出来。这两种机制互不冲突；一次部署可以只用其中一种，也可以两者并用，彼此互不依赖。

## Alternatives considered

**用系统提示词段落呈现被召回的记忆。** 被否决：段落的实时文本不会被记录，回放无法重建模型实际看到的内容，违反了运行时快照已经满足的「模型可见 ⟺ 已记录」约束。

**为 memory 本身建一整套能力 seam（Service Definition／Provider／Consumer）。** 被否决：`storage-domain` 已经提供了可替换的持久化层；memory 只有一种实现，也没有当下需要它的第二个提供方，拆分 seam 只会增加没有现有消费方需要的间接层。

**对字面量 `{{…}}` 序列逐字符转义，而不是使用 `interpolate: false`。** 被否决：被记住的任意文本可能包含大量形似花括号的子串；一旦 `interpolate` 被加到 `PromptSection`／`PromptContext` 上，逐字段的整体关闭就已经是更简单、更通用的机制。

**像 `todo/write` 或 `goal/change` 那样，把记忆存成普通的 session 日志事件。** 被否决：那些事件的作用域局限于一个会话自己的日志；而 memory 存在的全部意义就是要在共享一个进程与存储根目录的每个会话之间可见，这是按会话划分的日志在没有独立跨会话索引的情况下无法提供的。

## Consequences

被召回的记忆完全可以从 session 日志重建：模型看到的每一次渲染快照都是一个真实被记录的事件，而不是现场重新计算出的产物。`interpolate: false` 字段获得了第一个真实的消费方，验证了该机制在面对真正不可信、含花括号的提示词数据时的有效性。任何未挂载 storage-domain 的组合都无法使用 memory，目前只有 web-app 组合包挂载它。按字面 `cwd` 作键的作用域意味着把项目迁移到新路径会让其记忆变成遗留数据，而子目录是一个不同的、无关的项目作用域——这是一项被接受的限制，记录在两个包各自的 README 中，而不在本决策中解决。

测试覆盖：包测试覆盖每一个源码分支；一项 Loader 组合测试在真实存储栈上启动 `dsh-tool-memory`；一项 agent loop 测试证明，在一个会话中记住的事实会以已记录的 runtime-context 快照形式到达下一个会话，且与模型请求一致。目前没有免密钥的应用快照固定 memory 上下文：`dsh-tool-memory` 由 agent preset 按需启用，没有任何随附组合或示例组合挂载它，因此现有转录均无变化。第一个默认挂载它的组合需要同时补上该快照，最可能位于 `apps/web/tests/snapshots/` 下。
