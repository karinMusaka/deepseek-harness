# @deepseek-ai/dsh-cordis-static-packages

[English](README.md) | 中文

启动时加载磁盘上双半包（dual-half package）的 loader，源码以动态包（dynamic package）方言写成。每个已配置条目指名一个目录，其中存放 host 半与／或浏览器半；host 半在与 `cordis_define` 出的包相同的 `node:vm` 沙箱、注册 guard 与 fiber 生命周期下运行，所以一个从 chat 会话晋升出来的包能保留原有行为。以 `ctx.staticCordisPackages` 提供，并带同名的 Remote namespace。浏览器半由 [`@deepseek-ai/dsh-cordis-static-packages-client`](../cordis-static-packages-client/README.md) 装载；共用的求值原语来自 [`@deepseek-ai/dsh-cordis-host-runner`](../cordis-host-runner/README.md)。

## 功能

构造时，本服务校验配置并开始加载每一个已配置的包；`ready` 会在每个包都已启动或被记为失败之后 settle。对每个包：

- 若配置了 `client` 文件，读取其内容作为浏览器半源码，留给 `clientSource` 使用。
- 若配置了 `host` 文件，读取其内容，用 `createSandbox`／`evaluateHostCode`（与 `cordis_define` 相同的原语）求值，一旦得到 Plugin，就用 `startHostHalf` 挂载到所有静态包共用的一个子 group fiber 之下。
- host 半用 `harness.handle` 做的注册填入该包自己的 handler 表，供 `invoke` 路由。

任一步骤上的单包失败都会记在该条目上（`hostState: 'failed'`、`error`），并经 `ctx.logger.error` 记日志；构造函数对此从不抛出，所以一个包坏掉不会连累其他包加载。而重复的 `id`、相对路径的 `sourceDir`，或者一个既没配 `host` 也没配 `client` 的包，会让构造函数本身抛出——这些是配置错误，不是单包运行时失败。

- `list` 按配置顺序返回每个已配置包的一行（id、name、是否有浏览器半、`hostState`，失败时还有 `error`）。与 `clientSource`、`invoke` 一样，它只在启动收敛之后才应答，因此在启动期间重连的页面绝不会把尚未求值的包读成失败。
- `clientSource` 提供某个包的浏览器半源码，或说明为什么没有源码可提供：未知 id、未配置浏览器半、或 host 半失败。
- `invoke` 把一个包浏览器半发起的一次 `host.call`，路由到它 host 半注册的方法，并回答哪一步路由被拒绝：`package-missing`、`host-not-running`、`method-not-found`，或 `handler-error`（带上抛出的消息与堆栈）。

## 存储立场

包表就是进程内存，每次进程启动都从配置重建；这里不向磁盘写任何东西。磁盘上的源文件才是持久状态——编辑 `host`／`client` 后重启即可重新加载，也不存在另一份会与文件失步的注册表。

## 信任立场

配置文件就是运维方的授权：这里不会逐次向人发问，不同于 `cordis_define` 出的包那套 request-run 往返。host 半与已定义的包共用同一套 `node:vm` 沙箱与 guard——隔离全局变量，但不是安全边界，因为它声明的服务仍会触达存活运行时。应当像对待 bash 访问或已定义的动态包一样对待一个已配置的静态包；参见[自引用工具集 Agent Note](../../../.agents/notes/implemented/feature/2026-07-08-self-referential-cordis-toolset.md)。

## 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `vmTimeoutMs` | `5000` | host 半在 vm 中同步执行的那部分被中止求值前可运行的毫秒数 |
| `packages` | `[]` | 启动时加载的包：`{ id, name, sourceDir, host?, client? }`——`id` 匹配 `^[a-z][a-z0-9-]{2,31}$`，`sourceDir` 必须是绝对路径，且 `host`／`client` 至少设置一个 |

## 导出形状

服务包：默认导出 `StaticCordisPackagesService`（服务键 `staticCordisPackages`），`./types` 则承载 `staticCordisPackages` Remote namespace 与其消费方共享的载荷形状。

## 如何把 chat 中定义的包晋升为静态包

1. 用动态包方言（一个以 `harness` 各动词求值的 async 函数体，返回一个 plugin）在仓库之外的某个目录写出 `host.js` 和／或 `client.js`。
2. 在 `$DSH_HOME/cordis.patch.yml` 中添加一行，覆盖 `cordis-static-packages` 那一行的 config（一次 patch 会替换整行的 `config`，所以要重述每一个字段）：

   ```yaml
   - id: cordis-static-packages
     config:
       packages:
         - id: my-package
           name: My Package
           sourceDir: /absolute/path/to/my-package
           host: host.js
           client: client.js
   ```

3. 重启进程；正在运行的进程不会拾取配置改动。

## 模型体验

没有，因为本包不注册任何工具，也不注入任何提示词；一个正在运行的包的 host 半自己可能会注册工具，那是它自身注册的后果，不属于本 loader。

#### KV Cache 影响

注册工具的 host 半会改变下一次请求的工具视图，从第一个变化的 schema token 起使前缀复用失效；没有任何 host 半注册工具的一次启动对前缀不产生影响，而且启动之后这里再也不会改变工具视图——包只加载一次，不重启进程就永远不会重新加载。

## 已知限制与暂缓事项

- **源文件没有热重载。** `host`／`client` 文件的编辑只在下一次进程重启后才生效；进程运行期间没有监视、重新求值或重新提供源码的路径。
- **动态包面板里没有对应的一行。** 一个静态包的 host 半与 runner 共用同一套沙箱与 guard，但操作 `cordis_define` 出的包的那个面板既不列出也不控制静态包。
- **一个启动失败的包只能通过 `list()` 或日志看到。** 没有对启动期失败的主动推送；消费方必须调用 `list()` 或读进程日志。
- **id 与 runner 的模块 id 空间共用。** 一个静态包的 `id` 会变成浏览器模块 id，与 `cordis_define` 出的包一样；因此静态 id 与 chat 会话中定义的 id 不能撞名。
