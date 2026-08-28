# Agent Note: 面向本地模型的 Ollama 提供方路由

Status: implemented

[English](2026-08-27-ollama-llm-provider.md) | 中文

## Problem

本地的 `ollama serve` 是运行小型视觉模型最便宜的方式——例如判断一张人像是实拍还是插画——但已发布的两个适配器都无法访问它。`dsh-llm-deepseek` 讲的是带 `[DONE]` 哨兵的 SSE（Server-Sent Events）和 OpenAI 兼容的 chat-completions 请求体，其整条凭据路径（`apiKeyEnv`、按请求解析密钥、`MISSING_CREDENTIAL`、匿名 user-id 请求头）都假定端点是需要认证的远端。`dsh-llm-pi-ai` 只能通过 pi-ai SDK 自身的目录访问提供方，无法寻址该 SDK 未建模的路由。Ollama 原生的 `/api/chat` 恰好在那两个适配器固化的每一条轴上都不同：它流式返回没有分帧前缀的原始 NDJSON，用 JSON 字段而非带外字符串标记终止，只在该终止行上报告 token 计数，而且完全不需要凭据。

## Decision

`packages/llm/llm-ollama`（`@deepseek-ai/dsh-llm-ollama`）是一个新的提供方包，拥有单一路由 `ollama`，由一个 function plugin 注册到 `ctx.llm`，其结构照搬 `llm-deepseek` 但去掉全部凭据关切：从原始配置到已校验连接事实的唯一 `resolveAdapterOptions` 步骤、让 settings 修改在下一次请求生效的按操作 thunk，以及针对唯一在注册时捕获的事实（重试策略）的 `registration.replace([PROVIDER])`。协议上唯一的 harness 请求头是 `attributionHeaders()` 的 `User-Agent`。

本包沿协议切分：`ndjson.ts` 只对以 `\n` 结尾的行分帧，对协议一无所知；`translate.ts` 拥有终止判定，因为 Ollama 的流结束标志是某一行内部的 `"done": true` 字段，而不是分帧层能够识别的哨兵。这是与 `llm-deepseek` 唯一的结构差异——那里 `sse.ts` 自己检测 `[DONE]`，`translate.ts` 只是对它作出反应。因此 `translate.ts` 也拥有 `STREAM_CLOSED`（行序列在没有终止行的情况下结束）、`MALFORMED_RESPONSE`（某行不是 JSON），以及以带内 `{"error": …}` 行送达的生成失败所用的 `SERVER`。

该路由只服务一条可见文本通道，因此任何时刻最多只有一个 harness 块打开，索引为 0。`block-end`、`usage` 和 `finish` 全部推迟到终止行——它也是唯一携带 `prompt_eval_count`／`eval_count` 的行——因此 `usage` 始终先于 `finish`，且其后不再有任何内容。`done_reason` 把 `stop` 映射为 `stop`、把 `length` 映射为 `max-tokens`（两者均在实际运行的服务器上实测），其他任何值都变成以其自身大写形式为 code 的错误结束。

工具调用与 reasoning 被拒绝，而非近似处理。`GenerateOptions.tools` 抛出 `UNSUPPORTED_OPTION`，历史中的 `tool-call` 或 `tool-result` 块抛出 `UNSUPPORTED_CONTENT`，两者都在任何网络 I/O 之前；`resolveModel` 不暴露任何 reasoning 级别。把工具结果静默压平成文本会在看起来成功的同时改变模型正在回答的内容。

图像支持按目录条目声明（`inputModalities: [text, image]`），绝不探测。省略或留空该列表，以及每个未列入目录的直通 id，都意味着仅支持文本——这正是 `llm-deepseek` 的 `resolveModel` 已在使用的负能力约定——因此针对未声明模型的图像请求会在任何请求之前以 `UNSUPPORTED_CONTENT` 失败。已声明的图像请求通过可选的 `ctx.attachments` 服务解析字节，并以 base64 编码放入协议消息的 `images` 数组；未挂载该服务时请求失败，而不是丢弃图像。

`models` 默认为空。服务器拉取了哪些模型属于本包无法知晓的部署状态，因此写死一个默认名字会宣告一个服务器可能并不具备的模型。

### 实测的协议事实

`ollama serve` 0.33.1、`moondream:latest`，经由 `curl`：

- `POST /api/chat` 配 `stream: true` 每行返回一个完整 JSON 对象、以 `\n` 结尾，没有 `data:` 前缀。
- 终止行携带 `"done": true`、`done_reason`、`prompt_eval_count` 和 `eval_count`；其 `message.content` 为 `""`。
- 对长篇提示词使用 `options.num_predict: 5` 可复现 `done_reason: "length"`；`options.stop` 与 `options.temperature` 均被接受；`options` 中的未知成员被忽略，请求仍返回 HTTP 200。
- 错误发生在流之前：非 2xx 状态配一个纯 `{"error": "<string>"}` 响应体——服务器未拉取的模型返回 404，对无工具能力的模型使用 `tools` 以及无法解码的图像字节返回 400。
- 用户消息上的 `images: ["<base64>"]` 驱动视觉路径；字节不带 `data:` URI 前缀。

## Alternatives considered

- **改用 Ollama 的 OpenAI 兼容端点 `/v1/chat/completions`，复用 `llm-deepseek` 的适配器** —— 被否决：原生路由的 `images: string[]` 是一个扁平的 base64 字符串数组，而兼容路由要求 OpenAI 的嵌套 `content: [{type: 'image_url', image_url: {url: 'data:...'}}]` 分片，因此更简单的协议是原生那条。兼容层还多做了一次 Ollama 自己就会做的翻译，并且用 OpenAI 的名字而非 `ollama show` 和服务器日志所用的名字报告 usage。
- **像 `llm-pi-ai` 那样的多 profile 提供方字典** —— 被否决：那种结构的存在是为了在一个 SDK 背后区分多个厂商。一个 Ollama 部署就是一个 base URL 上的一台服务器；第二台服务器是第二条 `cordis.yml` 配置项的事，而不是一个插件内部按路由建键的字典。
- **从 `GET /api/tags` 的 `capabilities` 数组探测图像支持** —— 在本范围内被否决：该字段确实存在且会报告 `vision`，但消费它意味着对可变的服务端状态做缓存和失效，而这条请求路径必须快速失败。声明只需一行配置、缺失时安全失败，并且该暂缓已记录在包 README 的限制小节。
- **把 401／403 映射为 `AUTH`** —— 被否决：本包不解析任何凭据，因此 `AUTH` code 会指向一个它并不提供的修复方式。服务器前置的认证代理不在范围内，其状态码表现为 `HTTP_401`／`HTTP_403`。
- **把空的 `inputModalities` 列表当作配置错误拒绝** —— 实测后被否决：Schemastery 会把省略的数组成员规范化为 `[]`，因此在解析器处空列表与缺失列表无法区分。把两者都当作「仅文本」是唯一自洽的读法。

## Consequences

- 部署需要显式说明每个视觉模型的图像支持；缺少声明会拒绝图像而不是发送它，这是安全的方向，但确实意味着该失败是配置失败而非提供方失败。
- 没有工具调用与 reasoning，该路由无法驱动 agent loop（智能体循环）的工具步骤。它服务单次分类与描述调用，而这正是它被加入的用途。
- 4,096 token 的 `defaultContextWindow` 与 2,048 token 的 `maxTokens` 默认值是按小型本地模型的量级取的，并非从其中任何一个推导而来；想要精确值的部署可读 `ollama show` 并按模型配置。
- Ollama 对超长 prompt 按 `num_ctx` 截断而不是拒绝，因此没有任何请求会产生 `CONTEXT_WINDOW_EXCEEDED`，超预算的 prompt 会静默丢掉最旧的 token。为每个模型配置真实的 `contextWindow` 才能让循环的压力处理保持诚实。
- 默认组合包（`packages/bundle/base`）不挂载本包的任何内容；该路由只对添加了该配置项的组合存在。

## Testing

- `packages/llm/llm-ollama/tests/ndjson.spec.ts` —— 跨读取切分的分行、多字节字符在序列中间被切开、空行、`\r\n` 终止符、被丢弃的未终止尾部，以及每个产出行一次的活动回调。
- `packages/llm/llm-ollama/tests/translate.spec.ts` —— 推迟的 `block-end`／`usage`／`finish`、终止行上的文本、含未知值的 `done_reason` 映射、只有一个或两个计数都没有的 usage、`EMPTY_RESPONSE`、`MALFORMED_RESPONSE`、带内错误行，以及 `STREAM_CLOSED`。
- `packages/llm/llm-ollama/tests/serialize.spec.ts` —— 角色与文本映射、省略与填充的 `options`、被拒绝的工具 schema 与工具块、base64 图像顺序、缺少附件服务的图像，以及被丢弃的 reasoning。
- `packages/llm/llm-ollama/tests/adapter.spec.ts` —— 用 NDJSON mock 服务器验证请求体与请求头（归因存在、没有 `authorization`）、针对纯字符串错误体的每一类 HTTP 状态、传输与中止分类、含无内容行重新武装的空闲看门狗、四种图像 gating 拒绝与被接受的已声明路径、HMR（热模块替换）安全的注册、目录解析，以及每一项配置边界。
- `packages/llm/llm-ollama/tests/dynamic-config.spec.ts` 与 `loader-composition.spec.ts` —— settings 热重载与原地重试策略重新注册，随后是同一条链经真实 Loader 从仅供测试的 `cordis.yml` 启动，分别带与不带 settings 配置项。
- `packages/llm/llm-ollama/tests/adapter.e2e.ts` —— 由 `$DSH_LLM_OLLAMA_E2E` 把关的真实本地服务器。这个开关是一个显式变量而非端点可达性：无需认证的服务器不能仅因正在运行就打开无密钥车道的测试套件。
