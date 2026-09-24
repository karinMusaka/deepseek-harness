# Agent Note: 一个 Antigravity CLI（agy）提供方路由，把一个完整编程 agent 驱动为纯文本 chat 后端

Status: implemented

[English](2026-09-24-antigravity-cli-adapter.md) | 中文

## Problem

本地的 Antigravity CLI（`agy`，v1.2.0）无需单独的 API key,就能提供一条已登录的路径去访问 Gemini、Claude 与 GPT-OSS 模型,但它并不是一个 LLM API:它是一个带有约 60 个内置工具(`run_command`、`view_file`、`write_to_file` 等)、拥有自己的权限系统、并会在读取本适配器的 stdin 之前就在内部组装好自己系统提示词的完整编程 agent。要把它驱动为 harness 的 chat 后端,就意味着完全阻止它按这份自主性行事——绝不运行自己的工具,绝不信任它自己的读写权限模型——同时仍然要用每个其他适配器所实现的同一套 `StreamChunk` 协议,流式地给出 harness agent loop 所需要的文本(或者,对于工具调用请求,JSON)。

有两个事实让这比一个普通适配器更难做:agy 没有暴露任何本适配器可以驱动的 `--tools` 参数;而 `--json-schema` 经实测并不可靠(模型忽略了它,并额外运行了一轮去调用 agy 自己的工具,而不是作答)。因此 harness 的工具调用必须完全在提示词中实现,而 agy 自身的工具使用也必须由比"好言相劝"更强的手段来约束。

## Decision

`packages/llm/llm-antigravity`(`@deepseek-ai/dsh-llm-antigravity`)是一个新的提供方包,拥有单一路由 `antigravity`,仅以可选挂载的方式提供——没有任何已发布 bundle 引用它,因为 `agy` 是本地安装、单独授权且单独登录的 CLI,harness 无法假定它一定存在。

### agy 是一个 agent,而不是补全 API

本适配器发出的每个提示词都以一段固定前言(`src/prompt.ts` 中的 `COMPLETION_BACKEND_PREAMBLE`)开头,告诉模型它正在为另一个 agent 运行时充当文本补全后端,绝不能调用自己的内置工具。这段前言是必要的,但并不充分:模型完全可以无视指令。真正的强制手段是结构性的——每次 `stream()` 调用,以及每次 `agy models` 发现调用,都会在一个新建的 `mkdtemp(join(tmpdir(), 'dsh-agy-'))` 目录中运行 agy,并无论结果如何都在 `finally` 中将其删除。agy 自身的设置(`~/.gemini/antigravity-cli/settings.json`)把 harness 代码检出目录与用户主目录列为受信任工作区;转而在一个不受信任的 cwd 中运行,则意味着 agy 的 headless print 模式会自动拒绝它在其中尝试的每一次内置工具操作,而一个响应为空且 `denied_actions` 非空列表的 `SUCCESS` 结果会被作为 `LlmError('AGENT_TOOLS_DENIED')` 呈现出来,而不是一个静默的空回答。这次不受信任 cwd 的替换,是应对忽略前言的模型的兜底强制措施;而前言本身的作用,则是让一个遵从指令的模型一开始就不去尝试,从而不必付出额外一轮的延迟代价。

### 提示词层面的工具调用,而非 `--json-schema`

针对真实请求探测 `--json-schema` 显示,模型会忽略该 schema 并额外运行一轮去尝试 agy 自己的工具——这对 harness loop 所依赖的路径来说既不可靠也不安全。取而代之的是:当 `GenerateOptions.tools` 非空时,会被渲染为一个 `[Available Tools]` JSON 块,后跟一段固定的协议指令(`TOOL_CALL_PROTOCOL`),要求返回一个可选择加围栏的 `{"tool_calls":[...]}` JSON 对象。由于这只是建议性的提示词文本,而非提供方约定,`stream()` 在工具模式下会缓冲整个响应(没有实时的 `text-delta` 分片),并在事后宽松地解析终止的 `result.response`(`src/tool-protocol.ts`):一个 ` ```json ` 围栏或去除首尾空白后的原始文本,经 `JSON.parse` 解析,校验其 `tool_calls` 数组非空且每个条目都带有非空字符串 `name` 与对象类型的 `arguments`。匹配成功时,围栏周围的任何文本都会成为一个前置文本块,随后是每个调用对应的一个 `tool-call` 块(`CallId(crypto.randomUUID())`,`arguments` 重新序列化为 JSON),以及 `finish {kind: 'tool-calls'}`。任何解析失败——无效 JSON、缺失或格式错误的 `tool_calls` 数组、格式错误的调用——都会退化为把整个响应当作普通文本,并附带 `finish {kind: 'stop'}`,与未提供任何工具时完全一致:一个忽略该协议的模型永远不会导致请求失败,它只会以散文形式作答。

### 动态的 `agy models` 发现

`Config.models` 默认为空。空目录意味着 `listModels` 会启动 `agy models`(采用与上文相同的不受信任 cwd 模式)并解析其 `<id>\t<display name>` 行,跳过任何不含制表符的行作为横幅或日志噪音。一次成功的发现会在该适配器实例的生命周期内被缓存(一个进行中的 promise 会被缓存并复用,因此并发调用方会去重);一次失败的发现不会被缓存,而是以 `LlmError('DISCOVERY_FAILED')` 拒绝,因此下一次调用会重试。一个非空的已配置目录会原样提供,从不触发发现进程。`resolveModel` 优先使用已配置条目自身的容量;当目录为空时回退到已发现条目的显示名称;其余所有情况都回退到 `Config.defaultContextWindow`/`defaultMaxTokens`——与 `llm-ollama` 为未列入目录的直通 id 所使用的负能力形态相同。

### 其余部分遵循既有适配器惯例

`Config`(schemastery,`src/index.ts`)把每个字段都声明为必填且带默认值——`binaryPath`、`printTimeoutSeconds`、`models`、`defaultContextWindow`、`defaultMaxTokens`——而 `resolveAdapterOptions` 是唯一的显式 resolve 步骤,重新校验一个普通对象字面量仍可能违反的边界(程序化构造会绕过 Schemastery),符合仓库"显式优于隐式"的规则;`apply()` 上刻意没有 `config = {}` 默认值,因为 `ctx.plugin()` 总会先解析 Config schema(包括其默认值)再调用它。`GenerateOptions.stop` 会抛出 `UNSUPPORTED_OPTION`(agy 未暴露停止序列参数);`temperature`/`maxTokens` 则被静默忽略,因为 loop 总会把 `resolveModel` 的 `defaultMaxTokens` 具体化到每个请求的 `maxTokens` 上——在那里抛出会让普通的 agent loop 调用失败,而不仅仅是显式请求。历史中任意位置出现的图像(或其他非文本)内容块都会在任何子进程启动之前抛出 `UNSUPPORTED_CONTENT`;reasoning 块被渲染为 `[reasoning] <text>` 而不是被丢弃,这与 `llm-ollama` 的 Ollama 路由不同(那里没有可回传它们的字段)——本路由没有这种约束,因此保留它们只是多花 token,而不是一个协议格式上的决定。

### 子进程传输(`src/agy-process.ts`)

保留为独立模块(无需真实 `agy` 可执行文件即可测试),围绕一个不变式构建:`spawnAgy()` 返回的事件流永远不会 reject——每一种失败(启动失败、非零退出、因信号死亡)都以一个带类型的 `AgyProcessEvent` 形式到达,而不是抛出或 reject 一个传输错误。这就是为什么 `adapter.ts` 中消费事件的循环没有通用的 catch-and-rewrap:其中两处抛出点本身已经是格式良好的 `LlmError`,为一段不可能抛出别的任何东西的代码添加防御性 catch,只会产生无法被测试覆盖到的死代码,而不是额外的安全性。监听器在 `spawn()` 之后立即同步挂上(同一 tick 内的 ENOENT 绝不会被漏掉),stdin 写入错误由其自身的空操作处理器吞掉(向一个启动失败的进程写入会触发 EPIPE,而上面的 `error` 处理器已经报告了那唯一真正的失败),stderr 则保留为一个按字节数(4 KiB)上限的尾部,用于错误信息。

## Alternatives considered

- **用 `--json-schema` 实现工具调用** —— 基于实测证据被否决:模型忽略了该 schema,并额外运行一轮去尝试 agy 自己的工具,而不是以结构化方式作答。一个由 harness 宽松解析、并在任何失败时都退回纯文本的提示词层面协议严格来说更安全:最坏情况只是一次普通的文本回答,而不是浪费一轮或误触发一次工具尝试。
- **信任 agy 自身的权限提示 / `permission_mode`,而不是不受信任的 cwd** —— 被否决:headless print 模式没有可以应答的交互式提示,而 `permission_mode` 只是 `init` 事件上的一个展示字段,不是本适配器可以设置的杠杆。不受信任 cwd 加自动拒绝的组合,是目前观察到的唯一能在没有交互式会话的情况下可靠阻止 agy 自身工具的机制。
- **内置一份已知 agy 模型的默认目录** —— 作为一个没有当前部署依据的硬编码可调项被否决:一个 agy 安装能触达哪些模型属于本包无法知晓的账号/订阅状态,这正是 `llm-ollama`"`models` 默认为空"先例所针对的、一个包无法观测的部署状态。`agy models` 发现在不维护一份易过期的静态列表的前提下,回答了同样的需求。
- **在某个已发布 bundle 中挂载本适配器** —— 被否决:`agy` 是一个单独安装、单独认证的 CLI,不像带 API key 的 HTTP 提供方那样是 harness 可以假定其存在的东西。本包保持可选挂载、仅通过附加配置启用,符合任务的明确指示。

## Consequences

- 提供工具时不存在实时文本流式输出(先缓冲后解析正是提示词层面工具调用得以实现的前提);需要在支持工具的回合中获得实时 token 的调用方无法从该路由得到它们。
- 提示词层面的工具协议不可强制执行:一个恰好输出了格式良好的 `{"tool_calls":[...]}` JSON、但实际上并非真正工具调用的模型会被误判为工具调用,且无法从模型自身遵从程度之外区分这两种情况。
- 每个请求都要额外承担约 14k 输入 token 的 agy 自身系统提示词开销,本适配器无法降低、关闭或观测它——agy 会在读取本适配器的 stdin 之前就完成组装。
- 不存在任何形式的跨调用 KV Cache 复用:每次 `stream()` 调用都是一个全新的 agy 进程与对话,因此本适配器没有可报告的会话或提示词前缀复用。
- 不受信任 cwd 加 headless 自动拒绝这道防线依赖 agy 的具体版本,而不是本包自身拥有的硬性沙箱保证;未来某个改变其中任一行为的 agy 版本,需要针对新的可执行文件重新验证本包,而不只是更新文档。
- `agy models` 发现结果会在适配器实例的生命周期内为成功结果做缓存,因此在首次发现成功之后新加入账号的模型,在 harness 进程重启(得到一个全新的适配器实例)之前都不可见。

## Testing

- `packages/llm/llm-antigravity/tests/prompt.spec.ts`——固定前言与工具协议文本保持前缀/子串稳定,system 文本的纳入,按消息来源 `kind` 渲染消息记录(包括可合并扩展的默认兜底分支),工具调用/工具结果块的渲染,以及历史中任意位置(包括嵌套在工具结果中)出现图像时的 `UNSUPPORTED_CONTENT`。
- `packages/llm/llm-antigravity/tests/tool-protocol.spec.ts`——带围栏/不带围栏/围栏周围有文本的解析,每一种格式错误形态的拒绝(非数组、空数组、缺失/空的 name、缺失/非对象/数组类型的 arguments、非对象的顶层 JSON),以及围栏缺少结尾换行符的边界情况。
- `packages/llm/llm-antigravity/tests/agy-process.spec.ts`——直接测试 `boundedAppend` 精确/超限/多字节截断处的字节边界,随后端到端针对一个生成出来的(不依赖 git 可执行位的)伪 `agy` 可执行文件测试 `spawnAgy()`:有序的行/退出事件、同一 tick 内 ENOENT 的 `spawn-error` 事件先于任何退出事件、`kill()` 的幂等性及其对一个挂起进程的效果、一个失败进程的有界 stderr 尾部、消费方提前 `break` 时的干净关闭,以及一次与不读取它就退出的子进程竞速的大量 stdin 写入(EPIPE)。
- `packages/llm/llm-antigravity/tests/adapter.spec.ts`——端到端针对伪二进制文件覆盖 README 记录的每一种场景:实时与缓冲文本、全部四种工具调用解析结果(带围栏、带围栏且有文本、不带围栏的多调用、无效/非 JSON 回退)、`result.status: 'ERROR'`(带与不带错误信息)、`denied_actions`、`EMPTY_RESPONSE`(带与不带 usage)、非零退出与因信号死亡(均与调用方中止相区别)、缺失的 `result` 事件、格式错误的 NDJSON 行、`stop`/预先中止信号的拒绝、ENOENT 与非 ENOENT(EACCES)的启动失败、不受信任临时 cwd 的创建/区分度/删除、流中途中止与消费方提前返回时的清理(子进程写入的一个标记文件证明其 cwd 之后已被删除)、`agy models` 发现的缓存/失败重试/已配置目录绕过,以及跨全部目录形态的 `resolveModel` 容量解析。对 `src` 达到按文件 100% 覆盖。
- `packages/llm/llm-antigravity/tests/index.spec.ts`——`Config` schema 的默认值与拒绝情形,`resolveAdapterOptions` 的边界校验(包括目录去重/分离),以及 HMR 安全的提供方注册/释放。
- `packages/llm/llm-antigravity/tests/loader-composition.spec.ts`——`packages/CLAUDE.md` 对面向产品的插件所要求的真实组合防护:`LlmRuntime` 与 `llm-antigravity` 从一个仅用于测试的 `cordis.yml` 经由真实 Loader 启动,一个请求触达伪 `agy` 可执行文件并被正确组装返回。
- 一次真实 API 冒烟检查(未提交为测试;会消耗操作者自己的 agy 订阅配额)针对 `gemini-3.8-flash-low` 验证了已构建的适配器:一个纯文本请求与一个提供工具的请求都正确完成了往返,后者产出了一个 `tool-calls` 结束原因。
