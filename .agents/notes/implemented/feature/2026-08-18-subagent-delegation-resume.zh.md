# Agent Note: 为委派的 `codex`／`claude-code` 运行提供可选的、提供方原生的续接（resume/continuation）

Status: implemented

[English](2026-08-18-subagent-delegation-resume.md) | 中文

## 问题

一次性的 `codex`／`claude-code` 委派每次都从头开始：每次调用都要重新为子 agent 的系统指令与工具 schema 付费，而想要续接某次特定的既有委派（而非再开一次全新委派）的模型完全没有办法做到——它唯一的选择就是再发起一次不带上下文的新运行。两款原生产品其实都已经原生支持这一点(Codex 的持久化 `thread/resume`、Claude Agent SDK 的 `Options.resume`)，但 PR1–PR4(权限范围、超时、失败分类、变更文件／用量)刻意把续接排除在范围之外。

有四项要求塑造了这次设计，其中三项与安全相关：

1. **纯粹可选(opt-in)。** 两个提供方的默认行为都不能改变：除非某次调用显式要求持久化，否则 Codex 仍保持 `ephemeral: true`,Claude 仍保持 `persistSession: false`。从未开启该选项的组合必须看到与 PR5 之前完全字节相同的工具 schema、结果 schema 以及记录下来的 `tool/result` 形状。
2. **模型提供的 resume id 是不可信输入,必须与范围绑定。** 子进程继承了 harness 自身的 `HOME`,因此与用户自己私有的 `~/.codex`／`~/.claude` 会话存储共享同一份数据。若不加检查,一个模型只要从某次范围不同的委派(不同的工具行、不同的 `permissionMode`、不同的 cwd)得知或猜出某个 id,就可能续接进一个比它本应获得的范围更宽、或与它毫不相关的会话。
3. **授权必须源自日志,绝不能是进程内缓存。** harness 的 Session 可以在进程重启后存活;若用一个进程内的 Map 记录「这个进程曾签发过哪些 id」,一旦重启就会悄悄地不再为合法的续接授权,却完全没有带来真正的安全性(攻击者只需等下一次重启即可绕过),因此权威检查必须读取 Session 自身的持久事件日志。
4. **底层协议细节因提供方而异,极易搞反。** Codex app-server 的 JSON-RPC 字段是驼峰式 `threadId`,而不是 Rust 源码里的 `thread_id`;ephemeral／persistent 断言在可选路径上必须正确反转;而实际的按次用量核算问题(续接是否会重放整条线程的累计总量?)在任何地方都没有文档记载,必须靠实测来确定。

## 决策

### 两层门控,而非一层

与 `permissionMode`(仅限部署侧配置,因为放宽子 agent 的操作系统级权限范围绝不该由发起委派的模型来决定——见[审批钉定 Note](2026-08-10-subagent-approval-pinned-never.md))不同,resume 是两层门控:`dsh-tool-subagent` 的部署级 `allowResume: boolean` 配置(默认 `false`)决定 `resume`／`resume_id` 这两个工具参数是否*根本存在*于模型可见的 schema 中;而在该门控范围内,模型自己每次调用给出的 `resume: true` 或 `resume_id: "<id>"` 是一个正当的请求,而非放宽范围的请求——续接某次特定的既有运行,正是发起调用的模型本就有资格做出的那类决定,不同于让它给自己授予更宽的权限范围。`allowResume: true` 要求所配置的提供方具备新增的 `resume` 能力,若不具备则挂载失败;它在加载期拒绝与 `backgroundMode: 'continuable'` 组合——这两种机制解决的是不同的问题(持久化、由 harness 拥有的多轮子 agent,对比在 harness 自身回合模型之外续接的提供方原生线程),否则二者会争夺同一个工具行的续接语义。

`SubagentCapabilities` 新增 `resume: boolean`。`spawn`／`fork`／`acp`／`dsh-sdk` 均声明为 `false`——进程内提供方本就共享父级自身的 Cordis 权限,没有独立的原生线程需要持久化。`codex` 与 `claude-code` 声明为 `true`。`SubagentStartRequest` 新增 `requestResume?: boolean`(请求让本次运行的线程／会话保持存活)与 `resumeId?: string`(续接某个特定的既有运行);`SubagentResult` 新增 `resumeId?: string`——永远是提供方自己上报的身份标识(Codex 的 `thread.id`、Claude 的 `session_id`),绝不是请求中 `resumeId` 的回显。

### resume 授权源自日志、与范围绑定,归属共享 seam

新增 `packages/subagent/subagent/src/resume-issuance.ts`。`SubagentResumeIssuance` 为 `{ id, provider, permissionMode, cwd }`——即该 id 加上它被签发时的*确切*范围。`SUBAGENT_RESUME_META_KEY = 'subagentResume'` 是消费方用来记录该记录的 `tool/result.meta` 对象键(之所以导出,是为了让 `dsh-tool-subagent`——唯一内置的写入方——与本验证器在不互相依赖对方包的前提下就线上形状达成一致)。`verifyResumeIssuance(session, candidate)` 扫描 `session.events`,查找某个 `tool/result` 事件,其 `meta[SUBAGENT_RESUME_META_KEY]` 在全部*四个*字段上都与 `candidate` 匹配,而不仅仅是 `id`。

`SubagentRuntime.start()` 只要 `request.resumeId !== undefined` 就会调用 `assertResumeAuthorized()`,该调用发生在 `assertCapabilities()` 之后(能力不受支持的拒绝要与范围拒绝区分开)、在任何提供方看到该 id 之前。它用 `request.parent.session.header.cwd` 构建候选值(当父级 header 未携带 cwd 时立即拒绝,完全不做任何会话扫描),并使用请求的*有效* `permissionMode`(`request.permissionMode ?? 'read-only'`——提供方自身文档化的默认值),而非部署配置的原始值。按有效值比对有效值,而非按原始配置比对原始配置,这正是为何能正确地把针对同一提供方的两个工具行——一个省略 `permissionMode`(默认为 `'read-only'`),另一个显式写出 `permissionMode: 'read-only'`——视为*同一*范围,同时仍能拒绝一个真正不同的范围。一次被拒绝的续接——无论是这个 id 从未被签发过,还是在不同的提供方／范围／cwd 下被签发的——总是抛出*同一个* `SubagentError`(`RESUME_REJECTED`,「subagent resume id was not issued in this scope by this harness session」):一个能够区分「id 错了」与「范围错了」的模型将白白获得一个探测预言机。

### Codex:`thread/resume`、驼峰命名、重新钉定沙箱、反转断言

`CodexAppServerWire.startThread()` 新增一个 `persistent` 参数(默认 `false`):它发送 `ephemeral: !persistent`,并根据*所请求*的值校验返回的 `thread.ephemeral`——这与 PR5 之前的断言方向相反,此前的断言只会检查是否为 `ephemeral: true`。新增的 `resumeThread(threadId, permissionMode, signal)` 发送 `thread/resume { threadId, sandbox, approvalPolicy: 'never' }`——**实测:该字段是驼峰式 `threadId`;Rust 源码中蛇形命名的 `thread_id` 会被 app-server 自身的字段名校验以 `-32600 "missing field threadId"` 拒绝。** `sandbox`／`approvalPolicy` 在每次续接时都会被重新钉定,与 `thread/start` 在创建时钉定它们的方式完全一致,因此续接后子 agent 的权限范围永远是*本次调用*的 `permissionMode`,而不是该线程此前恰好运行在的任何范围(上面所述的 harness 层范围检查是主要防线;这是在线路层本身的纵深防御)。`thread/resume` 的 JSON-RPC 错误(id 未被识别或已被占用)会被捕获并重新分类为 `ClassifiedSubagentFailure { code: 'provider', ... }`——与发布后原生失败得到的分类*相同*——因为这个拒绝发生在任何线程被(重新)发布之前,这是 PR1–PR4 从未需要过的代码路径。非 `JsonRpcResponseError` 的已分类失败(格式错误的 `thread/resume` 响应形状)会被原样重新抛出。若续接返回的线程 id 与所请求的不一致,会作为一项防御性完整性检查而被拒绝。

### Claude:`Options.resume`、`persistSession`、不使用 fork、既有分类已经覆盖失败路径

`claudeQueryOptions()` 计算 `persistent = spec.requestResume || spec.resumeId !== undefined`,并据此设置 `persistSession: persistent`(默认仍为 `false`),在设置了 `resumeId` 时再加上 `resume: spec.resumeId`。`forkSession` 被刻意弃之不用:这一机制要跨调用续接*同一个* `session_id`,而不是从既有历史分叉出一个新会话——那是另一个(此处并不需要的)SDK 特性。`consumeClaudeQuery()` 仅在 `persistent` 且本次运行成功时,才把 `message.session_id` 捕获为上报的 `resumeId`。`settingSources: []` 与固定的 `canUseTool` 权限范围在续接调用上的强制程度与全新调用完全相同——续接不授予任何额外的信任。

**实测:从不匹配的 cwd 续接,或续接一个无法识别的会话 id,都不是抛出异常——而是一条正常的 `is_error: true` 结果消息,携带可操作的 `errors` 数组**(例如对一个伪造 id 会得到 `"No conversation found with session ID: 00000000-0000-0000-0000-000000000000"`;对 cwd 不匹配则是同一条消息,只是写明所请求的 id——SDK 的磁盘会话存储是以 cwd 为键的)。这正是为何 Claude 侧完全不需要新增分类代码的原因:这类失败已经流经失败分类 PR(PR3)搭建的*既有* `is_error`／`api_error_status` 分类路径,落地为 `SubagentFailureDetail { code: 'provider', ... }`,不需要专门的续接失败分支。

### 用量问题:`total` 是线程生命周期内的累计值,`last` 才是按次调用值——只对 `last` 求和,绝不读取 `total`

规格把这一点标记为一个待解决的问题:Codex 的 `thread/tokenUsage/updated` 通知在一个回合内会触发多次;PR4 已经确定,该通知的 `total` 字段在一个普通(未续接)回合内是一个持续增长的总量,因此当时正确的做法是只保留*最后一次*观测到的 `total`。resume 提出了一个 PR4 从未需要回答的新问题:这个 `total` 是会在 `thread/resume` 之*后*继续累加,还是 app-server 会为「新的」(被续接的)线程实例把它重置?

针对真实的 `codex app-server` 二进制文件所做的两个独立探测脚本,以实测的方式解决了这个问题。**`total` 不会在 `thread/resume` 之后重置。** 一个线程在此前的一次两次响应的回合中累计了 `total: { inputTokens: 30, outputTokens: 11 }`,一旦被续接,会立即收到一条 `thread/tokenUsage/updated` 重放通知,其中仍携带那个原封不动的过时 `total`——发生在新回合自身的第一条通知之前——而新回合自己的后续通知,是从那个过时的基数上继续递增的,而不是从零开始。因此,若不加改动地沿用「保留最后一次观测到的 `total`」(PR4 的规则)去续接场景,就会把一次*续接*调用的用量报告为整个线程生命周期内的累计总量,把此前每一次调用的 token 都算进去——一旦 resume 存在,这一规则就悄无声息地错了,尽管它对 PR4 自身那种不可续接的临时线程是正确的。

该通知还带有第二个字段 `last`,PR4 从未需要读取它:即*单次*模型调用自身的用量,即便在同一个回合内也不是累计值。`observeTokenUsage()` 现在只在当前活跃回合*内*对每条通知的 `last` 字段求和,完全不再读取 `total`。这是唯一能在全新线程(在那里恰好会与 PR4 规则本已产生的值殊途同归)和续接线程(在那里则不会)上都正确报告*本次调用自身*用量的写法。改写后的单元测试直接证明了这一点对 `total` 的不依赖:它在测试夹具的通知中故意填入不匹配、被夸大的 `total` 值,并断言求和结果只与 `last` 字段吻合。一项真实产品的集成测试验证了完整的跨进程场景:启动一个持久化线程、完成一个回合、续接它、完成第二个回合,并断言*第二次*结果所报告的 `usage` 只等于第二个回合自身的 token 数。

Claude 的 `usage` 字段没有类似的陷阱:Claude Agent SDK 的终态 `result` 消息直接报告该次调用*自身*的用量(线路上根本没有线程生命周期累计这种概念),这一点由真实产品的续接测试在一次真正的跨进程续接之后断言了一个精确的用量值来确认。

### `presentationMeta` 仍然按 `allowResume` 门控,而非无条件存在

`dsh-tool-subagent` 的 `output.presentationMeta`——写入持久化 `tool/result.meta.subagentResume` 签发记录的机制——只有在配置了 `allowResume` 时才会出现在最终构建的 `ToolDefinition` 中,做法是使用条件*表达式*(`allowResume ? fn : undefined as never`),而不是对 `output` 对象字面量做条件*展开*。条件展开的写法最先被尝试,随后被否决:它会破坏 `defineTool` 的 `const O`／`execute()` 泛型推断(下游每一处 `execute` 的类型都会坍缩为 `never`)。接下来尝试了一个假分支就是裸 `undefined` 字面量的普通三元表达式,同样被否决,原因更窄:`exactOptionalPropertyTypes` 拒绝把 `undefined` 赋给一个可选的函数属性,即便是在三元表达式内部,恰好在该行产生一个干净、局部的类型错误——最终只在假分支上用一次 `undefined as never` 的类型断言来修复(`never` 可以赋给任何类型),完全不触碰真分支自身的上下文推断。这个净效果对「字节相同」这一保证很关键:`defineTool` 本身在传入值为 `undefined` 时,会把 `output.presentationMeta` 整个从最终构建的工具中省略掉(见其自身的条件展开),因此 `ctx.tools` 的 `createSuccessResult()` 永远不会调用它,对于从未设置 `allowResume` 的组合,`tool/result.meta` 会完全*缺席*——而不是一个 `null` 占位符——与 PR5 之前的 subagent 调用完全一致。

### 发布前的已分类失败需要一个新的工具层入口点

此前每一条已分类失败路径(PR3)都发生在发布*之后*:某个 `SubagentRun` 已经发布,其 `result` promise 之后要么拒绝,要么以 `SubagentResult.failure` 的方式解决,经由 `settleRunResult()` 结算。续接一个无效或未知的 id 则不同:`thread/resume` 可以在任何线程被发布*之前*就拒绝,因此 `ctx.subagents.start()` 自身就会同步地(准确地说,是以被拒绝的 promise 的形式)抛出一个 `ClassifiedSubagentFailure`,此时还没有任何东西被发布出来可供结算。`dsh-tool-subagent` 新增了 `rethrowStartupFailure(error)`:它把捕获到的 `ClassifiedSubagentFailure` 转换为发布后失败早已产生的那种*同样*可路由、经脱敏、按类别区分的 `SubagentError` 标题(`classifiedFailureHeadline()`),复用既有的呈现逻辑,而不是重复实现一遍。一个普通的 `SubagentError`(例如本 seam 自身的续接授权拒绝)会原样穿过这个函数——它本就已经是一个可路由的 `HarnessError`,不是需要重新分类的原生提供方失败。

## 考虑过的替代方案

- **在启动时签发、在续接时查询的进程内 `Map<resumeId, scope>`**——否决:harness 的 Session 可以在进程重启后存活(本仓库会把会话持久化到磁盘),因此进程内的登记表会在重启后悄悄地不再为合法续接授权,却没有比一个持久化、源自日志的检查提供更多面向攻击者的安全性。所选设计从与其它每一个模型可见事实所在的同一份持久事件日志中派生授权,因此无论授权调用发生在一秒钟之前还是跨了一次进程重启,续接的表现都完全一致。
- **比对部署配置中*原始*的 `Config.permissionMode` 值,而非请求的有效(已完成默认值处理的)值**——否决:这会把省略 `permissionMode`(默认为 `'read-only'`)的一个工具行,和显式写出 `permissionMode: 'read-only'` 的另一个工具行,仅仅因为部署方恰好用不同方式表述了完全相同的有效授权,就当成不同的范围,从而对一个根本无从得知其中差异的模型产生虚假的 `RESUME_REJECTED` 失败。比对有效值恰好只堵住了真正的安全缺口(真正更宽的范围),而不带来这种误报代价。
- **为「id 从未被签发」与「id 在不同范围下被签发」提供两条可区分的拒绝消息**——否决:这会把一个探测预言机交到模型手中(反复猜测 id 并读取得到的是哪一种失败,能让它探测出自己并不持有的有效 id／范围)。用同一条无法区分的 `RESUME_REJECTED` 消息就免费堵上了这个口子。
- **Claude 侧使用 `forkSession`**——考虑过并予以否决:`forkSession` 是从既有历史*分叉*出一个新会话,而这个特性真正需要的是跨调用续接*同一个* `session_id`(模型续接它自己此前的委派,而不是分叉出该委派的另一条时间线)。使用它将是另一个(此处并不需要的)特性。
- **用专门的分类代码区分 Claude 的续接失败路径(id 错误 对比 cwd 不匹配)**——实测之后予以否决:二者在线路上表现为完全相同的 SDK 级 `is_error: true` 结果消息形状,已经被*既有*的失败分类路径(PR3)处理;新增专门代码只会为一个 SDK 自身在线路上都不做区分的差异,重复实现一份本已可用的分类逻辑。
- **把 `presentationMeta` 条件展开进 `output`**——最先尝试,后予否决:会破坏 `defineTool` 整个调用的泛型推断(见上文「`presentationMeta` 仍然按 `allowResume` 门控」)。
- **不带类型断言的普通三元表达式(`allowResume ? fn : undefined`)**——第二次尝试,后予否决:`exactOptionalPropertyTypes` 会拒绝裸 `undefined` 假分支;改为只在那一个分支上做定向的 `as never` 类型断言来修复。
- **对被续接的线程原封不动地沿用 PR4「保留最后一次观测到的 `total`」规则**——探测之前的第一次尝试,实测之后予以否决:`total` 不会在 `thread/resume` 之后重置,因此会把一次续接调用的用量报告为该线程整个生命周期的累计总量,而不是那次调用自身的 token 数。
- **`prepareContinuable`**——按工作要求明确排除在本 PR 范围之外:它是持久化、由 harness 拥有、以 session 为基础的可续接子 agent 的机制(与本 PR 无关的另一个 PR),而不是提供方原生的进程外线程／会话续接。二者在同一个工具行上互斥(见上文「两层门控」)。

## 后果

- 从未设置 `allowResume`(默认状态)的组合完全不受影响:与 PR5 之前的 subagent 调用相比,工具 schema、结果 schema、渲染出的文本、以及 `tool/result` 事件形状(`meta` 完全缺席,而非 `null`)都完全相同。`spawn`／`fork`／`acp`／`dsh-sdk` 声明 `resume: false`,永远不会被要求支持它。
- 在 `codex`／`claude-code` 上配置 `allowResume: true` 的部署,能让模型跨调用续接某次特定委派的确切上下文,代价是提供方原生的进程／线程／会话状态存活时间会超过一次工具调用。
- **续接后的线程／会话会出现在宿主自身的产品历史记录中。** Codex 的持久化线程存储在 `~/.codex` 的会话历史中,与用户自己的交互式会话完全一样;Claude 续接的会话存储在以 cwd 为键的 `~/.claude/projects/` 中,并会出现在用户自己的 `claude --resume` 选择器里。这是一个持久的、宿主可见的副作用,选择启用 `allowResume` 的部署方应当预见到这一点,而不是把它当作内部实现细节。
- **Claude 的存储以 cwd 为键**,因此从与创建会话时不同的 cwd 续接会失败(经由既有的 `is_error` 路径分类为 `provider`)——这是一个真实的、经实测确认的限制,不是缺陷:被续接子 agent 的工作区固定在*最初*那次委派上,该提供方从不尝试把一个持久化的会话迁移到新的 cwd。
- **重放父级 Session 日志不再能重现被续接子 agent 的内部状态。** 模型可见 ⟺ 已记录这一不变式对*父级*自身的日志依然完全成立(resume id、请求、结果全都能忠实地重建),但*子* agent 自身提供方原生的线程／会话会跨续接独立演化——第二次重放父级日志并不能重新推导出子 agent 持久化状态此刻的内容,这与一个纯粹在 harness 内部、不可续接的子 agent 不同,后者的全部行为都是其已记录请求的确定性函数。
- 一次本会话从未授权过的续接尝试会在到达提供方*之前*就失败,提供方侧的调用次数为零(直接证明:安全回归测试断言 scripted/真实 提供方自身的调用计数器始终保持为零)。
- 无论是否被续接,Codex 在任何已完成运行上的 `usage` 字段现在都是按回合对 `last` 求和,而不再保留最后一次观测到的 `total`——这一修正对未被续接的线程是不可见的(那里两种写法殊途同归),但一旦 resume 存在就成为必要,因为 `total` 是线程生命周期内的累计值。

## 测试

- `packages/subagent/subagent/tests/resume-issuance.spec.ts`(新增):对 `verifyResumeIssuance`／`readIssuance` 的单元覆盖——精确匹配、多条已记录签发、id／provider／permissionMode／cwd 分别不匹配、每一条格式错误分支(缺失 meta、非对象 meta、缺失键、非对象值,以及每个字段各自的格式错误/缺失/为空)、跳过非 `tool/result` 事件、空日志。该文件单独运行时语句/分支/函数/行覆盖率均为 100%。
- `packages/subagent/subagent/tests/service.spec.ts`:`SubagentRuntime` 层面的续接能力拒绝、成功的已授权续接、`cwd === undefined` 的失败关闭分支,以及未签发 id 的拒绝——全部直接针对真实 service,不涉及工具层。
- `packages/subagent/subagent-codex/tests/subagent-codex.spec.ts`:持久化(非临时)线程创建与反转后的断言;`thread/resume` 驼峰式 `threadId` 字段的验证;续接时重新钉定的 `sandbox`／`approvalPolicy`;一个被拒绝/未知的续接 id 被分类为 `provider`;线程 id 不匹配的完整性拒绝;来自格式错误 `thread/resume` 响应的非 `JsonRpcResponseError` 已分类失败重新抛出;改写后「累计总量不被求和」的用量测试;格式错误的 `last` 字段被分类为 `protocol`。
- `packages/subagent/subagent-claude-code/tests/subagent-claude-code.spec.ts`:根据 `requestResume`／`resumeId` 构建 `persistSession`／`resume` 选项;仅在持久化且成功的运行上,`resumeId` 才会被 `consumeClaudeQuery` 回显。
- `packages/subagent/tool-subagent/tests/tool-subagent.spec.ts`(`describe('dsh-tool-subagent resume (PR5, opt-in)', ...)`,约 14 个测试):默认情况下 schema／结果字段被排除;加载期拒绝 `allowResume` 与 `backgroundMode: 'continuable'` 的组合;挂载期在缺少 `resume` 能力时拒绝;已开启选项的全新调用上报 `resumeId` 及精确的 `meta.subagentResume` 记录;字节相同的默认路径证明(`meta` 始终保持 `undefined` 而非 `null`,即便底层脚本化提供方在被要求时*会*上报 `resumeId`);一次成功的续接原样转发该 id;**安全回归(测试 4):本会话从未签发过的 `resume_id` 会失败关闭,提供方调用次数为零**;**安全回归(测试 4b):同一个 id、同一个提供方的签发,在*不同*工具行/`permissionMode` 下被续接同样会失败关闭,提供方调用次数为零**;一个发布前的已分类启动失败,通过与发布后失败相同的标题呈现;`run_in_background: true` 与 `resume_id` 组合被拒绝;既有的挂钟超时对被续接的调用同样适用。
- `packages/subagent/subagent-codex/tests/real-product.spec.ts` 与 `packages/subagent/subagent-claude-code/tests/real-product.spec.ts`(新增 `describe` 代码块,无需密钥,针对*真实的* `codex`／`claude` 二进制文件,绝不触碰用户自己的 `~/.codex`／`~/.claude` 存储——所用到的每一个 id 都是在测试自身的测试夹具运行中生成的):完整的续接,包含上下文保留以及在真正的第二回合之后按次(而非按线程)精确断言用量;被续接的只读子 agent 依然无法写入,与全新调用完全一样;无效/伪造的续接 id 被分类为提供方失败;Claude 的 cwd 不匹配分类。
- `examples/acp-agent/product-subagent-codex-resume.cordis.yml`(以及与之配对的无需密钥的 `.cordis.snapshot.yml`)是一个新增的无密钥快照场景——第一个把 `allowResume: true` 对 `subagent_codex` 模型可见工具 schema 的影响(`resume`／`resume_id` 参数、`resumeId` 结果属性)固定下来的场景,沿用了 PR4 自己为「模型可见 schema 发生变化」所设立的快照刷新先例。它复用了 `product-subagent-codex` 的系统提示词(`allowResume` 不会改变委派引导性文字),只固定了自己的 `tool-schemas.expected.json`,该文件与 `product-subagent-codex` 的差异恰好就是那新增的三个 schema 属性。每一个*其它*既有的无密钥快照(包括每一个其它 subagent 场景)都不受影响、原样通过,因为没有任何已发布的组合会设置 `allowResume`——这正是「默认字节相同」这一保证在快照层面(而不仅仅是单元测试层面)的体现。
