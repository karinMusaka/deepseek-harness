# @deepseek-ai/dsh-tool-classify-image

[English](README.md) | 中文

面向模型的 `classify_image` 工具：读取一个本地图片文件，转接到 `ctx.llm` 上的辅助视觉路由，只返回文本标签。它针对人物图片回答两个问题——是照片还是插画、以及表观性别——除此之外不做别的。

这个工具之所以存在，是因为图片不能直接给当前对话自己的模型看。会话历史中一旦留下持久的 `image` 内容块，之后每一次走纯文本路由的请求都会永久性地以 `UNSUPPORTED_CONTENT` 失败（见 [`dsh-llm-deepseek`](../llm-deepseek/README.md) 中的 `assertTextOnly`），于是看过一次图片的会话就此报废。因此本工具在一次工具调用内部把图片消息构造为局部变量，发送到独立的视觉路由，然后返回文本。发起调用的会话里从不保存图片内容。

## 插件

```yml
- name: '@deepseek-ai/dsh-tool-classify-image'
  config:
    provider: ollama
    model: minicpm-v:latest
    maxTokens: 128
    timeoutMs: 120000
```

`inject`：`tools`、`llm`、`fs`、`attachments`。四者缺一不可——工具通过文件系统 seam 解析路径，通过附件存储提交字节，并通过 LLM（大语言模型）seam 发起辅助请求的流式调用。

| 键 | 默认值 | 含义 |
|---|---|---|
| `provider` | `ollama` | 承载视觉模型的已注册提供方路由。 |
| `model` | `minicpm-v:latest` | 传给该提供方的精确模型 id。 |
| `maxTokens` | `128` | 两次辅助请求各自的输出 token 上限。 |
| `timeoutMs` | `120000` | 协作式工具调用预算，由 [`dsh-tool-call-timeout-policy`](../../guard/timeout-policy/README.md) 执行。 |

`provider` 与 `model` 必须成对提供：只给 provider 会让它继承一个在该路由上毫无意义的模型 id，只给 model 则会跑在 `ollama` 恰好指向的任意路由上。只提供其中之一会在加载时失败。

该路由必须声明支持图片输入。对 Ollama 提供方而言，这意味着要为模型写一条 catalog 条目，因为 `dsh-llm-ollama` 把 `inputModalities` 当作声明项而非探测项：

```yml
- name: '@deepseek-ai/dsh-llm-ollama'
  config:
    models:
      - id: minicpm-v:latest
        inputModalities: [text, image]
```

## 执行流程

一次调用按顺序执行：扩展名到媒体类型的映射、部署可接受媒体类型的检查、路由图片输入能力的检查、经 `ctx.fs` 的路径解析与 `stat`、有上限的 `readBytes`、`ctx.attachments.saveImage`、`fs/observed` 事件发送、`tool-classify-image/request` 会话追加，最后才是两次辅助请求。凡是无需 I/O 即可判定的拒绝都在读取之前完成，因此被拒绝的调用不会留下任何附件。

两个问题是包自己拥有的固定文案，而非配置项，因为 `src/normalize.ts` 匹配的正是这两个问句所诱导出的关键词。其性别规则先测试女性关键词：`female` 中含有 `male`、`woman` 中含有 `man`，若先扫描男性关键词，会把每一个女性回答都误判为男性。

规范值为 `{ type, gender, typeRaw, genderRaw }`。`type` 取 `photo`、`illustration` 或 `unknown`；`gender` 取 `male`、`female` 或 `unknown`。两句原始回答一并返回，调用方可以自行判断 `unknown` 的成因。UI 渲染意图是 `read` 家族的 `generic` 卡片，并带一条指向图片路径的 `locations`。

## 会话事件

`tool-classify-image/request` 是在两次辅助分派之前追加的 log-only 记录，携带解析后的路径、持久附件 id 与媒体类型、路由、两个提示词以及输出上限。它是会话日志中关于这两次模型请求的唯一痕迹——因为它们的图片和提示词从不成为对话消息。没有 agent 的直接调用没有会话，也就不记录任何内容。

## Model Experience

### `classify_image` 工具 schema

#### 模型看到什么

[工具目录](../../../docs/tool-catalog.md#deepseek-aidsh-tool-classify-image)中的工具 schema：一个必填的 `path` 字符串。除该条目外没有任何差异。

#### Token 影响

固定：插件挂载期间，每次请求的工具列表中多一条 schema 条目。

#### KV Cache 影响

前缀稳定。对已挂载的插件而言 schema 恒定，因此在请求之间既不增长也不变化；挂载或卸载插件会改变工具列表，并从该点起使复用失效。

### `classify_image` 工具结果

#### 模型看到什么

两行标签，后跟视觉模型的两句原始回答。

##### 结果文本原文，模型自己的措辞以占位符表示

```markdown
type: <photo|illustration|unknown>
gender: <male|female|unknown>

vision model answers:
- <the model's photograph-or-illustration sentence>
- <the model's apparent-gender sentence>
```

#### Token 影响

小且有界：两个标签加两句各受 `maxTokens`（默认 128）限制的回答。图片本身不贡献任何 token——它在本会话中从不成为模型可见内容。

#### KV Cache 影响

仅追加。结果是调用之后追加的一个普通工具结果块，因此保留已可复用的前缀。

### 辅助视觉请求

#### 模型看到什么

看到内容的是*辅助*视觉模型而非发起调用的模型：一条 user 消息，包含图片和一个固定问句，没有系统提示词，也没有工具 schema。每次调用发起两个这样的请求，每个问句一个。发起调用的模型什么都看不到。

#### Token 影响

与发起会话的预算相互独立：每个辅助请求在视觉路由上的开销是图片自身的 token 展开加一个短问句，输出上限为 `maxTokens`。

#### KV Cache 影响

相互独立。每个辅助请求都是全新的单消息对话，没有共享前缀，因此既不复用也不使发起会话的缓存失效；两个问句之间在提供方侧能否复用，属于视觉路由自己的事。

## Known Limitations and Deferred Work

- **图片必须是本地文件路径** —— 唯一的参数是 `path`，由已挂载的文件系统后端解析。URL、base64 载荷以及已有附件 id 都不接受；手上只有字节的调用方必须先把它们写成后端能访问到的文件。
- **两个固定问句，不支持覆写提示词** —— 问句是包自己拥有的文案，与 `src/normalize.ts` 中的关键词集合配对，因此配置无法在不悄悄降低标签质量的前提下替换它们。不同的分类需求应当是另一个工具，而不是本工具上的一个配置键。
- **归一化是子串匹配，而非理解** —— 同时提到照片和插画的回答会报 `type: unknown` 而不是猜测；措辞中不含任何已列关键词的回答即使人类读来一目了然也会报 `unknown`。`typeRaw`／`genderRaw` 的存在正是为了让调用方能从中恢复。
- **只识别二元表述的性别词汇** —— 关键词集合是 `female`／`woman`／`girl` 与 `male`／`man`／`boy`；其他回答一律报 `unknown`。本工具报告的是视觉模型对图片的表层读取，而非关于被拍摄者的断言。
- **路由的图片支持靠声明而非探测** —— 门禁读取 `ctx.llm.resolveModelInfo` 给出的 `inputModalities`，因此提供方 catalog 中遗漏声明的视觉模型会被拒绝。这沿用了 Ollama 适配器的"能力靠声明"立场，失败方向是安全的。
- **仅支持英文问句** —— 固定提示词和关键词集合都是英文。用其他语言作答的视觉模型会让两个字段都变成 `unknown`。
- **没有批量形式** —— 一次调用分类一个文件。分类一个目录需要每张图片一次工具调用和两次视觉请求。
