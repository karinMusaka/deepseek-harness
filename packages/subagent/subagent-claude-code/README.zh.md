# @deepseek-ai/dsh-subagent-claude-code

[English](README.md) | 中文

本包（package）注册固定的 `claude-code` subagent 提供方。每次接受运行请求后，它都会在发起委托的会话工作区中调用官方 Claude Agent SDK，通过共享子进程服务解析原生 `claude` 可执行文件，提交一个自包含的文本任务，并通过共享的 [`dsh-subagent`](../subagent/README.md) 结果约定仅返回最终答案。

## 启动与所有权

`start(request)` 只接受非空的文本块序列，并根据父会话确定子级 cwd。它会创建一个私有 `AbortController`，调用官方 SDK 的 `query()`，并仅在 SDK 的 `spawnClaudeCodeProcess` 钩子已经提供由 [`dsh-subprocess`](../../subprocess/subprocess/README.md) 管理的活动 CLI 句柄后发布此次运行。若在发布前发生失败或取消，它会关闭 query、终止所有已取得的进程树并等待其退出，然后拒绝 `start()` 调用。

SDK 接收由文本块原样拼接成的任务。提供方会完整迭代 SDK 消息流，而且只接受满足以下条件的 `result` 消息：`is_error: false` 且 `result` 非空白，之后迭代器还须正常结束——直接从 `is_error` 分类，绝不依赖 result 消息自身的 `subtype`（真实的登出运行会报告 `is_error: true`，而 `subtype` 仍是 `"success"`；见下文"失败分类"）。任何已分类的错误、缺失答案、迭代器失败、协议失败或进程失败都映射为 `error`；该提供方不会产生 `max-tokens` 或 `refusal`。

本地取消会在结果竞态中胜出并映射为 `aborted`。`dispose()`（资源释放）具有幂等性：它会中止此次运行、请求 SDK query 关闭、调用共享的进程树逐级终止机制，并等待整棵进程树退出。SDK 的优雅关闭只表达协议意图；进程是否完全停稳仍以子进程句柄为准。结果失败与独立的清理失败仍彼此分离。

### 失败分类

`error` 这一 stop reason 会携带一个已分类的 `SubagentResult.failure`（`auth`/`quota`/`provider`/`protocol`，参见 [`dsh-subagent`](../../../docs/subsystems/subagent.md#the-terminal-result-subagentresult)）。本提供方还会消费 `assistant` 消息（此前完全跳过），以保留见到过的最具体 `SDKAssistantMessageError`：`authentication_failed`/`oauth_org_not_allowed` 分类为 `auth`；`rate_limit`/`billing_error`/`overloaded` 分类为 `quota`；其余已命名的值分类为 `provider`；`max_output_tokens` 是单条消息级别的截断提示，不是终态失败信号，不会被保留。在终态结果处，保留下来的原因优先；否则由结果自身的 `api_error_status`（401 → `auth`，429 → `quota`）决定；再否则分类为 `provider`。`protocol` 在这里永远不适用——SDK 完全屏蔽了自己的 wire 传输层。未来某个未识别的 `SDKAssistantMessageError` 值会落到 `provider`，而不是直接失败关闭。`SubagentResult.authMode` 在 `Config.env` 设置了凭据形状的变量名时为 `'api-key'`，否则为 `'subscription'`——纯粹从该配置推导，绝不读取 `~/.claude`。

## 原生设置与权限范围

每次 query 都无条件设置 `settingSources: []`。因此，官方 SDK **不会**读取宿主机的用户、项目或本地 Claude 设置、CLAUDE.md 或 MCP 服务器配置——子级的整个世界在委派时就已固定，因此同一次委派无论宿主自身的 Claude 配置如何漂移，行为都保持一致。登录／账户状态与网络身份验证仍是原生的（该选项控制的是文件系统设置，而非身份验证）；提供方既不复制也不过滤这些文件，也不会创建或修改登录状态。

每次 query 还会设置 `permissionMode: 'default'`，并配置一个固定的 `canUseTool` 来强制执行 `request.permissionMode`（缺省即为 `read-only`，这是该 seam 文档化的提供方默认值）：对于 `read-only`，采用默认拒绝的只读工具名白名单（`Read`、`Glob`、`Grep`、`WebFetch`、`WebSearch`）；对于 `workspace-write`，再加入 `Write`、`Edit`、`NotebookEdit` 与 `Bash`。这是一份白名单而非黑名单——本钉定尚未枚举到的工具（未来 SDK 新增的工具，或已锁定 SDK 与实际安装 CLI 之间的版本漂移）会保持拒绝，而不会失败开放。两种模式下 `disallowedTools: ['AskUserQuestion']` 都保持不变。

每次 query 都设置 `persistSession: false`。提供方不设置 elicitation 或对话回调，因此固定白名单之外的无人值守交互会因 `canUseTool` 拒绝而失败，而不会等待本提供方不负责的用户界面。

## 能力与上下文

本提供方声明 `permissionMode` 这一启动时能力（如上强制执行），不声明其他任何可选能力，并报告 `inheritsParentContext: false`。Claude Code 会接收独立文本任务、父会话 cwd 与固定的权限范围，但不会接收父会话的对话、角色设定、工具筛选器、深度策略或结构化输出约定。每次运行都拥有独立的 SDK query、取消控制器、CLI 进程和不持久化的产品会话。

## 配置

| 配置键 | 默认值 | 含义 |
|---|---|---|
| `env` | `{}` | 显式指定的 SDK/CLI 环境，叠加在由共享机制清除凭证后的父环境之上。 |
| `disposeGraceMs` | `3000` | 共享进程树责任方各终止层级之间的宽限期，单位为毫秒且须为正有限值，并不得大于仓库共享的 [`MAX_TIMER_DELAY_MS`](../../util/timeout/README.md)；随后资源释放会等待整棵进程树退出。 |

生产环境从子进程执行世界清除凭证后的 `PATH` 解析 `claude`，再应用显式 `env` 条目，并把所得路径作为 `pathToClaudeCodeExecutable` 交给 SDK。在 Windows 上，解析到的 `.cmd` 或 `.bat` 路径会作为带引号、仅供本次 spawn 使用的环境值交给 `cmd.exe /v:off` 展开一次，因此合法路径中的元字符仍只是数据。锁定版本的 SDK 随后把固定命令行选项放在 cmd 的命令尾部；这些选项不含 cmd 元字符，也并不是普通的 Windows argv。原生设置与身份验证继续是权威来源。本插件不安装另一份 CLI、不选择模型、不创建产品主目录、不执行登录，也不探测账户。具有凭证特征的环境变量会在显式 `env` 覆盖生效前被清除，因此供子进程使用的 API 密钥或 token 必须在该配置中显式提供。除非被覆盖，`ANTHROPIC_BASE_URL` 等非凭证端点变量以及 `PATH` 和 `HOME` 等普通环境变量仍会被继承。

随附 profile 会在宿主上加载一次该提供方，而且在工具被调用前不会启动 Claude 进程。完整 Agent Preset 携带下列工具行并设置 `disabled: true`；复制一个 preset 后删除该字段，即可只向由该副本组装的 agent 暴露 `subagent_claude_code`。自定义宿主组装仍可直接使用两条配置行。

```yaml
- id: subagent-claude-code
  name: '@deepseek-ai/dsh-subagent-claude-code'
  config:
    env:
      ANTHROPIC_API_KEY: !!js process.env.ANTHROPIC_API_KEY

- id: tool-subagent-claude-code
  name: '@deepseek-ai/dsh-tool-subagent'
  disabled: true
  config:
    provider: claude-code
    toolName: subagent_claude_code
    enableRunInBackground: false
    maxDepth: provider-managed
```

## 产品兼容性与证据

运行时依赖精确锁定为 `@anthropic-ai/claude-agent-sdk@0.3.220`。生产运行使用原生 `claude` 安装。无密钥真实产品测试使用由 SDK 分发的 Claude Code 2.1.220 CLI 作为确定性 fixture（测试前置数据），并通过同一套原生可执行文件解析路径与 Windows batch shim 路径运行；这项测试不声称兼容每个独立安装的版本。Loader 组合证明两个产品包能够共存且不会启动任一产品。

限定于项目所有者身份的分发授权涵盖官方 SDK 及每个 SDK 版本声明的官方 CLI／平台载荷。[`THIRD_PARTY_NOTICES.md`](../../../THIRD_PARTY_NOTICES.md) 会披露当前可选载荷闭包，但不会认定其中声明的条款属于宽松许可；其他无关的非宽松运行时依赖仍会使第三方声明门禁失败。

## 模型体验

### 子级请求

#### 模型看到的内容

Claude Code 子级会在一个全新的 SDK query 中接收独立文本任务。它的工作区是父会话 cwd，其权限范围在委派时已固定（除非部署方配置 `workspace-write`，否则为 `read-only`）；其模型、系统指令与原生身份验证来自 SDK 自身的默认值与宿主机的产品安装，而非宿主机的文件系统设置（`settingSources: []`）。

#### 对 token 的影响

子级需为独立的 Claude Code 上下文和 query 承担 token 开销。子级 token 不会进入父级上下文。

#### 对 KV Cache 的影响

这与父请求缓存相互独立。能否复用只取决于 Claude Code 自身的模型、指令、工具、原生设置和全新 query。

### 父级工具结果（间接）

#### 模型看到的内容

通过 `dsh-tool-subagent`，父级模型只会看到符合严格成功条件的 Claude Code 最终答案，或者在结果未完成时看到消费方给出的原样错误。一次已分类的 `error` 会以某个分类专属的标题（例如 "subagent could not authenticate with its provider: …"）加上 Claude Code 自身的可操作文本（例如 `"Not logged in · Please run /login"`，已针对凭据形状的模式做过筛查）到达模型。Claude Code 的推理、工具活动、中间消息、stderr、工作区差异、用量信息和产品标识符均不会复制到父会话。

#### 对 token 的影响

父级输入只会增加工具结果中保留的最终答案或错误内容。本提供方自身不添加父级工具 schema。

#### 对 KV Cache 的影响

仅追加：新的工具结果接在可复用的父请求前缀之后。

## 已知限制与后续工作

- **每次运行均新建一个 query 和一个进程**：不支持续接、恢复、池化、进度流或产品会话持久化。
- **`workspace-write` 只是拓宽白名单，并非操作系统级路径限制**：与 `codex` 姊妹提供方的 `sandbox: 'workspace-write'`（操作系统级 seatbelt／landlock 边界）不同，本提供方的 `workspace-write` 只是拓宽了固定的工具名白名单；如果真实 CLI 自身的工具实现允许，模型发起的 `Write`／`Edit`／`Bash` 调用仍可能指向子级自己工作目录之外的路径。该 seam 的 `permissionMode` JSDoc 描述的是限制路径的情形；在这里它只是一个更接近的近似，而非证明。
- **产品安装与账户状态仍由原生机制管理**：`claude` 缺失或不兼容、配置错误或身份验证失败都会呈现为启动错误或运行错误；本插件不提供安装程序或登录流程。
- **SDK 平台 CLI 仍在安装闭包内**：生产环境会忽略它，改用宿主提供的 `claude`，但当前 SDK 的可选依赖仍会安装，并提供无密钥兼容性 fixture。移除该载荷属于独立的产品安装闭包后续项。
- **没有人工交互路径**：`AskUserQuestion` 被禁用，其他交互回调也不存在，因此需要新审批或输入的任务会失败而不会挂起。
- **仅返回最终文本**：推理、中间消息、工具通信、用量信息、stderr 和工作区差异仍只保留在产品内部。
- **除 `permissionMode` 外没有可选的共享能力**：对于本提供方，共享服务会拒绝输出 schema、子任务角色设定、工具筛选和 harness 深度强制约束。
- **没有按实际经过时间触发的超时或副作用回滚**：长时间运行的工作由调用方取消，且取消前已更改的文件或外部系统不会恢复原状。
- **`protocol` 对本提供方不可达**：SDK 端到端地拥有自己的 wire 传输层，因此那里的形状偏差永远不会作为可分类的原因到达本提供方；一次在任何 result 消息之前发生的流或进程崩溃，只会呈现为一个未分类的 `error`。
- **失败分类是针对外部开放词汇表的尽力而为**：`SDKAssistantMessageError` 可能在未来的 SDK 版本中扩充；未识别的值会分类为 `provider` 而不是直接失败关闭。
- **`authMode` 报告的是配置，而非实时账户状态**：它从不探测 `~/.claude`，因此如果部署方设置了一个凭据形状的 `env` 条目但子进程实际并未使用它（或反之），报告的是配置的意图，而不是关于某次运行实际使用了哪个凭据的已验证事实。
