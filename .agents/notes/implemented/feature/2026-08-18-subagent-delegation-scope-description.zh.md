# Agent Note: 已配置的 `permissionMode` 会体现在 `tool-subagent` 的描述中

Status: implemented

[English](2026-08-18-subagent-delegation-scope-description.md) | 中文

## 问题

[权限范围 Agent Note](2026-08-17-subagent-delegation-permission-scope.md) 允许一个部署针对*同一个*提供方挂载两个 `dsh-tool-subagent` 行——一个 `permissionMode: 'read-only'`，一个 `permissionMode: 'workspace-write'`——分别使用不同的 `toolName`。`providerWording()` 仅根据 `SubagentProvider.inheritsParentContext` 推导工具 `description`，因此这两行产生的描述完全字节相同；唯一可观察到的区别只是工具名本身（例如 `codex_delegate` 与 `codex_delegate_write`）。模型在两者之间做选择时，除了依赖一个没有任何 schema 强制约束的命名惯例之外，没有别的方式判断哪一个可以写入——一个模型在契约中看不到的范围，也就是它无法遵守的范围，而本仓库自身的规则恰恰要求模型可见的契约必须陈述这类任务相关的事实。

## 决策

`packages/subagent/tool-subagent/src/index.ts` 新增了 `permissionScopeWording(permissionMode: SubagentPermissionMode | undefined): string`，在挂载处组合进描述：`wording.description + permissionScopeWording(config.permissionMode) + (backgroundEnabled ? ... : ...)`——插入在基础能力描述与调度后缀之间，使句子顺序读起来是「能力→调度」。当 `config.permissionMode` 为 `undefined` 时返回 `''`；`'read-only'` 与 `'workspace-write'` 各对应一句话，沿用既有的 `assertNever` 穷尽性写法（与 `failureClassPresentation` 一致）针对 `SubagentPermissionMode` 的两个变体展开。

工具层*只*陈述部署方显式配置的内容，绝不陈述提供方自身的默认值：`Config.permissionMode` 没有 Schemastery 的 `.default(...)`（这正是权限范围 Note 自身的理由——在工具层具体化一个默认值会把该字段无条件转发给每个提供方，从而在挂载时破坏每一个 `spawn`／`fork` 组合），而 `permissionScopeWording(undefined)` 正确地保持沉默，而不是去猜测一个本包并不掌握的默认值。这意味着 `spawn`／`fork`／`acp`／`dsh-sdk` 这些行——它们从未设置过 `permissionMode`——的描述不会有任何变化；而一个把该字段留空、从而落到提供方自身 `read-only` 默认值的 `codex`／`claude-code` 行，*同样*不会陈述任何内容，与未配置的行完全一样；只有*显式*设置的值才会改变描述。因此，针对同一提供方、仅在显式 `permissionMode` 上不同的两行，现在仅凭描述本身即可区分。

措辞陈述的是授予的能力与否定性保证，而不是配置键或强制执行机制：`'read-only'` 渲染为「This subagent cannot write, edit, or otherwise change anything; it can only read and investigate.」；`'workspace-write'` 渲染为「This subagent can create, edit, and delete files in its own working directory.」`workspace-write` 一句陈述的是*授予的能力*（子 agent 能做什么、在何处能做），而不主张任何两个已发布提供方都无法一致强制执行的排他性*承诺*（例如「仅限于」「被限定在」）：权限范围 Note 自身的「后果」部分已经记载，两个提供方的 `workspace-write` 并不等价——Codex 的是操作系统级的沙箱边界，而 Claude Code 的只是拓宽了工具名白名单，并不强制任何路径限制，因此 `claude-code` 子 agent 的 `Write`／`Edit`／`Bash` 调用仍可能指向其工作目录之外的路径。若断言子 agent 被限定在该目录内，对该提供方而言就是不实的。

## 考虑过的替代方案

- **在句子中写出字面的配置值（`'read-only'`／`'workspace-write'`）**——否决：这些是配置词汇，不是任务相关的概念；本仓库的模型可见契约规则要求陈述子 agent 能做什么、不能做什么，而不是哪个配置键或枚举值产生了这个事实。
- **在 `permissionMode` 省略时陈述提供方自身的默认值**——被该字段自身的设计直接否决：工具层本就刻意不知道提供方的默认值（这份知识只存在于各提供方自己的 `start()` 中，见权限范围 Note），因此在此处陈述默认值会要求工具层复制或查询本不该拥有的、由提供方所有的知识。
- **为 `workspace-write` 给出排他性承诺**（例如「仅限于其工作目录内」）——否决：这对 `claude-code` 而言并不成立，其白名单拓宽并不强制任何路径限制（权限范围 Note 中已实测）；`claude-code` 子 agent 的 `Write`／`Edit`／`Bash` 调用仍可能指向其工作目录之外。陈述一个两个提供方都无法一致兑现的保证，会让模型误解 `claude-code` 实际提供的、更弱的保证。最终交付的句子只陈述了授予能力的适用范围（其自身的工作目录），从未主张写入被限定在该目录内。

## 后果

- `spawn`、`fork`、`acp`、`dsh-sdk` 这些行，以及任何从未设置 `permissionMode` 的 `codex`／`claude-code` 行，描述完全不变——由未发生变化的无密钥快照套件证实（没有任何已发布的组合配置了该字段）。
- 一个针对同一提供方显式配置了两行 `permissionMode` 的部署，现在为模型提供了描述层面的依据来选择正确的那一行，不再依赖工具命名。
- `docs/config-catalog.md` 以及 `packages/subagent/tool-subagent/README.md`／`.zh.md` 都相应更新，反映出显式的 `permissionMode` 不再「模型永远不可见」——它依然从不是工具参数，但现在会体现在工具描述中。

## 测试

- `packages/subagent/tool-subagent/tests/tool-subagent.spec.ts`：显式 `'read-only'` 行的描述包含 read-only 语句；显式 `'workspace-write'` 行的描述包含 workspace-write 语句；一个针对具备 `permissionMode` 能力的提供方却省略了该字段的行，不陈述任何范围信息。三个测试都断言基础措辞（`'does not see this conversation'`）与附加语句共存，证明是追加而非重写。
