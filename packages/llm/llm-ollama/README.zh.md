# @deepseek-ai/dsh-llm-ollama

[English](README.md) | 中文

面向 harness LLM（大语言模型）seam 的 Ollama 适配器：直接用 `fetch` + NDJSON 访问本地或自托管服务器的 `POST {baseURL}/api/chat`，把该路由的协议格式翻译为 `StreamChunk` 协议。该路由无需认证，因此本包没有凭据引用、没有密钥解析，除共享归因请求头之外也没有任何请求身份标识。

本包拥有 `ollama` 提供方路由。为 `ollama` 再注册一个适配器会抛出 `LlmError('DUPLICATE_ADAPTER')`。

包根导出 Cordis 插件约定与 `OllamaAdapter`；协议序列化、NDJSON 分行与分片翻译辅助函数不属于该根约定。

## 配置

```yaml
- id: llm-ollama
  name: '@deepseek-ai/dsh-llm-ollama'
  config:
    baseURL: http://localhost:11434 # optional; $OLLAMA_BASE_URL then the default local server when omitted
    maxTokens: 2048           # optional positive per-request output cap; this is the default
    defaultContextWindow: 4096 # optional positive-integer fallback; this is the default
    streamIdleTimeoutMs: 300000 # optional; positive finite Node timer delay; five-minute default
    retryPolicy:              # optional; omission uses bounded normal defaults
      mode: always            # normal | always
      backoff:
        initialDelayMs: 500
        maxDelayMs: 10000
        jitterRatio: 0.1
    models:                   # optional; empty by default
      - id: moondream:latest
        name: Moondream
        contextWindow: 2048
        inputModalities: [text, image]
      - id: qwen3:8b
        contextWindow: 40960
```

插件注册单一提供方路由 `ollama` 及其已解析的 `retryPolicy`。请求用 `provider: ollama` 选中它；其 `model` 原样作为协议 `model` 字符串传递，与 `ollama list` 报告的写法完全一致（含 tag），因此拉取新模型不需要在生命周期时重新注册。目录条目通过 `ctx.llm.listModels('ollama')` 暴露给 ACP 编辑器、Web 选择器等客户端，但仅供参考：未列出的模型 id 仍原样通过。条目省略 name 时默认取其 id。

`models` 默认为空：服务器拉取了哪些模型属于本包无法知晓的部署状态，写死一个名字会宣告一个服务器可能并不具备的模型。因此空目录不宣告任何模型，而每个请求 id 仍作为纯文本直通模型解析。

`contextWindow` 对每个已配置模型可选。`ctx.llm.resolveModelInfo('ollama', model).context` 优先返回模型的精确值，其次为无容量条目和未列出的直通 id 返回 `defaultContextWindow`。4,096 token 的默认值刻意保守——该路由服务的模型都很小，而想要精确值的部署可用 `ollama show` 查看每个模型真实的 `context_length`。

`maxTokens` 是适配器配置的输出上限，默认 2,048。目录条目可携带自己的 `maxTokens`，对该模型优先生效。精确模型解析把胜出值暴露为 `defaultMaxTokens`；`LlmRuntime` 在 agent loop（智能体循环）写入 `request/header` 之前把该值物化进 `GenerateOptions.maxTokens`，因此协议请求始终可重建。请求或 `AgentOptions.maxTokens` 的显式值优先，并序列化为 `options.num_predict`。适配器不会用 `contextWindow` 裁剪该预算。

`streamIdleTimeoutMs` 限定每次未完成的提供方读取（含首次 `fetch`），不计入消费方在分片之间花费的时间。每一行 NDJSON 都会重新武装一次未完成的读取，包括内容增量为空、因而不产生 `StreamChunk` 的行。整个调用期间有一个稳定的中止信号同时到达请求与响应体读取器；超时会停止传输并抛出 `LlmError('TIMEOUT')`，而更早的调用方中止抛出 `LlmError('ABORTED')`。适配器每次 `stream()` 调用只发起一次提供方请求；它把已配置策略注册为提供方元数据，而 `dsh-llm-retry` 在持久化的 agent 步骤边界上独立执行该策略。

## 图像输入

图像支持靠声明，绝不靠探测：只有当某个目录条目在其 `inputModalities` 中写明 `image` 时，该模型才接受图像块。省略或留空该列表意味着仅支持文本，未列出的直通 id 同理，因此为任何未声明模型携带图像的请求会在任何网络 I/O 之前以 `LlmError('UNSUPPORTED_CONTENT')` 失败。这样，配置有误的部署会拒绝图像，而不是把字节发给一个只会盲答的纯文本模型。

已声明的图像请求通过可选的 `ctx.attachments` 服务读取字节，并以 base64 编码放入协议消息的 `images` 数组，与该消息拼接后的文本并列。若未挂载附件服务，同样的请求会以 `UNSUPPORTED_CONTENT` 失败，而不是丢弃图像。

## 动态配置（settings）

连接事实并非在加载时冻结。`resolveAdapterOptions` 是从原始配置到已校验事实的唯一显式解析步骤，适配器通过一个 thunk **每次操作**重新读取它们：base URL、目录、输出上限和空闲预算都在下一次请求生效，而进行中的流保持它启动时的事实。

插件用同一份 `Config` schema 注册 `llm-ollama` 命名空间，并以其 `cordis.yml` 配置项作为组合 `base`，因此用户设置文档中的 `llm-ollama:` 分区可以无需重启地覆盖任意字段。未挂载 settings 服务时，仅由配置项驱动适配器，行为不变。通过 schema 但违反 schema 之外边界（目录 id 重复、未知输入模态）的实时 settings 快照会保留上一份可用事实并记录该失败；配置项本身仍会让插件加载失败。

唯一在注册时捕获的事实是重试策略：其解析值变化时，插件会原地重新注册路由（同一适配器实例、一个同步区段），因此 `ctx.llm.providerRetryPolicy('ollama')` 始终报告当前策略。

插件还在可配置提供方目录（`ctx.llm.listConfigurableProviders()`）中声明自己的路由：提供方 `ollama`、settings 命名空间 `llm-ollama`、空 settings 路径——整个分区就是该 profile。

## 应用归因

每个请求都携带来自 dsh-llm `attributionHeaders()` 的共享归因请求头——标识 harness 的强制 `User-Agent` 基线（见 [dsh-llm § 应用归因](../llm/README.md#app-attribution-attributionts)）。除此之外不添加任何内容：Ollama 服务器不需要凭据，本适配器也不发送用户、会话或用途请求头。

## 协议格式说明

以 `ollama serve` 0.33.1 实测为准。

- 仅流式。`POST /api/chat` 配 `stream: true` 返回原始 NDJSON——每行一个完整 JSON 对象、以 `\n` 结尾，没有 `data:` 前缀，也没有带外终止符。
- 终止依据是最后一行上的 `"done": true` 字段，而非哨兵字符串。该行同时携带 `done_reason` 和 token 计数，因此 `block-end`、`usage` 和 `finish` 全部推迟到它：`usage` 始终先于 `finish`，且 `finish` 之后不再有任何内容。
- Token 记账：`inputTokens` ← `prompt_eval_count`，`outputTokens` ← `eval_count`。Ollama 不报告任何缓存指标，其 prompt 计数也没有需要减去的缓存拆分。终止行两个计数都未报告时不发出 `usage` 分片。
- `done_reason` 把 `stop` 映射为 `stop`、把 `length`（`num_predict` 上限）映射为 `max-tokens`；其他任何值都变成 `finish {kind: 'error', failure}`，并以该值的大写形式作为 `code`。
- 生成参数嵌套在 `options` 下：`num_predict` ← `maxTokens`、`temperature`、`stop`。Ollama 会忽略其中的未知成员，因此只发送实测过的字段，且请求未设置任何参数时整个对象被省略。
- 分行只做切分与修剪；流结束时非空且未终止的尾部按截断处理，而没有 `done: true` 行就结束的流以 `STREAM_CLOSED` 失败。
- 序列化把每条 harness 消息映射为一条同角色的协议消息，其文本块拼接进 `content`。assistant 的 reasoning 块被丢弃——该路由没有回传它们的字段。

## 错误

非 2xx 响应抛出带稳定 code 的 `LlmError`：`UNKNOWN_MODEL`（404——服务器未拉取该模型）、`INVALID_REQUEST`（400——包括向不支持工具的模型发送 `tools` 请求，以及无法解码的图像字节）、`RATE_LIMIT`（429）、`SERVER`（5xx），其余为 `HTTP_<status>`。错误体是一个纯字符串成员 `{"error": "<message>"}`，它会成为失败消息；缺失、为空或无法解析的响应体则保留状态行消息。其可序列化的 `failure` 保留 HTTP 状态码。Ollama 不发送 `Retry-After`，也不发送 request-id 请求头，因此二者都不会出现在失败中。

响应前的传输失败（服务器未运行、DNS、连接被拒）抛出 `TRANSPORT`，消息中点明已配置的端点并把原始拒因链接为 `cause`；调用方中止抛出 `ABORTED`，且循环的取消信号仍具权威性。协议违规抛出 `STREAM_CLOSED`（没有终止行）或 `MALFORMED_RESPONSE`（某行不是 JSON）。以带内 `{"error": …}` 行送达的生成失败抛出 `SERVER`，默认策略会重试。已完成的流若其 `stop`（或缺失）原因没有打开任何内容块，则变成 code 为 `EMPTY_RESPONSE` 的 `finish {kind: 'error'}`（默认同样会重试）。该路由无法表达的请求在任何网络 I/O 之前失败：声明的工具 schema 抛出 `UNSUPPORTED_OPTION`，历史中的 `tool-call` 或 `tool-result` 块抛出 `UNSUPPORTED_CONTENT`。

## 模型体验

### Ollama 请求

#### 模型看到的内容

被选中的本地模型收到作为协议 `system` 消息的 harness 系统提示词、按每条 harness 消息一条协议消息呈现的消息历史，以及该请求的输出上限、temperature 和停止序列——没有适配器自撰的提示词文字。已声明的视觉模型还会额外收到每张用户图像的 base64 字节，与该消息的文本并列。上一轮 assistant 的 reasoning 被省略，而携带工具 schema 或工具块的请求根本不会到达模型。

#### Token 影响

精确输入由提供方的分词决定。丢弃先前的 reasoning 避免再次为这些 token 付费；一张图像贡献该模型自身的图像 token 展开量，终止行把它计入 `prompt_eval_count`。

#### KV Cache 影响

Ollama 在自己的 KV Cache 中保留已加载模型的 prompt 前缀，因此未改变的已组装前缀可被复用。上游提示词、历史或图像的任何变化都可能使复用从第一个改变的 token 起失效，而模型路由变化会选中不同的缓存域。本适配器不报告任何缓存指标，因为该路由本身不报告。

### Ollama 响应

#### 模型看到的内容

可见文本被翻译成单个 harness 文本块，供循环记录与组装。

#### Token 影响

生成的 token 遵循请求中已记录的 `maxTokens`，它以 `options.num_predict` 越过协议；只有被循环保留的块会影响后续输入。

#### KV Cache 影响

被循环保留的响应块追加到下一次请求，并保持其更早的可复用前缀；被丢弃的块对后续缓存没有影响。

## 已知限制与暂缓事项

- **不支持工具调用** —— 适配器以 `UNSUPPORTED_OPTION` 拒绝 `GenerateOptions.tools`，以 `UNSUPPORTED_CONTENT` 拒绝 `tool-call`／`tool-result` 历史，因此该路由无法服务 agent loop 的工具步骤。Ollama 的 `/api/chat` 确实为 `capabilities` 含工具的模型接受 `tools`；接通它需要本包尚未拥有的工具调用增量翻译与历史回传。
- **不支持 reasoning** —— Ollama 的 `thinking` 请求字段和 `message.thinking` 响应字段均未映射，因此 `resolveModelInfo` 不暴露任何 reasoning 级别，具备思考能力的模型的 reasoning 也永远不会到达 harness。
- **模型的图像支持靠声明而非探测** —— `GET /api/tags` 会报告每个模型的 `capabilities`（含 `vision`），但适配器从不读取它：改由部署为每个目录条目写明 `inputModalities`。自动探测需要一份对可变的服务端模型列表做缓存和失效的视图，本范围不足以支撑。缺少声明时安全失败（图像被拒绝）。
- **`GET /api/tags` 未暴露为模型发现** —— 这里没有实现 `ctx.llm.registerModelDiscovery`，因此配置界面无法列出服务器已拉取的模型。
- **settings 中的 `models` 列表整体替换组合列表** —— settings 分层合并按字段进行，而数组就是一个字段；按条目合并目录需要一个带键的结构。
- **没有上下文溢出分类** —— Ollama 对超长 prompt 按 `num_ctx` 截断而不是拒绝，因此没有任何请求会产生 `CONTEXT_WINDOW_EXCEEDED`，而超预算的 prompt 会静默丢掉最旧的 token。为每个模型配置真实的 `contextWindow` 才能让循环自身的压力处理保持诚实。
- **服务器前置的认证代理不在范围内** —— 适配器不发送凭据，因此 401 或 403 表现为未分类的 `HTTP_401`／`HTTP_403`。
- **请求使用原始 `fetch`，而非 `@cordisjs/plugin-http`** —— 没有共享的代理／拦截配置，与 DeepSeek 适配器的暂缓保持一致。
- **序列化把消息内容压平为文本块与图像** —— 插件新增的块类型会被跳过。
