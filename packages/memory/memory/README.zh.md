# @deepseek-ai/dsh-memory

[English](README.md) | 中文

持久的跨会话记忆。`MemoryService` 以 host-plane 单例的形式注册 `ctx.memory`：它在每个进程中只打开一次 `memory` 存储 domain，并让每个会话共享同一份内存缓存与持久表——这正是让所存记忆成为「跨会话」而非「按会话」的原因。一张扁平的 `entries` 表同时承载用户的个人记忆（`scope: 'user'`）与逐项目记忆（`scope: 'project:<path>'`）；每条记录还携带 `kind`（`fact` | `preference` | `decision` | `note`）、自由格式的 `content`、可选的搜索 `tags`，以及访问追踪时间戳。`MemoryId` 是一个带品牌的字符串 id。该包没有 `Config`；存储 domain 这一层没有任何可调项。

## 服务约定

`remember(input)` 会先修剪 `content`，若修剪后为空则拒绝；随后铸造一个 `MemoryId` 与各时间戳，在持久写入之前先把新条目发布到内存缓存，并在该写入失败时回滚缓存——持久写入失败绝不会让缓存指向一个表中并不存在的条目。`edit(id, patch)` 与 `touch(id)` 遵循同样的「先发布、再持久化、失败即回滚」顺序；`forget(id)` 先从缓存中删除，若持久删除失败再将其恢复。

`recall(query)` 在内存缓存中搜索：`text` 会对 `content` 与 `tags` 做大小写不敏感的匹配，`kind` 与 `tags` 进一步收窄范围，且给定的每个筛选条件都必须满足。结果按 `accessCount` 降序、再按 `updatedAt` 降序排序，并截断为 `query.limit`（默认 `12`）。作用域选择是刻意不对称的：查询一个项目作用域也会带出用户的个人记忆（个人记忆会跟随用户进入每个项目）；查询 `user` 只返回个人记忆；省略作用域则搜索全部。`touch(id)` 会递增 `accessCount` 并刷新 `lastAccessedAt`，从而提升该条目在后续 `recall` 调用中的排名；对不存在的 id 是空操作。`list(scope?, kind?)` 是按 `updatedAt` 降序的纯过滤列表，不做排名，并且——与 `recall` 不同——项目作用域不会一并带出 `user` 条目。`get(id)` 与 `has(id)` 直接读取缓存。

## 持久性

`memory` domain（`memoryDomainSpec`，版本 `1`）声明了一张以 `MemoryId` 为键、基于 `memoryEntry` zod schema 的 `entries` 表；每条已存记录在打开时都会经该 schema 往返校验，因此格式错误的行会在污染其余表之前被拒绝。持久形状的 schema 变更必须提升版本号，而不是悄悄地重新解释旧记录。该服务需要 `ctx.storageDomain`（[`dsh-storage-domain`](../../storage/storage-domain/README.md)），并在 dispose（资源释放）时关闭其 domain 句柄。

`./invariant` 配套插件检查内存缓存与持久表之间的既有关系：针对 `memory`／`entries` 的 `domain/changed`，一次 `put` 必须已经在缓存中可见，一次 `delete` 必须已经在缓存中缺席，从而捕获绕过 `ctx.memory` 的写入路径。

## 模型体验

### 跨会话记忆存储

#### 模型看到的内容

没有直接内容。此服务不注册任何工具、提示词段落或面向模型的上下文；[`@deepseek-ai/dsh-tool-memory`](../tool-memory/README.md) 是唯一的消费方，把 `ctx.memory.remember`／`recall`／`list`／`forget`／`edit` 转化为工具调用与 runtime-context 快照。

#### Token 影响

此包本身没有。存储记忆产生的每一个面向模型的 token，都记在 `dsh-tool-memory` 的模型体验中。

#### KV Cache 影响

相互独立。一次 `remember`、`edit`、`touch` 或 `forget` 调用本身不会触及模型请求前缀；任何缓存影响都是消费方基于更新后状态渲染内容所带来的后果。

## 已知限制与暂缓事项

- **仅支持子串搜索**：`recall` 的 `text` 过滤器是对 `content` 与 `tags` 做大小写不敏感的子串匹配；不存在语义或模糊检索，因此改写过的查询可能漏掉相关条目。
- **项目作用域按字面路径字符串作键**：`project:<path>` 使用调用方提供的确切字符串；将项目迁移到新路径会让其既有记忆变成遗留数据，而该路径的子目录则是一个不同的、无关的作用域。
- **条目数与表都没有大小上限**：条目数量和存储总字节数均不设界；不受限的 `remember` 流会让持久表与内存缓存无限增长。
- **依赖 `ctx.storageDomain`，而它仅限 web-app**：在未挂载 [`dsh-storage-domain`](../../storage/storage-domain/README.md) 的 headless 或 ACP 组合中，memory domain 无法打开。
- **排名没有时间衰减**：`recall` 的排名是先按 `accessCount` 降序、再按 `updatedAt` 降序，因此被频繁访问的条目会无限期地压过更新的条目；访问计数没有老化或归一化处理。
