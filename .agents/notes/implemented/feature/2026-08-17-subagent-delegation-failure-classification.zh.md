# Agent Note：`codex` 与 `claude-code` 子代理失败分类为 auth/quota/provider/protocol，并附带 `auth_mode`

Status: implemented

[English](2026-08-17-subagent-delegation-failure-classification.md) | 中文

## 问题

每一个原生 `codex`/`claude-code` 委派失败——登录过期、配额耗尽、供应商故障、格式错误的 app-server 帧——都被压平成同一个固定字符串 `'subagent run failed'`。原本能告诉委派模型下一步该做什么（重试、停止，还是让用户去登录）的原生诊断信息，只到达了 `ctx.logger.warn`——一个模型永远看不到的接收端。`SubagentResult` 没有字段可以承载它，所以这种丢失是结构性的，而不是措辞问题。

仅凭协议文档来对 Codex 分类，看起来是显而易见的——读取终态 `turn/completed` 通知上的 `turn.error.codexErrorInfo`——而这样的实现本会悄无声息地上线即坏。针对真实的未认证 `codex app-server 0.147.0`（空 `HOME`，通过真实 JSON-RPC 传输驱动，而非模拟）实测：

```jsonc
// Five retryable intermediate notifications carry the real cause:
{"method":"error","params":{
  "error":{"message":"Reconnecting... 2/5",
           "codexErrorInfo":{"responseStreamDisconnected":{"httpStatusCode":401}},
           "additionalDetails":"unexpected status 401 Unauthorized: Missing bearer …"},
  "willRetry":true,"threadId":"…","turnId":"…"}}

// The terminal turn/completed degrades it to the literal "other":
{"method":"turn/completed","params":{"turn":{
  "status":"failed",
  "error":{"message":"unexpected status 401 Unauthorized: Missing bearer …",
           "codexErrorInfo":"other","additionalDetails":null}}}}
```

`wire.ts` 的 `handleNotification` 此前完全没有处理 `error` 方法——而这恰恰是唯一出现具体原因的地方。只读取终态 turn 的分类器会把每一次真实的未认证运行都报告为 `provider`，永远不会是 `auth`。另外，Claude Code 自己的 result 消息也会让直觉上的 `subtype === 'success'` 成功判断失效：针对真实登出状态的 Claude Agent SDK 0.3.220 实测，`is_error: true` 的同时 `subtype` 仍然是 `'success'`，而实用的登录提示落在 `result` 里，而不是 `errors` 里。

## 决策

`packages/subagent/subagent/src/types.ts` 新增一个封闭、不可合并扩展的 `SubagentFailureCode = 'auth' | 'quota' | 'provider' | 'protocol'` 以及 `SubagentFailureDetail { code, message }`，与 `SubagentStopReasonMap` 正交——原因与[超时 Note](2026-08-17-subagent-delegation-timeout.md) 把它自己的新事实排除在该 map 之外相同：stop reason 回答"运行为什么结束"，而这个字段回答"这是哪一种失败"，并且只有当第一个问题的答案是 `'error'` 时才有意义。`SubagentResult` 新增两个可选字段：`failure?: SubagentFailureDetail`（仅当某个提供方能够对 `'error'` 的 stop reason 分类时才存在）和 `authMode?: 'subscription' | 'api-key'`（仅对两个进程外产品提供方存在）。每一处对 `SubagentFailureCode` 做 switch 的消费方都以 `assertNever` 关闭默认分支——这个联合类型由我们自己关闭。它所分类的目标——那些第三方枚举（`codexErrorInfo`、`SDKAssistantMessageError`）——是外部且开放的：它们自己的默认分支落到 `'provider'`，绝不使用 `assertNever`，因此未来的 app-server 或 SDK 版本会优雅降级，而不是让 harness 崩溃。

**与既有分类法的对齐**（[2026-06-11 Note](../architecture/2026-06-11-structured-error-taxonomy.md)）是机制性的，而非表面的：`dsh-subagent` 已经导出了 `SubagentError extends HarnessError`，用于该 seam 自身的基础设施故障（`NO_PROVIDER`、`DUPLICATE_PROVIDER` 等）。`dsh-tool-subagent` 复用同一个类来承载已分类的失败，新增代码 `SUBAGENT_AUTH` / `SUBAGENT_QUOTA` / `SUBAGENT_PROVIDER` / `SUBAGENT_PROTOCOL`——而不是 `dsh-llm` 的 `MISSING_CREDENTIAL`/`INVALID_CREDENTIAL`/`QUOTA`，后者命名的是另一个失败领域（harness *自己*的凭据存储，或它*自己*的 LLM adapter 路由，而不是被委派子代理产品自身独立的登录状态）。从既有的 `stopReasonFailure` → `settleForegroundRun` 抛出点复用 `SubagentError`，意味着可路由的 `code` 会到达 `ToolExecutionResult.error.info`——并通过 agent loop 既有的转发机制，到达 `tool/result` 会话事件——完全走六月那份 Note 已经搭好的管道（`errorInfo()` 的 `instanceof HarnessError` 检查）。没有新的会话事件，也没有并行的分类机制。

**Codex**（`subagent-codex/src/wire.ts`）：`handleNotification` 新增一个 `error` 方法分支（按 thread/turn 作用域限定，与 `item/completed` 完全一致，包括对一个抢先于 `turn/start` 自身响应到达的通知的早到队列）。它会保留在整个 turn 中见到的最具体的 `codexErrorInfo` 标签及任何对象变体的 `httpStatusCode`：一个不是 `'other'` 的标签总会覆盖已保留的值，但 `'other'` 永远不会覆盖已经保留下来的具体值。`classifiedTurnFailure` 在 `turn/completed` 时根据保留的状态构建失败对象，只有在整个 turn 都没有触发过任何 `error` 通知时，才回退到终态 turn 自身（可能已退化的）`codexErrorInfo`。`classifyCodexFailure` 实现了实测得到的对应表：`httpStatusCode === 401` 或 `codexErrorInfo === 'unauthorized'` → `auth`；`httpStatusCode === 429` 或 `'usageLimitExceeded'`/`'serverOverloaded'` → `quota`；其余 → `provider`。`object()`/`string()`——wire 自己的 JSON-RPC 形状校验器——现在会抛出 `code: 'protocol'` 的 `ClassifiedSubagentFailure`：这正是规范对该分类的定义，而且几乎零成本，因为这两个函数是 wire 唯一的形状校验面。

**Claude**（`subagent-claude-code/src/run.ts`）：`resultFields()` 直接从原始消息对象读取 `is_error`/`terminal_reason`/`api_error_status`/`result`/`errors`，而不是通过 SDK 自身的 `SDKResultMessage` 联合类型做窄化——该联合类型的判别字段（`subtype`）正是实测证明不可靠的那个字段。`consumeClaudeQuery` 现在也会消费 `assistant` 消息（此前完全跳过），以保留可分类的最具体 `SDKAssistantMessageError`（`authentication_failed`/`oauth_org_not_allowed` → `auth`；`rate_limit`/`billing_error`/`overloaded` → `quota`；其余 → `provider`；`max_output_tokens` 是单条消息级别的截断提示，不是终态失败信号，会被跳过）。在终态 `result` 消息处，由 `is_error`（绝不是 `subtype`）决定是否失败；保留下来的 assistant 原因优先于 `api_error_status`（401/429），后者又优先于通用的 `provider` 默认值。`'protocol'` 对 Claude 永远不会出现：SDK 完全屏蔽了自己的 wire 传输层（记录在包 README 的 Known Limitations 中）。

`ClassifiedSubagentFailure extends Error`（`dsh-subagent/src/out-of-process.ts`）是包内私有的载体：某个提供方的 turn 尝试抛出它，`settleRunResult` 的 catch 会在捕获到的值是该类型时，把 `.failure` 提取到已结算的 `SubagentResult` 上——与既有的 `onError` 诊断接收端提取方式并列。`RunResultSettlement` 还新增了一个可选的 `authMode`，会合并到每一个已结算的分支上（成功、被中止、出错皆然）——这是关于子代理身份的事实，而不是关于其结果的事实，因此它不是 return 风格的特殊情况。

`auth_mode`（Phase 2-5）纯粹从配置推导，符合简报中明确禁止探测 `~/.claude`/`~/.codex` 的要求：每个提供方的 `index.ts` 对 `Config.env` 自身的键计算 `SENSITIVE_ENV_PATTERN.test(key)`（与 `@deepseek-ai/dsh-subprocess` 的 `scrubbedParentEnv` 已经使用的、用于阻止凭据流入子代理继承环境的同一个正则）——`scrubbedParentEnv` 保证该正则是 API key 到达子代理的*唯一*路径，因此对部署自身显式的 `env` 做该项检查是一个完备的检查，而不是启发式方法。

**脱敏**（`dsh-tool-subagent`）：本 PR 是第一个把原生提供方文本导入模型可见结果、并借此导入会话日志的变更。`redactCredentialShapedText` 匹配一个凭据形状的标签（复用同一套 `SENSITIVE_ENV_PATTERN` 词汇表的 `.source`，而不是复制一份）紧跟 `:`/`=` 和一个值，并只对值部分脱敏。它只在一个地方集中运行——`classifiedFailureHeadline`——而不是分散在每一处可能构造 `SubagentFailureDetail.message` 的地方，因此脱敏步骤只有一个可审查的位置。

## 考虑过的替代方案

- **仅从终态 `turn.error.codexErrorInfo`对 Codex 分类**——基于直接实测予以拒绝（见"问题"一节）：真实的未认证运行会把该字段退化为字面量 `"other"`，因此这种实现会把每一次真实的 401 都分类为 `provider`，永远不会是 `auth`。这是本 Note 中最重要的被拒绝方案：这是仅凭协议文档写出的第一版实现，而且它会悄无声息地永远不匹配。
- **消费 Claude 的 assistant 消息以获取 `SDKAssistantMessageError`** 对比仅从 result 消息的 `api_error_status` 分类——规范把这个选择留给了实现者，并要求无论怎么选都要记录理由。选择：消费它们。在实测的登出捕获中，result 消息的 `api_error_status` 是 `null`（本地 CLI 拒绝根本没有发出 HTTP 请求），因此仅用 result 的分类器要对这个确切场景得到 `auth`，就需要对 `result` 做文本模式启发式匹配——一旦措辞变化就很脆弱。而 assistant 消息自身的 `error: "authentication_failed"` 对同一场景来说，是来自 pinned SDK 自身类型的一个干净、有版本约束的枚举，因此把它保留为首选信号，`api_error_status`（401/429）则作为未来某个不带 assistant 消息原因的场景的兜底。
- **复用 `dsh-llm` 的 `MISSING_CREDENTIAL`/`INVALID_CREDENTIAL`/`QUOTA` 代码** 作为已分类的 `SubagentError`——予以拒绝：这些代码命名的是 harness *自己的*凭据存储或它*自己的* LLM adapter 请求路径中的失败。被委派的 Codex/Claude Code 子代理的登录状态是另一个、由产品自身拥有的身份；在两者间复用同一个代码字符串，会让未来某个重试/沙箱插件的 `switch (error.code)` 把两种不相关的恢复动作（"刷新 harness 自己存储的 key" 对比 "被委派子代理自己的登录过期了"）混为一谈。
- **新增一个与 `SubagentError` 并列的 `SubagentFailureError` 类**——考虑过后予以拒绝：`dsh-subagent` 已经为这个 seam 自身的类型化失败导出了 `SubagentError extends HarnessError`。为这个 seam 的第二种失败再建一个类，是对六月那份分类法 Note 要求所有 seam 收敛到的那个类的重复；在既有类上加一个新 `code`，才是范围正确得多的更小改动。
- **一个会启动真实 `codex`/`claude-code` 二进制的 keyless snapshot**——予以拒绝：既有的 `product-subagent-codex.cordis.yml` 明确表示（它自己的注释）"在不启动 Codex 的情况下固定被组装的请求 schema"，而包级别的 `real-product.spec.ts` 套件已经证明了真实二进制路径（见"测试"）。已交付的 snapshot 转而遵循既有的 `subagent-durability-failure.ts` 模式：一个仅用于 snapshot 的 fixture 插件包裹 `ctx.subagents.start()`，在一个真实的（被脚本化、keyless 的）forked 子代理完成其真实回合之后，把已结算的结果替换成一个固定的已分类失败——这精确地证明了 `dsh-tool-subagent` 的新文本构造代码，而不需要第二条更慢、可移植性更差的让子代理失败的路径。

## 后果

- 一个从未遇到 `codex`/`claude-code` 提供方的 `spawn`/`fork`/`acp`/`dsh-sdk` 组合不受影响：`failure` 和 `authMode` 都是这些提供方从不填充的可选字段，任何既有的 `SubagentResult` 字面量都不需要该字段即可保持有效。
- 一次 `codex` 或 `claude-code` 的委派失败现在会带着一个分类专属的标题（`"subagent could not authenticate with its provider: …"`、`"…hit its provider's usage limit: …"`、`"…provider failed: …"`、`"…provider violated its own protocol: …"`）以及提供方自己的可操作文本（已针对凭据形状的模式做过筛查）到达模型，并在 `ToolExecutionResult.error.info` 上带有一个可路由的 `SUBAGENT_*` 代码，供未来的重试/沙箱插件使用。
- `SubagentStopReasonMap` 未被触碰；一个非 `'error'` 的 stop reason（`aborted`、`max-tokens`、`refusal`、未来某个未知原因）永远不会带有 `failure`，其报告方式与本 PR 之前完全一致。
- 真实产品测试（`subagent-codex/tests/real-product.spec.ts`、`subagent-claude-code/tests/real-product.spec.ts`）通过各自提供方自己的真实二进制/SDK 对接本地 fixture 后端，在不需要任何真实产品订阅的情况下证明了两个方向：一个由 fixture 提供的 401 会通过完整的保留路径分类为 `auth`（Codex），而一个确实被省略的 `ANTHROPIC_API_KEY` 会以精确的 `"Not logged in · Please run /login"` 文本分类为 `auth`（Claude）——Claude 这个场景中 fixture 后端甚至根本没有被调用，因为真实 CLI 在本地就拒绝了。`usageLimitExceeded`/`serverOverloaded`/`httpStatusCode: 429`（Codex）和 `rate_limit`/`billing_error`/`overloaded`（Claude）都通过字面量枚举值覆盖，绝不触发真实的速率限制。`packages/subagent/tool-subagent/tests/redaction.spec.ts` 直接证明了脱敏这一性质：一个凭据形状的标签/值对会被脱敏，而一个非凭据形状的运维标识符（实测的 `cf-ray`/`request id`）不会。`examples/acp-agent/tests/snapshots/subagent-classified-failure/` 在一份真实组装出的 ACP 会话日志中，逐字固定了确切的模型可见文本以及 `tool/result` 事件的 `error: {"name":"SubagentError","code":"SUBAGENT_AUTH"}`。
