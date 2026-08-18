# @deepseek-ai/dsh-subagent-codex

[English](README.md) | 中文

本包注册固定的 `codex` subagent 提供方。每次接受运行请求后，它都会在发起委托的会话工作区中启动官方 `codex app-server --stdio` 命令，创建一个临时 Codex 线程，提交一个自包含的文本任务，并通过共享的 [`dsh-subagent`](../subagent/README.md) 结果约定仅返回最终答案。

## 启动与所有权

`start(request)` 只接受非空的文本块序列，并根据父会话确定子级 cwd。随后，它通过 [`dsh-subprocess`](../../subprocess/subprocess/README.md) spawn 固定命令，依次执行 `initialize` → `initialized` → `thread/start { cwd, ephemeral, sandbox, approvalPolicy: 'never' }`（除非该次调用选择了续接，否则 `ephemeral: true`——见下文「Resume（可选）」），且仅在 Codex 返回的线程所上报的 `ephemeral` 与所请求的值一致后才发布此次运行。除非 `request.permissionMode` 为 `workspace-write`，否则 `sandbox` 为 `read-only`；`approvalPolicy` 始终是显式字面量 `'never'`，绝不取自宿主机自身的 `~/.codex/config.toml`，因此同一次委派无论宿主配置如何漂移都表现一致。若在发布前发生失败或取消，它会关闭通信链路、终止受管进程树并等待其退出，然后拒绝 `start()` 调用。

已发布的 `run.result` 恰好启动一个轮次。它只接受与此次运行的线程和轮次匹配的通知，随后等待权威的终止通知 `turn/completed`。以最后一条 `phase: "final_answer"` 的 `agentMessage` 为准；若 Codex 没有发出明确的最终阶段，则以最后一条 `phase: null` 的消息作为兼容性回退。过程说明绝不会取代上述任一答案；成功完成的轮次若没有非空白答案，结果也会判为错误。

对于命令与文件审批，无人值守的提供方会从请求给出的决策选项中选择一项不予批准的决策，并优先选择 `cancel`；稳定的 0.147.0 请求形态没有决策选项列表，因此回退到 `decline`。它对权限请求返回作用域限于当前轮次的空权限集，不向用户输入请求提供任何答案，并拒绝 MCP elicitation。若请求在无人值守模式下没有合法响应，或是未知服务器请求，此次运行就会失败。实际情况是，`approvalPolicy: 'never'` 意味着 codex-core 自身会在需要提升权限的命令上，把拒绝作为函数自身的输出直接给出，而根本不会向本提供方发送审批请求——因此这条无人值守决策路径是由本包自身在协议层的测试来覆盖的，而非由 Codex 拒绝的每一条真实命令来触发。

本地取消会在结果竞态中胜出并映射为 `aborted`。失败轮次的 `codexErrorInfo` 若为 `contextWindowExceeded`，则映射为 `max-tokens`；其他任何远端中断或失败轮次都映射为 `error`，且该提供方不会产生 `refusal`。`dispose()`（资源释放）具有幂等性：如果当前的两个标识符均已知，它会尽力请求 `turn/interrupt`，关闭 JSON-RPC 通信链路，结束标准输入，调用共享的进程树逐级终止机制，并等待整棵进程树退出。结果失败与独立的清理失败仍彼此分离。

### 变更文件与用量

`completed` 或 `max-tokens` 结果还会在 wire 观察到相关信息时携带 `changedFiles`（绝对路径，已去重）和 `usage`（`{ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }`）——共享约定与纳入规则见 [`dsh-subagent`](../subagent/README.md#one-shot-ownership-and-lifecycle)。`changedFiles` 只收集自身 `status` 为 `'completed'` 的 `item/completed` `fileChange` 项；`declined`/`failed`/`inProgress` 状态的项会被静默跳过，绝不上报（实测；参见 [Agent Note](../../../.agents/notes/implemented/feature/2026-08-17-subagent-delegation-changed-files-and-usage.md)）。`thread/tokenUsage/updated` 携带两个不同的字段：`total` 是该*线程*生命周期内的累计用量（实测：它不会在 `thread/resume` 之后重置，因此被续接调用收到的第一条通知就已经带有此前那次调用的总量作为基数）；`last` 是*单次*模型调用自身的用量，即便在同一个回合内也不是累计值。`usage` 只在当前回合内对每条通知的 `last` 字段求和，绝不读取 `total`——这是唯一能在全新线程和被续接线程上都正确报告*本次调用*自身用量的写法（实测；参见[续接 Agent Note](../../../.agents/notes/implemented/feature/2026-08-18-subagent-delegation-resume.md)）。`turn/diff/updated`（在真实 app-server 上同样观察到）刻意未被采用：它为整个轮次携带一段未经结构化的统一 diff 文本，而 `changedFiles` 所需要的正是 `fileChange` 这种按条目、按路径、附带状态限定的结构化形态。

**实测：只有由 `apply_patch` 驱动的写入才会产生 `fileChange` 项。** 一次普通的 shell 写入（例如通过 `exec_command`/`shell_command` 执行 `printf WROTE > marker.txt`）会创建文件，但只会上报一个 `commandExecution` 项——绝不会上报 `fileChange`——因此它对 `changedFiles` 而言不可见，这与 Claude 的 `Bash` 写入对该提供方自身收集器不可见的情形完全对称（见该包的 README）。Codex 自身的系统指令要求模型"始终使用 `apply_patch` 进行手动代码编辑"，这在实践中收窄了这一缺口，但并未彻底消除它。只读子级的 `apply_patch` 尝试会在 codex-core 为其发出任何条目之前，就被操作系统沙箱拒绝（而不是产生一个 `declined` 状态的条目）——两种情形下 `changedFiles` 为空的结果是相同的。

### Resume（可选）

本提供方声明 `resume` 这一启动时能力。调用方若设置 `request.requestResume: true`，就会启动一个*持久化*线程（`thread/start { ephemeral: false, ... }`），而不是默认的临时线程；一次成功的 `completed`/`max-tokens` 结果随后会携带 `resumeId: thread.id`。之后的某次调用若把 `request.resumeId` 设为调用方已经持有的某个值，就会续接那个确切的线程而不是重新开始：`thread/resume { threadId, sandbox, approvalPolicy: 'never' }`（该 wire 自身使用的字段是驼峰式 `threadId`——Rust 源码中的 `thread_id` 无法通过 app-server 自身的字段名校验），并像 `thread/start` 一样在每次续接时重新钉定 `sandbox`/`approvalPolicy`，因此被续接子级的权限范围绝不会比*本次调用*的 `request.permissionMode` 所授予的范围更宽，无论该线程此前恰好运行在什么范围之下。一个无法识别或已在别处被续接的线程 id 会在任何线程被（重新）发布之前就拒绝 `thread/resume`；本提供方会像分类发布后的原生失败一样分类这次拒绝（`SubagentFailureDetail { code: 'provider', ... }`），绝不会是一次未分类的崩溃。续接进一个不匹配的线程（app-server 返回的线程 id 与所请求的不同）会作为一项防御性完整性检查而被拒绝，而不是被分类为原生提供方失败。此能力在再上一层被部署门控，即 [`dsh-tool-subagent`](../tool-subagent/README.md#resume-opt-in) 的 `allowResume` 配置项——只有部署方已选择启用时，模型才能请求续接。

### 失败分类

只要 wire 能够对原因分类，`error` 这一 stop reason 就会携带一个已分类的 `SubagentResult.failure`（`auth`/`quota`/`provider`/`protocol`，参见 [`dsh-subagent`](../../../docs/subsystems/subagent.md#the-terminal-result-subagentresult)）。app-server 自身的中间 `error` 通知——`turn/completed` 不会重复它们——携带了有结构的真实原因；针对真实未认证环境的实测表明，终态轮次自身的 `codexErrorInfo` 会退化为字面量 `"other"`，因此本提供方会在整个轮次的 `error` 通知中保留见到过的最具体原因，而不是只信任终态那一个（实测；参见[失败分类 Agent Note](../../../.agents/notes/implemented/feature/2026-08-17-subagent-delegation-failure-classification.md)）。`httpStatusCode === 401` 或 `codexErrorInfo === 'unauthorized'` 分类为 `auth`；`httpStatusCode === 429` 或 `'usageLimitExceeded'`/`'serverOverloaded'` 分类为 `quota`；其他任何原生原因分类为 `provider`；本 wire 自身校验器拒绝的 JSON-RPC 形状偏差分类为 `protocol`。未来某个未识别的 `codexErrorInfo` 值会落到 `provider`，而不是直接失败关闭。`SubagentResult.authMode` 在 `Config.env` 设置了凭据形状的变量名时为 `'api-key'`，否则为 `'subscription'`——纯粹从该配置推导，绝不读取 `~/.codex`。

## 能力与上下文

本提供方声明 `permissionMode` 与 `resume` 这两个启动时能力（分别对应上文 `thread/start`/`thread/resume` 上的 `sandbox`，以及提供方原生的线程续接），不声明其他任何可选能力，并报告 `inheritsParentContext: false`。Codex 会接收独立文本任务、父会话 cwd 与固定的权限范围，但不会接收父会话的对话、角色设定、工具筛选器、深度策略或结构化输出约定。Codex 线程 ID 与轮次 ID 不会直接持久化到父会话——一次可续接运行的线程 id 只会作为 `SubagentResult.resumeId` 暴露出来，并且只有 `dsh-tool-subagent` 自身可选的 `allowResume` 日志记录（而非本包）才会把它写入持久化的会话日志。

## 配置

| 配置键 | 默认值 | 含义 |
|---|---|---|
| `env` | `{}` | 显式指定的子进程环境，叠加在由子进程 seam 清除凭证后的父环境之上。 |
| `disposeGraceMs` | `3000` | 共享进程树责任方各终止层级之间的宽限期，单位为毫秒且须为正有限值，并不得大于仓库共享的 [`MAX_TIMER_DELAY_MS`](../../util/timeout/README.md)；随后资源释放会等待整棵进程树退出。 |

生产环境会从 `PATH` 中解析 `codex`，并使用宿主机原生的 Codex 配置与身份验证。本插件不安装 Codex、不选择模型、不创建 `CODEX_HOME`、不执行登录，也不探测版本。子进程 seam 会移除具有凭证特征的环境变量，因此供子进程使用的 API 密钥必须在 `env` 中显式提供；除非被覆盖，`PATH` 和 `HOME` 等普通环境变量值仍然可用。

生产 `dsh` 不会安装或挂载这个可选提供方。选择启用它的 Profile 必须安装 `@deepseek-ai/dsh-subagent-codex`，并在 host plane（宿主平面）挂载一次；加载提供方本身不会在工具调用前启动 Codex 进程。完整 Agent Preset 携带对应的产品工具行并设置 `disabled: true`；复制一个 preset 后删除该字段，即可只向由该副本组装的 agent 暴露 `subagent_codex`。其 `one-shot` 策略会让省略 `run_in_background` 或传入 `false` 的调用继续在前台等待，而显式传入 `true` 会返回由父 agent 拥有的 Job ID，供 `job_output` 或 `job_kill` 使用。base host（基础宿主）与完整 preset 已提供通用作业注册表和控制工具。

下列独立组装展示完整的显式能力。基于 `@deepseek-ai/dsh-base` 的 Profile 保留已有 Job 行，只新增产品提供方行并启用 preset 工具行，禁止重复挂载 Job 服务。

```yaml
- id: subagent-codex
  name: '@deepseek-ai/dsh-subagent-codex'
  config:
    env:
      OPENAI_API_KEY: !!js process.env.OPENAI_API_KEY

- id: jobs
  name: '@deepseek-ai/dsh-jobs-local'

- id: tool-jobs
  name: '@deepseek-ai/dsh-tool-jobs'

- id: tool-subagent-codex
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: codex
    toolName: subagent_codex
    backgroundMode: one-shot
    maxDepth: provider-managed
```

## 产品兼容性与证据

生产环境的协议层有意只实现这一单次执行约定所需的 app-server 方法。开发证据锁定在 `@openai/codex@0.147.0` / `codex-cli 0.147.0`；该 NPM 包仅作为测试依赖，部署环境仍需通过 `PATH` 提供 `codex`。

## 模型体验

### 子级请求

#### 模型看到的内容

Codex 子级会在一个全新的临时线程中，以单个轮次接收这些独立文本块。它的工作区是父会话 cwd，其沙箱与审批策略在委派时已固定（除非部署方配置 `workspace-write`，否则为 `read-only`／`never`）；其模型、系统指令、工具和身份验证来自原生 Codex 安装与配置。

#### 对 token 的影响

子级需为独立的 Codex 上下文和轮次承担 token 开销。子级 token 不会进入父级上下文。

#### 对 KV Cache 的影响

这与父请求缓存相互独立。能否复用只取决于 Codex 自身的提供方、模型、指令、工具和临时线程请求。

### 父级调度与结果（间接）

#### 模型看到的内容

通过 `dsh-tool-subagent`，前台调用会让父级模型看到选定的 Codex 最终答案、其观察到的 `changedFiles`／`usage`，或者在结果未完成时看到消费方给出的原样错误；后台调用会先返回 Job id，随后通用作业控制面会送达完成通知，通过 `job_output` 公开最终答案与状态，并允许 `job_kill` 请求取消——`job_output` 不会携带 `changedFiles`／`usage`，这两项只有在前台调用时才会到达模型。一次已分类的 `error` 会以某个分类专属的标题（例如 "subagent could not authenticate with its provider: …"）加上 Codex 自身的可操作文本（已针对凭据形状的模式做过筛查）到达模型。Codex 的过程说明、推理（reasoning）、工具活动、stderr、工作区差异和产品标识符均不会复制到父会话。

#### 对 token 的影响

前台输入会增加工具结果中保留的最终答案或错误内容。后台输入还会包含启动确认、完成通知，以及 `job_output`、`job_kill` 或后续状态结果；子任务 token 仍不会进入父级上下文。本提供方自身不添加父级工具 schema。

#### 对 KV Cache 的影响

仅追加：前台会在可复用的父请求前缀后增加一个结果，后台则会继续追加 Job 启动确认、通知以及后续控制或收集结果。后台调度可能增加一个由通知唤醒的轮次，但这些消息都不会改写更早的前缀。

## 已知限制与后续工作

- **每次运行均新建一个进程与一个轮次；线程续接仅在选择启用时才有**：不支持池化或进度流；resume（见上文「Resume（可选）」）只保留 app-server 自身的线程状态，绝不保留本进程——被续接的调用仍会重新 spawn 一个全新的 `codex app-server` 进程，再按 id 重新接入已持久化的线程。
- **产品安装和账户状态由宿主管理**：`codex` 缺失或不兼容、配置错误或身份验证失败，都会呈现为启动错误或运行错误；本插件不提供安装程序、登录流程或运行时版本门禁。
- **兼容性由开发证据锁定**：若要从已验证的 0.147.0 协议基线升级，必须重新生成上游 schema 证据，并重新运行握手、答案选择、审批、取消、无密钥真实产品以及带密钥的 DeepSeek 随机数测试。
- **没有人工审批路径**：`approvalPolicy` 始终是固定字面量 `'never'`；已知的无人值守审批请求会被拒绝，未知服务器请求会以默认拒绝方式使运行失败；部署方无法通过本包配置允许策略。
- **只返回最终文本、变更文件与用量，且仅通过前台调用送达**：推理、过程说明、未被选中作为答案的中间消息、工具通信、stderr，以及 `turn/diff/updated` 的原始统一 diff 文本仍只保留在产品内部；只有前台调用时，最终答案、`changedFiles` 与 `usage` 才会进入共享结果（见上文"变更文件与用量"）；后台调用的 Job id、完成通知与状态则来自共享作业运行时，而非本提供方。
- **除 `permissionMode` 与 `resume` 外没有可选的共享能力**：对于本提供方，共享服务会拒绝输出 schema、子任务角色设定、工具筛选和 harness 深度强制约束。
- **没有按实际经过时间触发的超时或副作用回滚**：长时间运行的工作由调用方取消，且取消前已更改的文件或外部系统不会恢复原状。
- **失败分类是针对外部开放词汇表的尽力而为**：`codexErrorInfo` 的枚举可能在未来的 app-server 版本中扩充；未识别的值会分类为 `provider` 而不是直接失败关闭，因此一个新的原生原因永远不会被误报为 `auth`/`quota`，但可能最初分类得比该包后续更新之后更粗。
- **`authMode` 报告的是配置，而非实时账户状态**：它从不探测 `~/.codex`，因此如果部署方设置了一个凭据形状的 `env` 条目但子进程实际并未使用它（或反之），报告的是配置的意图，而不是关于某次运行实际使用了哪个凭据的已验证事实。
- **普通 shell 写入对 `changedFiles` 不可见**：只有由 `apply_patch` 驱动的变更才会被上报（实测；见上文"变更文件与用量"）。依赖 `changedFiles` 在 `workspace-write` 下做审计追踪的部署方，不能假定它枚举了子级触及过的每一个文件。
- **`changedFiles`／`usage` 在 `aborted` 或未分类的 `error` 结果上缺省**：两者只在 `wire.runTurn()` 直接构造 `completed`／`max-tokens` 结果处填充；被取消或未分类失败的运行不携带任何部分文件或用量统计（与共享包自身的相同缺口）。
- **委派运行期间会触发宿主配置的 hook**：在真实 app-server 上观察到委派轮次期间会产生 `hook/started`／`hook/completed` 通知，其来源是宿主自身的 Codex 配置，而不是本提供方固定的 `thread/start` 参数（`sandbox`／`approvalPolicy`）。与沙箱和审批策略不同，hook 目前未被本包钉定；宿主 hook 有可能观察到甚至影响一次委派子级的轮次。这超出本包的范围。
- **被续接的（持久化）线程会存储在宿主自身的 `~/.codex` 会话历史中**：与临时线程不同——app-server 从不把临时线程持久化到进程退出之后——`ephemeral: false` 会把该线程写入用户自己交互式 `codex` 会话所使用的同一份磁盘存储中。选择启用 `allowResume` 的部署方应当把这视为一个持久的、宿主可见的副作用，而不是内部实现细节。
