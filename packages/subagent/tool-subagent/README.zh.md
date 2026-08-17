# @deepseek-ai/dsh-tool-subagent

[English](README.md) | 中文

基于一个已配置 `ctx.subagents` 提供方、面向模型的委派工具。更换提供方只会改变传输，不会改变执行约定。

## 提供方选择与生命周期

每个插件实例把一个 `provider` 绑定到一个 `toolName`；模型不会收到提供方选择器。如需公开另一种传输，请加载另一个名称不同的实例。工具只在其提供方存在时注册，从而避免对同级加载顺序和提供方重新加载的依赖。工具描述遵循 `provider.inheritsParentContext`：新建子 agent（智能体）需要独立提示词，而 fork 子 agent 已能看到父级已完成轮次。

前台调用会让执行信号贯穿启动和执行，等待 `run.result`，并且在返回前总会等待 `run.dispose()`。只有 `completed` 会返回规范值 `{ kind: 'foreground', runId, output: JsonValue[], changedFiles?, usage? }`，渲染为最终文本，外加提供方上报了 `changedFiles`／`usage` 时才附加的"Files changed"和"Tokens used"提示（否则完全不出现——只读运行常见的空 `changedFiles` 不会带来任何噪音）；中止、拒绝、token 上限和其他失败都会变成出错的工具结果，其消息在终止原因标题之后附带子 agent 保留下来的部分文本（即 `SubagentResult.output` 的选取结果）——被截断的回答不会被报告为成功，也绝不会被悄悄丢弃。如果结果收集与 dispose（资源释放）都 reject，出错的结果会保留两项诊断信息。

`backgroundMode` 同时选择后台路由与省略 `run_in_background` 时的默认行为。`one-shot` 默认在前台等待；显式传入 `true` 时，它会注册一个归父级所有的普通 Task，并返回规范值 `{ kind: 'background', jobId }`，渲染为 `started background subagent job <id>`，即使提供方支持可继续子 agent 也不例外。通用 Task 工具负责其后续状态、收集、取消和通知。`continuable` 在参数省略或为 `true` 时于后台运行；显式传入 `false` 时则在前台等待结果。其后台路由要求提供方具备 `prepareContinuable` 能力，调用 `ctx.subagents.startContinuable()`，并返回 `{ kind: 'continuable', subagentId }`，渲染为 `started subagent <childId>`。该路由在 inbox 接受时结算：子 agent 自此拥有自己的轮次，因此该调用既不等待也不收集结果。通过该 id 查看其 transcript（文本记录）仍是其详细输出的来源，可选的全局 `send_message` 工具则向其发送更多工作。每当子 agent 的 Activation 结束，继续执行服务都会投递一条结算通知，其中包含结束结果及可能存在的最终 assistant 消息，且这项投递不依赖 `report`。启动可继续工作不要求加载 `send_message`。见[后台 subagent Agent Note](../../../.agents/notes/implemented/feature/2026-07-08-background-subagent-tasks.md)、[可继续的 subagent Agent Note](../../../.agents/notes/implemented/feature/2026-07-28-continuable-subagent-conversations.md)和[后台优先委派 Agent Note](../../../.agents/notes/implemented/feature/2026-08-11-background-first-continuable-delegation.md)。

`toolFilter` 会改变子 agent 的全局工具层，但不是从父级派生的权限上限。见 [agent 作用域的安全非目标](../../../.agents/notes/implemented/architecture/2026-07-08-agent-scope-contexts.md#security-and-authority-are-non-goals)。

`permissionMode` 会为本工具实例发起的每一次委派固定子 agent 的权限范围；它是部署配置，绝不是模型可见的工具参数——模型无法为某一次调用请求更宽的范围。省略该键会保留提供方自身的默认值（对每个具备该能力的提供方而言均为 `read-only`）；显式设置该值则要求提供方具备 `permissionMode` 能力，缺失时挂载会失败。见[审批钉定 Agent Note](../../../.agents/notes/implemented/feature/2026-08-10-subagent-approval-pinned-never.md)和[权限范围 Agent Note](../../../.agents/notes/implemented/feature/2026-08-17-subagent-delegation-permission-scope.md)。

`timeoutSeconds` 会以本实例自身的墙钟时间，限定一次前台调用与一次一次性后台调用——这两种运行都由本工具从头到尾拥有，因此其计时器不仅覆盖被等待的结果，也覆盖 `ctx.subagents.start()` 本身（例如启动期卡死的提供方，而不仅是结果挂起）。到期时，合成信号的中止方式与调用方取消完全相同，但前台工具结果会读作超时而非取消，而真正的调用方取消即便与已启动的计时器竞争，仍会读作取消。省略该键会保留现有行为：没有上限。将其与 `backgroundMode: 'continuable'` 一起配置会在加载期失败——可继续子 agent 的轮次在 inbox 接受之后归继续执行服务所有，而不属于本工具，因此这里没有可供计时器终止的运行。见[墙钟超时 Agent Note](../../../.agents/notes/implemented/feature/2026-08-17-subagent-delegation-timeout.md)。

## 失败分类

当一次委派以 `stopReason: 'error'` 结束，且提供方填充了 `SubagentResult.failure`（[`dsh-subagent-codex`](../subagent-codex/README.md)、[`dsh-subagent-claude-code`](../subagent-claude-code/README.md)；进程内提供方从不填充它）时，模型会看到一个分类专属的标题，说明这是哪一种失败——身份验证、使用限额、提供方，还是协议——后面跟着提供方自身的可操作文本，该文本在到达模型可见输出（并借此进入会话日志）之前，已针对凭据形状的模式做过筛查（与 `@deepseek-ai/dsh-subprocess` 的 `scrubbedParentEnv` 使用的同一套词汇表）。已分类的失败还会抛出本包自身的 `SubagentError`（来自 `@deepseek-ai/dsh-subagent`），带有可路由的 `SUBAGENT_AUTH`/`SUBAGENT_QUOTA`/`SUBAGENT_PROVIDER`/`SUBAGENT_PROTOCOL` 代码，通过既有的[结构化错误分类法](../../../.agents/notes/implemented/architecture/2026-06-11-structured-error-taxonomy.md)到达 `ToolExecutionResult.error.info`，而不是走一套新机制。一个提供方无法分类的 `'error'` 结果，会保留此前未分类的 `subagent run failed` 标题，且不带任何可路由代码。见[失败分类 Agent Note](../../../.agents/notes/implemented/feature/2026-08-17-subagent-delegation-failure-classification.md)。

## 配置

| 键 | 含义 |
|---|---|
| `provider`（必填） | 提供方名称（`spawn`、`fork`、`acp` 等）。 |
| `toolName` | 面向模型的名称，默认 `subagent`；每个已加载实例必须不同。 |
| `enableRunInBackground` | 公开后台模式，默认 `true`；禁用时也会拒绝强制后台调用。 |
| `backgroundMode` | 后台生命周期策略，默认 `one-shot`。`one-shot` 默认前台调用；`continuable` 默认后台调用，要求提供方具备 `prepareContinuable` 能力，并返回持久化子 agent ID，且不要求加载后续消息工具。 |
| `agentOptions` | 传给具体提供方的子 agent `provider`、`model` 和正整数 `maxTokens`；进程内提供方会用显式值覆盖继承的父级选项。 |
| `persona` | 每个子 agent 独立的 persona；要求提供方具备 `persona` 能力。 |
| `toolFilter` | 每个子 agent 独立的全局工具限制；要求提供方具备 `toolFilter` 能力。 |
| `maxDepth` | 绝对委派深度上限，默认 `3`（`0` 禁止委派）；数值上限要求 `depthLimit` 能力，缺失时挂载失败。对于预算由子 harness 拥有的进程外提供方，`'provider-managed'` 不发送上限。工具在达到上限时仍然可见；每次尝试启动都会检查调用 agent 的当前深度，被拒绝时返回出错的工具结果。 |
| `permissionMode` | 固定的子 agent 权限范围（`'read-only'` \| `'workspace-write'`）；要求 `permissionMode` 能力，缺失时挂载失败。省略则保留提供方自身的默认值（`read-only`）。模型永远不可见——仅是部署方的选择。 |
| `timeoutSeconds` | 本实例自身前台运行与一次性后台运行的墙钟上限（秒）；必须是正的有限数，且换算为毫秒后不超过 `MAX_TIMER_DELAY_MS`（`@deepseek-ai/dsh-timeout`）。省略则不设上限（现有行为）；不会具体化 Schemastery 默认值，因此现有的 `spawn`／`fork` 组合在部署方主动启用之前不受影响。与 `backgroundMode: 'continuable'` 一起配置会在加载期失败。 |

## 并发

前台调用和后台调用均并发安全：同一条 assistant 消息中的同级委派会在循环的滚动池（`maxParallelToolCalls`）下重叠执行，结果仍按模型顺序提交。子 agent 在各自的会话中工作，一次运行绝不变更父会话；一次性后台形态对父级拥有状态的唯一写入是注册一个 Task——这是一次同步、可交换、能容忍并发分发的插入，因此重叠的后台调用按分发竞态顺序获得各自的 job id。协调同级工作区效果由模型负责，正如模型已经对后台和可继续子 agent 所承担的那样。见 [并行 subagent Agent Note](../../../.agents/notes/implemented/feature/2026-08-09-parallel-subagent-delegations.md) 和 [并行工具调用 Agent Note](../../../.agents/notes/implemented/feature/2026-07-10-parallel-tool-call-execution.md)。

## 模型体验

### 工具 schema

#### 模型看到的内容

当提供方存在时，以当前实例配置的名称公开已生成的默认 [`subagent` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-subagent)。提供方是否继承上下文会改变工具描述和提示词描述。启用后台模式会添加 `run_in_background`：可继续模式会记录其默认值为 `true`、运行时结算通知与显式前台覆盖；一次性模式会记录其默认值为 `false`，以及用 `job_output` 收集或用 `job_kill` 停止的 job id。当工具在本次组装的作用域中可见时，一个 `tool:<toolName>` 系统提示词 section 会指示模型同时启动相互独立的可继续委派、在它们运行时继续工作，并且仅当下一步动作依赖结果时选择前台；工具限制会同时移除其 schema 和这段指引。

#### Token 影响

每个父级请求都会产生固定的 schema token 开销；每个提供方实例增加一个 schema，每个可继续实例还会增加一个简短的系统提示词 section。

#### KV Cache 影响

只要提供方实例、名称、描述和 schema 不变，前缀就保持稳定。提供方注册生命周期可能从首个变化的工具定义开始，使父级复用失效。

### 前台结果

#### 模型看到的内容

调用会保留描述和提示词。成功时包含子 agent 的最终文本，随后是一份"Files changed:"绝对路径清单和一行"Tokens used: … in, … out"——两者都只在提供方（`codex`、`claude-code`）确实上报了对应字段时才会出现；进程内提供方或一次只读运行两者都不会出现。其他结果变为 `Error: <message>`。子 agent 中间步骤不会进入父级。若配置的 `timeoutSeconds` 终止了运行，结果会读作 `Error: subagent run hit its <N>s time limit before finishing`（外加任何保留下来的部分文本）——与调用方取消的消息 `Error: subagent run was cancelled` 不同，因此模型不会把两者混淆。一次已分类的原生失败（见上文"失败分类"）会读作 `Error: subagent could not authenticate with its provider: <提供方自身的文本>`，或者对应使用限额、提供方、协议失败的相应行。

#### Token 影响

提示词和结果会留在父级历史中，直到上下文压缩（context compaction）；子 agent 工作上下文留在子 agent 中。

#### KV Cache 影响

仅追加；新增可见内容位于可复用请求前缀之后，不会使现有 KV Cache 条目失效。

### 后台结果

#### 模型看到的内容

在配置的可继续模式下，启动时返回内容恰为 `started subagent <childId>`；在配置的一次性模式下，则返回 `started background subagent job <id>`。一次性模式下，通用 Task 接口提供后续状态、最终输出、取消响应和通知。可继续模式下，本工具不返回自己的结果；子 agent 的结算会以[服务负责的通知](../subagent/README.md#settlement-notice)到达父级，独立加载的 `send_message` 工具会投递后续消息，而通过其 id 查看子 agent 的 transcript 即是其详细输出来源。

#### Token 影响

确认消息会被保留；一次性最终输出只在收集或注入时进入父级历史，而可继续子 agent 的输出绝不会通过本工具返回——其结算通知独立于任何工具结果到达。

#### KV Cache 影响

仅追加；新增可见内容位于可复用请求前缀之后，不会使现有 KV Cache 条目失效。

## 已知限制与暂缓事项

- **后台运行不通过本工具公开结果**：一次性任务的最终输出通过通用 Task 接口收集，可继续子 agent 的输出留在其自身会话中，按其 subagent id 读取。结算通知会说明该子 agent 如何结束，并携带可能存在的最终 assistant 消息，但它不是本次调用的返回值，也无法在此等待。
- **等待中的一次性实例较晚才发现重复名称**（`TODO(subagent-dup-toolname)`）：可继续实例会在插件应用期间预留提示词 section 名称，但若要阻止等待中的一次性实例回滚提供方注册，仍需要一份预期名称注册表。
- **每个实例的子 agent 策略固定**：其他模型、persona、工具过滤器或深度上限都需要另一个名称不同的工具。
- **一次性后台运行的超时对通用 Task 接口不可见**——`job_output`／结算通知会把超时的一次性子 agent 报告得与被 `job_kill` 终止的子 agent一模一样（`[status: killed]`）；只有前台路径的工具结果会把超时单独标出。为共享的 `JobOutcome` 增加这项区分被推迟；见[墙钟超时 Agent Note](../../../.agents/notes/implemented/feature/2026-08-17-subagent-delegation-timeout.md)。
- **脱敏基于模式匹配，并非详尽无遗**——`redactCredentialShapedText` 只会屏蔽紧跟在 `:`/`=` 与一个值之前的凭据形状标签；如果泄露的秘密没有相邻标签，或者其形状不属于 `KEY`/`PASSWORD`/`SECRET`/`TOKEN` 中任何一个所命名的形态，就不会被捕获。这与 `scrubbedParentEnv` 用来阻止凭据进入被 spawn 子进程自身环境的词汇表相同，而不是一个通用的秘密扫描器。
- **两个提供方上，`changedFiles` 都不包含任何 `Bash`／shell 驱动的写入**——见 [`dsh-subagent-claude-code`](../subagent-claude-code/README.md#known-limitations-and-deferred-work) 与 [`dsh-subagent-codex`](../subagent-codex/README.md#known-limitations-and-deferred-work)。部署方不能把本工具的 `changedFiles` 提示当作一次 `workspace-write` 子 agent 触及过的每个文件的完整审计记录。
- **`changedFiles`／`usage` 永远不会到达一次性后台运行的 `job_output`**——两个字段只存在于本工具直接构造的前台 `ForegroundToolResult` 上；一次性后台路径的 `JobOutcome`（`dsh-jobs`）不受本特性影响，与上文既有的后台超时限制属于同一类范围裁剪。
