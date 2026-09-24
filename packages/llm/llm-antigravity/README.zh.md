# @deepseek-ai/dsh-llm-antigravity

[English](README.md) | 中文

Antigravity CLI（`agy`）适配器，用于 harness 的 LLM seam：每次 `stream()` 调用都会启动一个 `agy --input-format stream-json --output-format stream-json` 回合，并把其 NDJSON 输出转换为 `StreamChunk` 协议。`agy` 本身是一个带有约 60 个内置工具的完整编程 agent，因此本包的整体设计核心就是让它保持为纯粹的补全后端：固定的提示词前言告诉它绝不要使用那些工具；每个回合都运行在一个全新的不受信任临时目录中，使 headless 模式自动拒绝它尝试执行的任何工具调用；harness 的工具调用则完全在提示词层面实现（agy 没有本适配器可以驱动的原生工具调用参数）。

本包拥有 `antigravity` 这一 provider 路由。为 `antigravity` 注册另一个适配器会抛出 `LlmError('DUPLICATE_ADAPTER')`。它是可选挂载的:没有任何已发布 bundle 挂载它,因为 `agy` 是本地安装、单独授权且单独登录的 CLI,harness 无法假定它一定存在。

包的根导出暴露 Cordis 插件约定与 `AntigravityAdapter`;提示词组装、工具调用协议解析器与子进程分帧不属于该根契约。

## Config

```yaml
- id: llm-antigravity
  name: '@deepseek-ai/dsh-llm-antigravity'
  config:
    binaryPath: agy               # optional; PATH-resolved bare command; this is the default
    printTimeoutSeconds: 300      # optional positive integer; this is the default
    defaultContextWindow: 1048576 # optional positive integer fallback; this is the default
    defaultMaxTokens: 65536       # optional positive integer fallback; this is the default
    models:                       # optional; empty by default (discover via `agy models`)
      - id: gemini-3.8-flash-low
        name: Gemini 3.8 Flash (Low)
        contextWindow: 1048576
        maxTokens: 65536
```

每个字段都由 schema 提供默认值,因此空的 `config: {}` 也是合法的。`resolveAdapterOptions` 是从 schema 归一化后的 config 到已验证适配器构造信息之间唯一的显式 resolve 步骤,会重新检查普通对象字面量仍可能违反的边界(程序化构造会绕过 Schemastery)。

`binaryPath` 直接交给 `spawn()`(裸命令按 `PATH` 解析,与 shell 行为一致)。`printTimeoutSeconds` 在每次调用时都会作为 `--print-timeout <n>s` 传递。

`models` 默认为空。空目录意味着 `listModels` 会通过启动 `agy models` 并解析其 `<id>\t<display name>` 行来发现目录(见下文"模型发现");非空目录则原样提供,不会启动发现进程。`resolveModel` 会优先使用已配置条目自身的 `contextWindow`/`maxTokens`;当目录为空时使用已发现条目的显示名称;其余所有情况都回退到 `defaultContextWindow`/`defaultMaxTokens`。本适配器公布的每个模型都声明 `inputModalities: ['text']`——agy 的回合协议中没有本适配器可以驱动的图像字段。

## 不受信任的工作目录

每次 `stream()` 调用以及每次 `agy models` 发现调用,都会在一个新建的 `mkdtemp(join(tmpdir(), 'dsh-agy-'))` 目录中运行 agy,并在调用结束时(正常结束、出错、调用方中止,或消费方提前停止)于 `finally` 中删除该目录。agy 自身的设置将 harness 代码检出目录与用户主目录列为受信任工作区,因此若在受信任的 cwd 中运行,agy 会静默执行自己的工具(读写文件、运行命令)。本适配器每次调用都新建的目录永远不在该受信任列表中,因此 agy 的 headless print 模式会自动拒绝它在其中尝试的每一次内置工具操作——下文的固定提示词前言是第一道防线,这次 cwd 替换则是应对忽略该前言的模型的兜底强制措施。

## 提示词层面的工具调用

`agy` 没有暴露本适配器认为可靠的 `--tools`/`--json-schema` 参数:探测显示模型会忽略 `--json-schema` 并额外运行一轮去调用 agy 自己的工具。因此 harness 的工具调用完全在提示词中实现,且仅在 `GenerateOptions.tools` 非空时生效:

1. 下文的固定前言始终是 agy 从 stdin 读到的第一段内容。
2. 请求的 `system` 文本(如果存在)。
3. `[Available Tools]` 及其后的工具 schema JSON 序列化结果,仅在 `GenerateOptions.tools` 非空时出现。
4. 下文固定的工具调用协议文本,仅在包含了工具时出现。
5. 消息历史,每条消息渲染为一个 `[ROLE]` 段落;工具调用块渲染为 `[tool-call <id> <name>] <arguments>`,工具结果块渲染为 `[tool-result <call id>] <content>`(`isError` 为真时追加 `error`)。

当提供了工具时,`stream()` 会缓冲整个响应而不是流式输出文本增量(若未提供工具,则恢复块/增量流式输出):在 agy 的终止 `result` 事件之后,响应会被宽松地解析为一个 ` ```json ` 围栏代码块或整段去除首尾空白的文本,期望其形如 `{"tool_calls":[{"name":"<tool>","arguments":{...}}]}` 且至少包含一个格式良好的调用。匹配成功时,围栏之外的非 JSON 文本会成为一个前置文本块,随后是每个调用对应的一个 `tool-call` 块(全新的 `CallId`,其 `arguments` 重新序列化为 JSON 字符串),再是 `usage`,最后是 `finish {kind: 'tool-calls'}`。解析失败时(无效 JSON、`tool_calls` 数组缺失或为空、某个调用缺少字符串 `name` 或对象 `arguments`)——整个响应会成为一个文本块并附带 `finish {kind: 'stop'}`,与未提供任何工具时完全一致。因此当模型忽略该协议而以纯文本作答时,请求会退化为普通文本回合,而不是失败。

## 模型发现(`agy models`)

当目录为空时,`listModels` 会在一个新建的不受信任临时目录中启动 `agy models` 并解析其标准输出:不含制表符的行视为横幅或日志噪音并被跳过,每一行 `<id>\t<display name>` 都会成为一条 `LlmModelInfo`。一次成功的发现会在该适配器实例的生命周期内被缓存——之后的 `listModels`/`resolveModel` 调用会复用结果而不会再次启动进程。一次失败的发现(启动失败、非零退出)不会被缓存:它会以 `LlmError('DISCOVERY_FAILED')` 拒绝并指名 `binaryPath`,下一次调用会重试启动。

## 错误

本适配器抛出的、`dsh-llm` 之外的 `LlmError` 代码:`CONFIG`(agy 可执行文件未找到——`ENOENT`——指名 `binaryPath`)、`TRANSPORT`(其他任何启动失败,或通用子进程失败)、`UNSUPPORTED_CONTENT`(请求中任意位置出现图像或其他非文本块——agy 的回合协议是纯文本的)、`UNSUPPORTED_OPTION`(`GenerateOptions.stop`——agy 未暴露停止序列参数)、`MALFORMED_RESPONSE`(非 JSON 的 NDJSON 行)、`STREAM_CLOSED`(agy 以退出码 0 结束却从未发出 `result` 行)、`SERVER`(agy 的 `result.status` 为 `ERROR`,或 agy 在发出 `result` 行之前以非零退出码退出/因信号而终止,两种情况都携带 agy 的 stderr 尾部)、`AGENT_TOOLS_DENIED`(agy 的 `result` 为 `SUCCESS` 但响应为空且 `denied_actions` 非空列表——它尝试了自己的内置工具,headless 模式全部拒绝了)、`DISCOVERY_FAILED`(`agy models` 无法启动或以非零退出码退出)。响应为空但没有被拒绝的操作并不是一个错误路径:它会以 `finish {kind: 'error', failure: {code: 'EMPTY_RESPONSE'}}` 结束流,这是 dsh-llm 对"回合完成但无内容"这一情形的规范代码。

`options.signal` 中止会以 `SIGTERM` 杀死子进程;若流已经越过其终止事件则报告底层结果,否则会抛出 `LlmError('ABORTED')`。消费方提前停止迭代(`for await` 的 `break`,或生成器自身的 `return()`)会通过 `stream()` 的 `finally` 达到同样的清理效果:仍在运行的子进程会被杀死,临时目录会被删除,不依赖调用方是否观察到了终止分片。

## Model Experience

### Antigravity 请求

#### 模型看到什么

每个请求都以下文固定的补全后端前言开头,随后是请求的 `system` 文本(如果存在),接着——仅当 `GenerateOptions.tools` 非空时——是工具 schema 与下文固定的工具调用协议文本,再之后是渲染后的消息历史(每条消息一个 `[ROLE]` 段落;reasoning 块渲染为 `[reasoning] <text>` 而不是被丢弃,因此上一轮的 reasoning 仍会计入 token 成本)。`temperature` 与 `maxTokens` 会被接受但不会被发送:经验证可用的 `agy` 调用方式没有暴露对应的参数,因此两者都被静默忽略。

##### 补全后端前言

```markdown
You are serving as a text completion backend for another agent runtime (DeepSeek Harness), not as an autonomous coding agent. Never invoke your own built-in tools (run_command, view_file, write_to_file, or any other native action) to answer this request. Read the system instructions and conversation below and reply with exactly the text — or, when a tool-calling protocol is described below, the JSON — that the runtime asks for.
```

##### 工具调用协议文本

```markdown
To call one or more of the tools listed above, reply with ONLY a single JSON object of the exact form {"tool_calls":[{"name":"<tool name>","arguments":{<arguments object>}}]}. A ```json fenced code block wrapping that exact object is also accepted. Emit nothing else: no prose before or after it, and no additional keys. Do not invoke your own built-in tools under any circumstance. If none of the listed tools are needed to answer, reply with plain text instead — do not emit tool_calls JSON in that case.
```

#### Token 影响

除去上文 harness 自己组装的前言、system 文本、工具 schema 与消息历史之外,每个请求还会额外携带约 14k 输入 token 的 agy 自身系统提示词——这是本适配器无法降低或关闭的固定单请求开销,因为 agy 会在读取本适配器的 stdin 载荷之前就在内部组装好它。

#### KV Cache 影响

无:每次 `stream()` 调用都是一个全新的 agy 进程,运行一段全新的对话(单条 `event: user` stdin 消息、一次响应,然后退出)。agy 不报告任何缓存指标,本适配器自身的 `TokenUsage` 也不携带任何 cache 字段,因为根本没有可跨调用复用的缓存可以报告——无论是本会话的历史,还是 agy 自身约 14k 的系统提示词开销,都不会在调用之间被复用。

### Antigravity 响应

#### 模型看到什么

未提供工具时,agy 的 `step_update` 中的 `text_delta` 字段会作为 harness 的 `text-delta` 分片实时流式输出,并由一个携带完整文本的 `block-end` 收尾(存在时使用 agy 终止事件的 `result.response`,否则使用拼接后的增量文本)。提供了工具时,不会有任何实时流式输出;终止响应会按照上文的协议被解析为一个可选的前置文本块,以及每个解析出的调用对应的一个 `tool-call` 块;解析失败时则整个响应作为一个文本块。

#### Token 影响

生成的 token 数量取决于 agy 内部施加的任何上限;`maxTokens` 会被接受但不会被发送(见上文),因此本适配器不报告任何由适配器施加的上限。`TokenUsage` 将 agy 的 `output_tokens`/`input_tokens`/`cache_read_tokens`/`thinking_tokens` 映射到含义相同的 harness 字段;只有 loop 保留下来的块才会影响后续请求的输入。

#### KV Cache 影响

loop 保留的响应块会像其他任何 harness 历史条目一样,追加到下一个请求渲染后的消息记录中;由于该路由从不在调用之间回放任何适配器私有状态(一开始就没有可失效的缓存),上一个响应的内容变化不会以任何方式影响*下一次*调用中那约 14k 的 agy 开销成本。

## Known Limitations and Deferred Work

- **提供工具时不支持流式输出**——使提示词层面工具调用得以实现的"先缓冲后解析"设计,意味着工具模式的回合永远不会实时流式输出文本,即便是最终回复中的自然语言部分也是如此。
- **提示词层面的工具协议只是建议,并非强制**——忽略该指令而自由输出文本的模型会被视为一个有效的非工具回答(`finish {kind: 'stop'}`),而不是协议违反;而一个碰巧输出了格式良好但并非工具调用的 JSON 的模型(例如用 JSON 形式回答某个事实性问题)则会被误判为工具调用。这两种情况都无法从模型自身的遵从程度之外被检测出来。
- **agy 自身内置工具的隔离依赖 headless 自动拒绝加不受信任的临时 cwd,而非硬性沙箱保证**——这两道防线都依赖 agy 自身的 headless 权限逻辑与受信任工作区列表;未来某个改变了其中任一行为的 agy 版本,需要重新验证本包,而不只是更新本 README。
- **纯文本**——请求中任意位置出现的图像(或其他非文本)内容块都会在任何子进程启动之前抛出 `UNSUPPORTED_CONTENT`;agy 的回合协议中没有本适配器可以用来发送图像的字段。
- **`temperature` 与 `maxTokens` 会被接受但不会被发送**——经验证可用的 `agy` 调用方式未暴露这两个参数;未来若 `agy` 新增了它们,本适配器需要相应地开始发送。
- **每次请求约 14k token 的固定开销**——agy 会在读取本适配器的 stdin 之前在内部组装自己的系统提示词,因此没有任何适配器侧的改动能够降低它。
- **不存在跨调用的 KV Cache 复用**——每个请求都是一个全新的 agy 进程与对话;本适配器没有可报告或可利用的会话或提示词前缀复用。
- **配额完全由 agy 自行管理**——本适配器既不读取也不报告底层订阅的剩余配额;配额耗尽只会表现为 agy 自身生成的某种 `result.status: 'ERROR'` 文本。
- **`agy models` 发现结果在适配器实例生命周期内被缓存**——首次发现成功后,底层账号新增的模型在不重启 harness 进程(重新创建适配器实例)的情况下不会被感知到。
