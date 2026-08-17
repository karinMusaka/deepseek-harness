# Agent Note: 委派 subagent 运行的墙钟超时

Status: implemented

[English](2026-08-17-subagent-delegation-timeout.md) | 中文

## 问题

两种进程外 subagent 协议都没有超时机制。`ThreadStartParams`／`TurnStartParams`（`subagent-codex`）和 SDK 的 `Options`（`subagent-claude-code`）都没有承载墙钟上限的字段，而 `subagent-codex` 现有的 `disposeGraceMs` 配置是**在做出停止决定之后**的 teardown（拆卸）宽限期，并不限定做出该决定之前运行可以耗费多长时间。针对一个真实的未认证 Codex CLI 实测：app-server 会重试 WebSocket 连接 5 次，然后回退到 HTTPS 再重试 5 次，才最终失败——在这条重试链运行期间，一个卡死、登录已过期的委派与一个真正挂起的委派毫无区别，而 `dsh-tool-subagent` 或任一提供方都没有任何机制更早地终止它。

## 决策

`dsh-tool-subagent` 的 `Config` 新增 `timeoutSeconds?: number`：一个正的有限数，换算为毫秒后不超过 `MAX_TIMER_DELAY_MS`（`@deepseek-ai/dsh-timeout`），使用与 `subagent-codex` 的 `disposeGraceMs` 已经采用的同一个 `assertPositiveFinite` 辅助函数校验（同时覆盖 Loader 的 schema 路径,以及绕过 Schemastery 的直接 `apply()` 调用路径，与既有 `maxDepth` 的双路径覆盖方式一致）。不附加 Schemastery 的 `.default(...)`：下文的权限范围 Note（PR1）已经用惨痛教训证明了这一点——一旦本包升级，在此处具体化一个默认值会在不知不觉中截断每一个现有的 `spawn`／`fork` 组合中运行时间较长的委派。省略该键会精确保留现有行为：没有上限。

计时器由 `dsh-tool-subagent` 拥有，而不是 `dsh-subagent` 或任一进程外提供方。该工具本就持有 `exec.signal`，并据此构造 `SubagentStartRequest.signal`；`packages/util/timeout` 的 `deadline(exec.signal, timeoutMs, 'SUBAGENT_TIMEOUT')` 会把这个上游信号与一个等效于 `AbortSignal.timeout` 的已启动计时器合成为一个信号，真正传给 `ctx.subagents.start()` 的正是这个合成信号。`timeoutMs <= 0`（省略 `timeoutSeconds` 时的情形）是 `deadline()` 自身的「无计时器」哨兵值：它会**按同一对象引用**转发上游信号，因此省略上限时既不分配计时器，也不产生新的信号对象——一个从不设置该字段的重委派组合不会为这项能力的存在付出任何代价。计时器在调用 `ctx.subagents.start()` 之前就已启动，而不是等它 resolve 之后才启动，并且用 `try`／`catch` 包裹这次调用：促成本次改动的 Codex 重试循环失败正是发生在启动期间，而非被等待的结果阶段，因此若计时器只包裹 `run.result`，就会漏掉本 Note 要解决的这个情形。

由于计时器由本工具持有，它天然就知道一个 `aborted` 结果究竟来自自身计时器到期，还是来自调用方自己的取消——`timeoutOf(deadlineSignal, 'SUBAGENT_TIMEOUT')` 恰好能在本实例的计时器赢得竞态时把 `TimeoutReason` 还原出来，即便两者竞争的是同一个合成信号，也能将其与真正的调用方取消区分开。`stopReasonError()` 借此报告 `subagent run hit its <N>s time limit before finishing`（沿用既有 `max-tokens` 标题的写法，以模型视角表述，不含计时器／信号／中止等词汇），取代此前一律返回的 `subagent run was cancelled`；其余每一种 `aborted` 结果，包括与已启动计时器竞态的真实调用方取消，仍然读作已取消。`withPartialText()` 未作改动，仍会在任一标题之后附加保留下来的部分输出。`using`（TC39 显式资源管理）负责前台计时器的释放；前台分支必须 `await` 结算 promise 而不是直接原样 `return` 它，因为裸 `return settleForegroundRun(...)` 会让 `using` 块的同步退出在被返回的 promise 真正结算之前就清除计时器——超时根本来不及触发。

`timeoutSeconds` 适用于一次前台调用与一次一次性后台调用——这两种运行都由本工具从头到尾拥有。它会在 `apply()` 阶段与 `backgroundMode: 'continuable'` 一起被拒绝（纯粹的配置对配置检查，完全自包含，因此像既有的空 `toolFilter` 检查一样在加载期失败）：可继续子 agent 的轮次在 inbox 接受之后归继续执行服务所有，而不属于本工具，因此这里没有可供计时器终止的运行。一次性后台路径会围绕 job 自身持有的 `AbortController` 信号合成同一个 `deadline()`，并在 job 的 `done` promise 的 `.finally()` 中释放它（裸 `using` 无法横跨一个在异步工作完成之前就已返回的同步闭包）；`SubagentResult`／`SubagentStopReasonMap` 保持不变，因此通用 Task 接口（`job_output`、结算通知）仍会把超时的一次性子 agent 报告为 `[status: killed]`，与显式的 `job_kill` 完全相同——见「已知限制」。

`subagent-codex` 的 `real-product.spec.ts` 新增了一个测试，证明了与既有手动取消测试相同的静止 teardown（拆卸）结果，但触发方式是 `dsh-timeout` 的 `deadline()` 在真实计时器到期后自动触发，而不是显式调用 `controller.abort()`——提供方无需任何改动，因为两条路径最终都汇聚到同一份信号中止约定；这个测试特意放在提供方自身的测试套件中，而不是让 `subagent-codex` 反过来依赖 `dsh-tool-subagent`，因为「信号被中止后进程树归于静止」是提供方自身应当保证的能力，与究竟是哪个调用方的组合产生了这次中止无关。

## 已考虑的替代方案

- **在 `SubagentStopReasonMap` 中新增 `timeout` 变体**——已拒绝：启动计时器的工具本就知道自己合成的信号为何中止（对该信号调用 `timeoutOf()` 即可），因此拓宽一个被每个提供方、每个 `dsh-subagent` 消费者共享的 contract（约定）在此毫无收益。这个终止原因联合类型跨越了一个能力接缝（capability seam，见 `docs/glossary.md#capability-seam`）；而本次改动仅局限于一个工具实例自己合成的信号，理应留在那一层，而不是放到接缝上。
- **在 `SubagentResult` 上增加一个失败详情通道**（例如 `timedOut: boolean` 字段）——出于同样的理由被拒绝，且规格明确划出了这条边界：通用的错误分类（认证／配额）、`changed_files`、`usage` 以及会话续接都是独立的后续工作；本次改动只限于这一个墙钟上限及其面向模型的报告。
- **具体化一个默认的 `timeoutSeconds`**（例如 `z.number().default(120)`）——已拒绝：与 PR1 拒绝 `permissionMode` 默认值的失败模式完全相同。一个被无条件转发的默认值会在升级时悄悄截断每一个现有 `spawn`／`fork` 组合中运行时间较长的委派；只有部署方显式选择加入才是安全的。
- **只包裹 `run.result`，不包裹 `ctx.subagents.start()`**——已拒绝：实测到的真实失败（Codex 未认证时长达 10 次的 WebSocket／HTTPS 重试链）恰恰发生在启动期间。一个只限定被等待结果的计时器,会恰好放过这一种情形。
- **在 `JobOutcome` 中区分超时的一次性后台运行**——推迟处理，而非直接拒绝：`dsh-jobs` 的 `JobOutcome`／`runOutcome()`（`packages/subagent/subagent/src/run-settlement.ts`）是与其他每一种 job 类型共享的 contract，如今 `aborted → { status: 'killed' }` 本就把 `job_kill` 与提供方一侧的中止折叠成同一种报告；仅为这一个调用方拓宽它是一项更大、需要单独立项的改动。已记录在包 README 的「已知限制」中，而非在本次改动中解决。

## 后果

- 一个从不设置 `timeoutSeconds` 的 `spawn`／`fork`／`acp`／`dsh-sdk` 组合完全不受影响：没有计时器、没有新的信号对象、工具 schema 逐字节不变（该字段是部署配置，从不是模型可见的工具参数）。
- 设置了 `timeoutSeconds` 的部署会为子 agent 的启动过程与整次运行获得一个硬性的墙钟上限，涵盖已实测到的 Codex 重试循环失败，以及未来任何具有类似缓慢失败路径的提供方，且两个提供方都无需各自实现超时机制。
- 模型仅凭前台工具结果本身，就能把超时与其他每一种终止结果（`cancelled`、`failed`、`token limit`、`declined`，以及未来某个尚未识别的终止原因）区分开；一次性后台运行的超时目前还无法通过通用 Task 接口区分出来（见包 README 中的「已知限制」）。
- `timeoutSeconds` 与 `backgroundMode: 'continuable'` 在同一个工具实例上互斥；若某个部署两者都需要，应改为限定可继续提供方自身的运行时（不在本次改动范围内）。
- `packages/subagent/tool-subagent/tests/tool-subagent.spec.ts` 覆盖了：超时标题与取消标题的区分、启动阶段超时与结果阶段超时标题相同、调用方取消与一个（更长的）已配置上限竞态时仍读作取消、省略上限路径原样转发上游信号（证明不分配任何计时器或包装信号）、与 `backgroundMode: 'continuable'` 组合在 schema 路径与直接 `apply()` 路径上均在加载期被拒绝，以及非法的 `timeoutSeconds` 取值（零、负数、`NaN`、正负无穷,以及超出 `MAX_TIMER_DELAY_MS` 的值）在两条路径上均被拒绝。`packages/subagent/subagent-codex/tests/real-product.spec.ts` 针对真实 app-server 进程树，覆盖了真实计时器到期后归于静止的 teardown（拆卸）。`examples/acp-agent/tests/snapshots/subagent-timeout/` 是一个 keyless（无需密钥）的组装应用快照：一个 fork 出的子 agent 的真实 `bash` 调用阻塞在一次真实的 `sleep` 上，配置的 0.2 秒上限在调用过程中触发，持久化的父级日志逐字节钉住了确切的模型可见标题文本（`subagent run hit its 0.2s time limit before finishing`）。该固件的确定性依赖于 fork 出的子 agent 消耗完它唯一一次脚本化的模型调用、并在 0.2 秒上限之内到达 `bash` 调用（本地实测余量约为 5 倍）；如果某个负载很重的 CI runner 有朝一日未能满足这一点（症状：`assertConsumed` 报告某个子 agent 脚本未被绑定），把 `subagent-timeout.cordis.yml` 与 `subagent-timeout.cordis.snapshot.yml` 中的 `timeoutSeconds` 都调高，然后重新运行 `pnpm run test:snapshot:refresh -t subagent-timeout` 即可。
