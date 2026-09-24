# @deepseek-ai/dsh-tool-memory

[English](README.md) | 中文

面向模型的工具，覆盖在持久的跨会话 [`ctx.memory`](../memory/README.md) 服务之上：`memory_remember`、`memory_recall`、`memory_list`、`memory_forget` 与 `memory_edit`。`tool:memory` runtime-context 贡献还会自行把最相关的已存记忆作为已记录的快照送出，因此一个事实无需显式的召回调用即可被采纳。这是一个函数／命名空间插件：导出 `name` / `inject` / `Config` / `apply`，没有默认导出。

## 作用域

一次工具执行最多可以读写两个作用域：`user`（个人记忆），以及——当它运行在某个 agent（智能体）之下时——该 agent 当前的项目作用域 `project:<agent.session.header.cwd ?? process.cwd()>`。`memory_remember` 默认写入当前项目作用域（只有当模型明确要求，或没有可用的项目作用域时才写入 `user`）；`memory_recall` 默认也是当前项目作用域，它同时会带出 `user` 记忆，也接受显式的 `scope: 'user'` 以仅搜索个人记忆。`memory_list` 始终精确列出当前项目作用域（在 agent 之外则是 `user`），与 `ctx.memory.list()` 更窄的语义一致——它不会一并带出 `user` 条目。`memory_forget` 与 `memory_edit` 接受任意 id，但会拒绝作用于一个作用域不属于调用方两个可用作用域之一的条目，返回 `{ ok: false, message: 'That memory belongs to another project and cannot be … here.' }`；未知 id 会直接传给 `ctx.memory`，并按普通的「未找到」返回。

## 配置

| 键 | 默认值 | 含义 |
|---|---|---|
| `contextLimit` | `10` | runtime-context 快照最多列出的条目数。`0` 会完全禁用该快照——工具仍会注册，但不会产生 `tool:memory` 上下文贡献。 |
| `maxRecallLimit` | `50` | 施加于模型请求的 `memory_recall` `limit` 的上限；实际生效的 limit 为 `max(1, min(maxRecallLimit, limit))`。 |

web-app 组合包挂载 `dsh-memory` 服务，并把本包作为依赖一同发布，但不挂载它。agent preset（智能体预设）的 `agent.cordis.yml` 用下面这一行为某个 agent 启用它：

```yaml
- id: tool-memory
  name: '@deepseek-ai/dsh-tool-memory'
  config:
    contextLimit: 10
    maxRecallLimit: 50
```

## Runtime-context 贡献

当 `contextLimit` 非零时，`apply` 会注册一个名为 `tool:memory`、顺序为 `117`、`interpolate: false` 的 `ctx.systemPrompt.context()` 条目。其 `text(context)` 在 agent 之外返回 `''`；否则会调用 `ctx.memory.recall({ scope: projectScopeOf(agent), limit: contextLimit })`——一次项目作用域的召回，同时会带出 `user` 记忆——并在召回非空时渲染出表头行加每条命中的一行 `entryLine`，为空时返回 `''`。之所以需要 `interpolate: false`，是因为已存记忆条目是任意的用户撰写文本：一段被记住的事实中形似 `{{…}}` 的子串必须按字面渲染为普通文字，绝不能被当作模板引用解释。agent loop（智能体循环）会把渲染出的文本转化为一条已记录的 `user` 角色 runtime-context 快照，只有当它与保留快照不同、或此前的快照被压缩（compaction）移除时才会重新发出（见 [`packages/core/agent-loop/src/runtime-context.ts`](../../core/agent-loop/src/runtime-context.ts) 与 [`dsh-system-prompt`](../../core/system-prompt/README.md)）。这个上下文提供方不会调用 `touch`；只有 `memory_recall` 会调用，因此快照本身的排名不会因为「已被展示」而改变。

## 模型体验

### Runtime-context 记忆快照

#### 模型看到的内容

当 `contextLimit` 非零且调用运行在某个 agent 之下时，一次项目作用域召回（当前项目加个人记忆）中排名最靠前的 `contextLimit` 条条目会渲染为一个固定表头行，后跟每条条目一行：`- [<kind>] <scope>[ [tags]]: <content>  (id: <id>)`；召回为空时不贡献任何内容。

##### 表头行

```markdown
Stored memory about the user and this project (act on it; update via memory_remember when it changes):
```

#### Token 影响

由 `contextLimit` 设上限：最多是该数量的条目行加固定表头，召回为空或 `contextLimit` 为 `0` 时则为零。

#### KV Cache 影响

仅追加：只有当渲染文本与保留快照不同时，才会以一条新的 user 角色消息记录快照，因此它绝不会重写系统提示词前缀。一次 `memory_recall` 对某条命中执行 `touch`，可能在下一轮改变排名前 `contextLimit` 条的集合，从而改变渲染文本并追加另一条快照；`memory_remember`、`memory_edit` 或 `memory_forget` 若影响到排名靠前的条目，也会产生同样的效果。

### 工具 schema

#### 模型看到的内容

生成的 [`memory_remember`、`memory_recall`、`memory_list`、`memory_forget` 与 `memory_edit` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-memory)。

#### Token 影响

每个可见工具的固定 schema 成本，出现在这些工具处于作用域内的每次请求中。

#### KV Cache 影响

只要定义与可见性不变，前缀就保持稳定。插件生命周期或作用域限制可能使这些 schema 的复用失效。

## 已知限制与暂缓事项

- **仅支持子串搜索**：`memory_recall` 继承了 `ctx.memory.recall` 的大小写不敏感子串匹配；不存在语义搜索，因此改写过的查询可能漏掉相关记忆。
- **作用域按字面 `cwd` 字符串作键**：一个项目的作用域是调用时那个确切工作目录字符串对应的 `project:<cwd>`；把项目迁移到新路径会让其记忆在旧键下变成遗留数据，而一个项目的子目录是一个不同的作用域，无法访问父项目的记忆。
- **依赖 `ctx.storageDomain`，而它只由 web-app 组合包挂载**：headless 与 ACP 组合并未挂载 [`dsh-storage-domain`](../../storage/storage-domain/README.md)，因此该包的记忆在那些组合中没有可打开的持久 domain。
- **`memory_recall` 会对它返回的每一条命中执行 touch**：每次调用都会为每条返回的条目递增 `accessCount` 并刷新 `lastAccessedAt`，因此对同一宽泛查询的反复召回会不断提升这些条目的排名，无论模型是否据此采取了行动。
- **已存条目没有大小上限**：无论是 `ctx.memory` 还是本包，都不限制条目数量或内容总大小；不受限的 `memory_remember` 流会让 runtime-context 召回池与持久表无限增长。
