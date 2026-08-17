# @deepseek-ai/dsh-subagent-codex

[English](README.md) | 中文

本包注册固定的 `codex` subagent 提供方。每次接受运行请求后，它都会在发起委托的会话工作区中启动官方 `codex app-server --stdio` 命令，创建一个临时 Codex 线程，提交一个自包含的文本任务，并通过共享的 [`dsh-subagent`](../subagent/README.md) 结果约定仅返回最终答案。

## 启动与所有权

`start(request)` 只接受非空的文本块序列，并根据父会话确定子级 cwd。随后，它通过 [`dsh-subprocess`](../../subprocess/subprocess/README.md) spawn 固定命令，依次执行 `initialize` → `initialized` → `thread/start { cwd, ephemeral: true, sandbox, approvalPolicy: 'never' }`，且仅在 Codex 返回有效的临时线程后才发布此次运行。除非 `request.permissionMode` 为 `workspace-write`，否则 `sandbox` 为 `read-only`；`approvalPolicy` 始终是显式字面量 `'never'`，绝不取自宿主机自身的 `~/.codex/config.toml`，因此同一次委派无论宿主配置如何漂移都表现一致。若在发布前发生失败或取消，它会关闭通信链路、终止受管进程树并等待其退出，然后拒绝 `start()` 调用。

已发布的 `run.result` 恰好启动一个轮次。它只接受与此次运行的线程和轮次匹配的通知，随后等待权威的终止通知 `turn/completed`。以最后一条 `phase: "final_answer"` 的 `agentMessage` 为准；若 Codex 没有发出明确的最终阶段，则以最后一条 `phase: null` 的消息作为兼容性回退。过程说明绝不会取代上述任一答案；成功完成的轮次若没有非空白答案，结果也会判为错误。

对于命令与文件审批，无人值守的提供方会从请求给出的决策选项中选择一项不予批准的决策，并优先选择 `cancel`；稳定的 0.147.0 请求形态没有决策选项列表，因此回退到 `decline`。它对权限请求返回作用域限于当前轮次的空权限集，不向用户输入请求提供任何答案，并拒绝 MCP elicitation。若请求在无人值守模式下没有合法响应，或是未知服务器请求，此次运行就会失败。实际情况是，`approvalPolicy: 'never'` 意味着 codex-core 自身会在需要提升权限的命令上，把拒绝作为函数自身的输出直接给出，而根本不会向本提供方发送审批请求——因此这条无人值守决策路径是由本包自身在协议层的测试来覆盖的，而非由 Codex 拒绝的每一条真实命令来触发。

本地取消会在结果竞态中胜出并映射为 `aborted`。失败轮次的 `codexErrorInfo` 若为 `contextWindowExceeded`，则映射为 `max-tokens`；其他任何远端中断或失败轮次都映射为 `error`，且该提供方不会产生 `refusal`。`dispose()`（资源释放）具有幂等性：如果当前的两个标识符均已知，它会尽力请求 `turn/interrupt`，关闭 JSON-RPC 通信链路，结束标准输入，调用共享的进程树逐级终止机制，并等待整棵进程树退出。结果失败与独立的清理失败仍彼此分离。

### 失败分类

只要 wire 能够对原因分类，`error` 这一 stop reason 就会携带一个已分类的 `SubagentResult.failure`（`auth`/`quota`/`provider`/`protocol`，参见 [`dsh-subagent`](../../../docs/subsystems/subagent.md#the-terminal-result-subagentresult)）。app-server 自身的中间 `error` 通知——`turn/completed` 不会重复它们——携带了有结构的真实原因；针对真实未认证环境的实测表明，终态轮次自身的 `codexErrorInfo` 会退化为字面量 `"other"`，因此本提供方会在整个轮次的 `error` 通知中保留见到过的最具体原因，而不是只信任终态那一个（实测；参见[失败分类 Agent Note](../../../.agents/notes/implemented/feature/2026-08-17-subagent-delegation-failure-classification.md)）。`httpStatusCode === 401` 或 `codexErrorInfo === 'unauthorized'` 分类为 `auth`；`httpStatusCode === 429` 或 `'usageLimitExceeded'`/`'serverOverloaded'` 分类为 `quota`；其他任何原生原因分类为 `provider`；本 wire 自身校验器拒绝的 JSON-RPC 形状偏差分类为 `protocol`。未来某个未识别的 `codexErrorInfo` 值会落到 `provider`，而不是直接失败关闭。`SubagentResult.authMode` 在 `Config.env` 设置了凭据形状的变量名时为 `'api-key'`，否则为 `'subscription'`——纯粹从该配置推导，绝不读取 `~/.codex`。

## 能力与上下文

本提供方声明 `permissionMode` 这一启动时能力（如上文 `thread/start` 上的 `sandbox`），不声明其他任何可选能力，并报告 `inheritsParentContext: false`。Codex 会接收独立文本任务、父会话 cwd 与固定的权限范围，但不会接收父会话的对话、角色设定、工具筛选器、深度策略或结构化输出约定。临时 Codex 线程 ID 与轮次 ID 仅在此次运行内部可见，绝不会持久化到父会话。

## 配置

| 配置键 | 默认值 | 含义 |
|---|---|---|
| `env` | `{}` | 显式指定的子进程环境，叠加在由子进程 seam 清除凭证后的父环境之上。 |
| `disposeGraceMs` | `3000` | 共享进程树责任方各终止层级之间的宽限期，单位为毫秒且须为正有限值，并不得大于仓库共享的 [`MAX_TIMER_DELAY_MS`](../../util/timeout/README.md)；随后资源释放会等待整棵进程树退出。 |

生产环境会从 `PATH` 中解析 `codex`，并使用宿主机原生的 Codex 配置与身份验证。本插件不安装 Codex、不选择模型、不创建 `CODEX_HOME`、不执行登录，也不探测版本。子进程 seam 会移除具有凭证特征的环境变量，因此供子进程使用的 API 密钥必须在 `env` 中显式提供；除非被覆盖，`PATH` 和 `HOME` 等普通环境变量值仍然可用。

随附 profile 会在宿主上加载一次该提供方，而且在工具被调用前不会启动 Codex 进程。完整 Agent Preset 携带下列工具行并设置 `disabled: true`；复制一个 preset 后删除该字段，即可只向由该副本组装的 agent 暴露 `subagent_codex`。自定义宿主组装仍可直接使用两条配置行。

```yaml
- id: subagent-codex
  name: '@deepseek-ai/dsh-subagent-codex'
  config:
    env:
      OPENAI_API_KEY: !!js process.env.OPENAI_API_KEY

- id: tool-subagent-codex
  name: '@deepseek-ai/dsh-tool-subagent'
  disabled: true
  config:
    provider: codex
    toolName: subagent_codex
    enableRunInBackground: false
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

### 父级工具结果（间接）

#### 模型看到的内容

通过 `dsh-tool-subagent`，父级模型只会看到选定的 Codex 最终答案，或者看到消费方针对未成功完成的结果给出的原样错误。一次已分类的 `error` 会以某个分类专属的标题（例如 "subagent could not authenticate with its provider: …"）加上 Codex 自身的可操作文本（已针对凭据形状的模式做过筛查）到达模型。Codex 的过程说明、推理（reasoning）、工具活动、stderr、工作区差异和产品标识符均不会复制到父会话。

#### 对 token 的影响

父级输入只会增加工具结果中保留的最终答案或错误内容。本提供方自身不添加父级工具 schema。

#### 对 KV Cache 的影响

仅追加：新的工具结果接在可复用的父请求前缀之后。

## 已知限制与后续工作

- **每次运行均新建一个进程、一个线程和一个轮次**：不支持续接、恢复、池化、进度流或产品会话持久化。
- **产品安装和账户状态由宿主管理**：`codex` 缺失或不兼容、配置错误或身份验证失败，都会呈现为启动错误或运行错误；本插件不提供安装程序、登录流程或运行时版本门禁。
- **兼容性由开发证据锁定**：若要从已验证的 0.147.0 协议基线升级，必须重新生成上游 schema 证据，并重新运行握手、答案选择、审批、取消、无密钥真实产品以及带密钥的 DeepSeek 随机数测试。
- **没有人工审批路径**：`approvalPolicy` 始终是固定字面量 `'never'`；已知的无人值守审批请求会被拒绝，未知服务器请求会以默认拒绝方式使运行失败；部署方无法通过本包配置允许策略。
- **仅返回最终文本**：推理、过程说明、中间消息、工具通信、用量信息、stderr 和工作区差异仍只保留在产品内部。
- **除 `permissionMode` 外没有可选的共享能力**：对于本提供方，共享服务会拒绝输出 schema、子任务角色设定、工具筛选和 harness 深度强制约束。
- **没有按实际经过时间触发的超时或副作用回滚**：长时间运行的工作由调用方取消，且取消前已更改的文件或外部系统不会恢复原状。
- **失败分类是针对外部开放词汇表的尽力而为**：`codexErrorInfo` 的枚举可能在未来的 app-server 版本中扩充；未识别的值会分类为 `provider` 而不是直接失败关闭，因此一个新的原生原因永远不会被误报为 `auth`/`quota`，但可能最初分类得比该包后续更新之后更粗。
- **`authMode` 报告的是配置，而非实时账户状态**：它从不探测 `~/.codex`，因此如果部署方设置了一个凭据形状的 `env` 条目但子进程实际并未使用它（或反之），报告的是配置的意图，而不是关于某次运行实际使用了哪个凭据的已验证事实。
