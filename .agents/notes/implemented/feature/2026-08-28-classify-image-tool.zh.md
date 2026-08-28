# Agent Note：一个转接图片却不让调用方看到它的 classify_image 工具

Status: implemented

[English](2026-08-28-classify-image-tool.md) | 中文

## Problem

对人物图片做分类——照片还是插画、表观性别——在本地视觉模型上很便宜，而 [`dsh-llm-ollama`](2026-08-27-ollama-llm-provider.md) 已经能连上一个。缺的是一种方式：在普通会话里请求这种分类，而不必手工把整个会话的模型切过去。

把图片交给会话自己的模型不只是没用，而是破坏性的。`packages/llm/llm-deepseek/src/serialize.ts` 中的 `assertTextOnly` 会拒绝任何历史里含有图片内容块的请求，而会话历史是仅追加的：图片块一旦被记录，此后每一个包含该消息的请求都会以 `UNSUPPORTED_CONTENT` 永久失败。`packages/fs/tool-fs/src/read-image.ts` 的注释从另一面陈述了同一事实，这也是 `read_image` 必须在被路由到的模型明确声明支持图片输入时才放行的原因。所以需求不是"让主模型看到图片"，而恰恰相反——在保证主模型绝不会看到图片的前提下完成分类。

## Decision

`packages/llm/tool-classify-image`（`@deepseek-ai/dsh-tool-classify-image`）注册了一个作用面很窄的工具 `classify_image`，只接受一个 `path`。在 `execute` 内部，它经 `ctx.fs` 解析并读取文件，经 `ctx.attachments.saveImage` 提交字节，然后构造一个**局部的** `Message[]`，其中含一个图片块和一个问句。这个数组是函数作用域内的变量：传给 `ctx.llm.stream` 之后即被丢弃。没有任何代码把它追加进发起调用的会话，因此调用方的历史保持纯文本，之后基于它的每一个请求都依然有效。返回给发起调用模型的是 `{ type, gender, typeRaw, genderRaw }`——封闭标签外加两句原始回答。

在配置好的路由上顺序提出两个固定问题：图片是照片还是数字插画，以及画面中人物或角色的表观性别。它们是包自己的文案而非配置项，因为 `src/normalize.ts` 匹配的正是这两个问句所诱导出的关键词。其性别规则先测试 `female`／`woman`／`girl`，再测试 `male`／`man`／`boy`，因为 `female` 中含有 `male`、`woman` 中含有 `man`；若先扫描男性关键词，会把每一个女性回答都误判为男性。同时提到两类的类型回答会报 `unknown` 而不是猜测。

路由在任何 I/O 之前就被校验。`ctx.llm.resolveModelInfo(provider, model)` 必须声明 `image` 输入，与 `read_image` 的严格门禁一致；对 Ollama 提供方而言，这意味着部署的 catalog 条目里写着 `inputModalities: [text, image]`，因为该适配器对图片支持采取声明而非探测的立场。配置中 `provider` 与 `model` 必须成对提供（成对默认为 `ollama` / `minicpm-v:latest`），因为只给 provider 会让它继承一个在该路由上毫无意义的模型 id，只给 model 则会跑在 `ollama` 恰好指向的任意路由上。

这两次辅助请求原本不会留下任何痕迹，因为它们的图片和提示词从不成为对话消息。于是本工具沿用 `session-title-llm` 的"分派前 log-only 记录"模式：在两次分派之前追加 `tool-classify-image/request`，携带解析后的路径、持久附件 id 与媒体类型、路由、两个提示词以及输出上限。没有 agent 的直接调用没有会话，也就不记录任何内容——这是自洽的，因为并不存在需要重建的历史。

`GenerateOptions.purpose` 新增了取值 `'vision-classify'`。该字段在 `packages/llm/llm/src/types.ts` 中是一个普通的封闭字面量联合类型，而非可合并扩展的映射，因此就地拓宽了这个联合；两处既有读取方（`llm-deepseek` 的压缩请求头与其会话标题 thinking 覆写）都只检测自己的取值，会原样放过新值。

作用范围刻意收窄。`packages/bundle/base` 未被改动：只有当某个部署自己的 `cordis.yml` 注册它时才会启用。

## Alternatives considered

**一个通用的"向其他提供方提问"转接工具。** 已否决：当前唯一的消费者就是这一种分类需求，而通用转接工具必须承担提示词透传、按调用选择路由和结果整形，但对这三者应当长什么样都没有证据。仓库规则要求每个公开选项都要有当前的归属者与需求。

**扩展 `read_image`。** 作为契约倒置而被否决。`read_image` 的存在意义是把图片放*进*对话，好让主模型去看，因此它把图片块提交进工具结果，并在无法承载图片的路由上拒绝执行。本工具的要求是主模型绝不看到图片，而且它恰恰工作在 `read_image` 会拒绝的路由上。两个保证相反的工具不应共用一个实现。

**可配置的提示词（`promptOverride`）。** 已否决：问句与 `normalize.ts` 中的关键词集合是同一个设计。被替换掉的问句仍会持续产出标签，只是悄悄变错——这比不提供这个旋钮更糟。

**把会话事件标记为 `ignorable`。** 之所以考虑，是因为这个包是可选启用的，而挂载它时写下的日志可能被没挂载它的组合读取。作为不必要而否决：`KNOWN_SESSION_EVENT_TYPES` 由 `gen-persistence-catalog` 从仓库内每一处 `SessionEventMap` 合并生成，因此仓库内的事件类型对每个第一方构建都是已知的，与挂载了哪些插件无关。而且 `Session.append` 目前也没有暴露 `ignorable` 参数（[会话日志版本机制](../architecture/2026-08-10-session-log-version-mechanism.md)把这个接口推迟到它的第一个真实使用者出现时再加）。

## Consequences

本工具只回答恰好两个问题，也无法被指向第三个。新的分类需求应当是新工具，而不是这里的一个配置键；若这类需求积累起来，值得抽取的共用机制是"读取—提交—转接"这条路径，而不是问句本身。

归一化是对英文回答做子串匹配。视觉模型若用不含已列关键词的措辞作答，或用别的语言作答，即使人类读来一目了然也会得到 `unknown`。返回 `typeRaw` 与 `genderRaw` 正是为了让调用方能从中恢复，也让关键词集合的缺口在对话记录里可见而非无声。

路由门禁依赖部署方自己写下的声明。提供方 catalog 中遗漏 `inputModalities` 的视觉模型会被拒绝，拒绝信息会指出修复方式。这个失败方向是安全的，并沿用了 Ollama 适配器的立场，但也确实意味着在该适配器的默认空 catalog 下，本工具会拒绝每一次调用。

`purpose` 现在是一个三值联合类型，未来任何在其上分支的适配器都必须处理；当前两处读取方已经会原样放过。拓宽它同时也意味着辅助视觉请求在适配器边界上可以与普通请求区分开——若提供方日后要施加按用途区分的生成策略，正需要这一点。

## Verification

`packages/llm/tool-classify-image/tests/` 覆盖了关键词集合（含 `female`／`male` 与 `woman`／`man` 的顺序陷阱）、在真实本地文件系统与真实附件校验辅助函数之上、仅脚本化模型路由的每一条拒绝分支与每一种终止原因，以及一个真实 Loader 组合测试：它把本工具与 `llm-ollama` 一起在 mock NDJSON 端点上启动，断言线上的 base64 图片字节、返回的标签、发起调用的会话日志中只有那条 log-only 记录，以及只声明 `[text]` 的 catalog 条目会在任何请求之前拒绝执行。
