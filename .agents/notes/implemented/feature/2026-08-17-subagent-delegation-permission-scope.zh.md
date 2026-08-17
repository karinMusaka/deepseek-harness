# Agent Note: `codex` 与 `claude-code` subagent 获得委派时固定的权限范围

Status: implemented

[English](2026-08-17-subagent-delegation-permission-scope.md) | 中文

## 问题

[审批钉定 Agent Note](2026-08-10-subagent-approval-pinned-never.md) 指出「子 agent 的全部权限故事就是它的沙箱范围」，且 `claude-code`、`codex`、`dsh-sdk` 子 agent「运行在外部进程中，由各自的组合决定」——但那个「组合」实际上就是*宿主*的组合。`subagent-codex` 在 `thread/start` 中省略了 `sandbox`／`approvalPolicy`，因此子 agent 会继承宿主恰好拥有的任何 `~/.codex/config.toml`。`subagent-claude-code` 省略了 `settingSources`，于是官方 SDK 会读取宿主的 `~/.claude/settings.json`、项目设置、CLAUDE.md 与 MCP 配置。同一次委派调用因而会因部署方无法控制的宿主配置漂移而产生不同的子 agent 行为，且两个提供方都不提供任何方式来保证子 agent 无法写入。

若通过新增一个 `permission_mode` 工具参数来弥合这个缺口（早期简报建议的形式），会让发起委派的模型为自己的子 agent 逐次选择权限范围——这直接违背了审批钉定 Note 的规则:「放宽的决定始终属于父级一侧」。

## 决策

`packages/subagent/subagent/src/types.ts` 新增了一个封闭的 `SubagentPermissionMode = 'read-only' | 'workspace-write'`、一个 `SubagentCapabilities.permissionMode: boolean` 标志（并入既有的启动期能力集合，与 `outputSchema`／`depthLimit`／`toolFilter`／`persona` 并列），以及一个受该能力门控的可选 `SubagentStartRequest.permissionMode` 字段,门控方式与其它字段完全一致。`NO_START_CAPABILITIES` 以及每个提供方的能力字面量——`spawn`、`fork`、`acp`、`dsh-sdk`——都将 `permissionMode` 设为 `false`：进程内子 agent 本就共享父级自身的 Cordis 权限，没有独立的范围需要固定；`subagent-acp` 则保留其自身显式的机器 `permission` 策略。只有 `codex` 与 `claude-code` 将 `permissionMode` 设为 `true`。

`dsh-tool-subagent` 的 `Config.permissionMode?: SubagentPermissionMode` 是一个普通的可选字段，没有 Schemastery 的 `.default(...)`——省略时经由 Loader 后仍保持 `undefined`（与 `persona` 已采用的写法相同），`apply()` 只在该值存在时才将其转发到启动请求（`...config.permissionMode !== undefined ? { permissionMode: config.permissionMode } : {}`），与 `persona`／`toolFilter` 完全一致。挂载期会拒绝对不具备该能力的提供方显式配置 `permissionMode`，其形式与既有的 `backgroundMode: continuable` 及数值型 `maxDepth` 挂载检查相同。该字段仅是部署配置；模型永远不会把它当作工具参数看到。「缺省即为提供方自身的默认值，而每个提供方都将该默认值定义为 `read-only`」（该字段的 JSDoc）是在*提供方*一侧强制执行的，而非工具层：`CodexProvider.start()` 与 `ClaudeCodeProvider.start()` 都会在构建各自的运行规格之前解析 `request.permissionMode ?? 'read-only'`。若在工具层具体化一个默认值并无条件转发给每个提供方，会导致每一个现有的 `spawn`／`fork` 组合在挂载时失败，并让「仅当针对不支持的提供方显式指定时才拒绝」这条验收标准变得空洞（每次使用都会失败，而不仅是显式配置的那次）——提供方一侧的默认值正是在不引入这种回归的前提下兑现「失败即封闭」的方式。

`subagent-codex` 的 `wire.ts` 中 `startThread()` 现在会在每次 `thread/start` 上发送 `sandbox: permissionMode === 'workspace-write' ? 'workspace-write' : 'read-only'` 以及字面量 `approvalPolicy: 'never'`，二者在 app-server 0.147.0 中均为非实验性参数。二者都不再从 `~/.codex/config.toml` 读取——同一次委派现在无论宿主如何漂移都表现一致，而 `approvalPolicy: 'never'` 也与审批钉定 Note 的原则一致（审批始终钉定为 `'never'`），补齐了该 Note 此前留给「各自组合」的那一类提供方。

`subagent-claude-code` 的 `claudeQueryOptions()` 现在在两种模式下都无条件设置 `settingSources: []`（将子 agent 与宿主的用户／项目／本地 Claude 设置、CLAUDE.md 及 MCP 服务器隔离——而非与账号鉴权隔离，二者是不同的关注点），并设置 `permissionMode: 'default'`，然后提供一个固定的 `canUseTool`：默认拒绝，仅允许一份针对已锁定 SDK 的 `sdk-tools.d.ts` 校验过的固定工具名白名单（`read-only` 下为 `Read`、`Glob`、`Grep`、`WebFetch`、`WebSearch`；`workspace-write` 下再加入 `Write`、`Edit`、`NotebookEdit`、`Bash`）。`disallowedTools: ['AskUserQuestion']` 保持不变。

## 实测依据（基于真实 Claude Code 2.1.220，在选定机制之前测得）

| 配置 | 是否调用 `canUseTool`？ | 写入是否成功？ |
|---|---|---|
| 默认（此前已发布的行为） | — | **是** |
| `disallowedTools: ['Write', 'Edit', 'NotebookEdit']` | — | **是** |
| `permissionMode: 'plan'` | — | 被阻止，但会写入 `~/.claude/plans/`（工作区之外） |
| `canUseTool` 拒绝，省略 `settingSources` | **从未调用** | **是** |
| `canUseTool` 拒绝 **+ `settingSources: []`** | 已调用 | **被阻止** |

被拒绝的 `Write` 在同一次运行中立即通过 `Bash`（`printf ... > probe.txt`）绕开了拒绝。拒绝列表方式对其未列举的任何工具都会失败开放——`Task`、未来 SDK 新增的工具，或已锁定 SDK（2.1.220）与实际安装的 CLI（本仓库开发环境运行的是 2.1.233）之间的版本漂移——这正是为何最终交付的是允许列表而非仅作权宜之计。

## 考虑过的替代方案

- **模型可见的 `permission_mode` 工具参数**——直接否决：它让发起委派的模型为自己逐次选择放宽后的范围，违背[审批钉定 Note](2026-08-10-subagent-approval-pinned-never.md)中「放宽属于父级」的规则。未曾尝试；仅凭该约束即已排除。
- **`disallowedTools` 拒绝列表**——否决：实测无效（见上表）；在已发布的默认配置下宿主自身的预先批准使得权限判断根本不会发生，即便强化拒绝列表，一旦 `Bash` 通过另一条路径执行了被拒绝的意图，仍会失败开放。
- **`permissionMode: 'plan'`**——否决：确实阻止了直接写入，但只是把写入位置转移到了 `~/.claude/plans/`，这是委派工作区之外的一次写入，而 `read-only` 范围本应同样禁止它。
- **省略 `settingSources: []` 的 `canUseTool`**——否决：宿主的环境 Claude 设置预先批准了足够多的工具，以至于回调根本不会被调用，缺少隔离标志时执行点根本不存在。
- **在工具层具体化并无条件转发的默认值**（`z.union([...]).default('read-only')`，始终设置在请求上）——在实现期间考虑并否决：它满足「失败即封闭」的字面含义,但会把 `permissionMode` 无条件转发给每一个提供方,无论其能力如何,于是每一个现有的 `spawn`／`fork` 组合（均未设置该字段）都会在挂载时失败,而「仅当针对不支持的提供方显式指定时才拒绝」这条验收标准也会变得空洞。最终方案在工具层保持该字段真正可选,并把失败即封闭的默认值移到提供方一侧（见决策）。
- **Codex：把 `sandbox`／`approvalPolicy` 留给 `~/.codex/config.toml`**（此前的行为）——否决：这正是本 Note 要解决的宿主漂移问题；在本环境中已经观测到一个无关 MCP 服务器的 OAuth 错误泄漏进入了一次无关委派的审批行为。

## 后果

- `spawn`、`fork`、`acp`、`dsh-sdk` 组合不受影响：它们都不声明该能力，也不接受该字段，从未设置 `permissionMode` 的 `tool-subagent` 配置行为与此前完全一致。
- 每一次 `codex` 或 `claude-code` 委派默认都是 `read-only`，除非部署方在指向该提供方的 `tool-subagent` 实例上显式配置 `permissionMode: 'workspace-write'`；发起委派的模型无法请求更宽的范围。
- 两个提供方的 `workspace-write` 并不等价：`codex` 的 `sandbox: 'workspace-write'` 是操作系统级的 seatbelt／landlock 边界，将写入限定在子 agent 自己的工作目录内；`claude-code` 的 `workspace-write` 只是拓宽了固定的工具名白名单，并不强制路径限制——如果真实 CLI 自身的工具实现允许，`Write`／`Edit`／`Bash` 调用仍可能指向子 agent 工作目录之外的路径。两份 README 都在 Known Limitations 中记录了这种不对称。
- `subagent-claude-code` 的 `settingSources: []` 也意味着子 agent 不再读取宿主的 CLAUDE.md 或 MCP 服务器，这推翻了该包此前文档记载的「读取宿主的正常用户、项目与本地 Claude 设置」行为，并消除了由宿主设置驱动的上下文膨胀。
- 真实产品测试（`packages/subagent/subagent-codex/tests/real-product.spec.ts`、`packages/subagent/subagent-claude-code/tests/real-product.spec.ts`）通过各提供方自身的 spawn 路径、针对本地夹具后端，证明了两个方向：`read-only` 子 agent 能读取文件但无法创建文件——包括经由 `Bash`／shell 的绕行尝试——而 `workspace-write` 子 agent 可以在自己的工作目录中创建文件。无需真实产品订阅；夹具用一个伪造的 API key 伪造了模型后端。
