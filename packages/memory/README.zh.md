# memory/：持久的跨会话记忆

[English](README.md) | 中文

memory 家族让 agent（智能体）拥有能跨会话留存的事实、偏好与决策：一个覆盖单张扁平持久表的 host-plane 单例服务，以及读写该表的面向模型的工具与 runtime-context 贡献。

| 包 | 职责 | ctx 键 |
|---|---|---|
| `memory/` | host-plane 单例 `MemoryService`：经 `ctx.storageDomain` 存储的个人（`user`）与逐项目（`project:<path>`）条目，由进程内每个会话共享 | `memory` |
| `tool-memory/` | 面向模型的 `memory_remember`／`memory_recall`／`memory_list`／`memory_forget`／`memory_edit` 工具，以及 `tool:memory` runtime-context 贡献 | 无 |

记忆是进程级的，而不是会话级的：在一个会话中记住的事实，同一存储根目录下的任何后续会话都可以读到，具体受作用域限制。`memory/` 拥有持久记录及其召回排序；`tool-memory/` 拥有全部面向模型的界面，包括无需显式召回调用即可作用于已存记忆的 runtime-context 快照。两个包都依赖 `ctx.storageDomain`，只有挂载了 [`dsh-storage-domain`](../storage/storage-domain/README.md) 的组合才会提供它。
