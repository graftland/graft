---
title: 配置文件
description: 用 graft.yml 描述应用，并在运行期间修改配置。
---

`graft start` 读取 YAML 文件，默认是
`graft.yml`。文件内容是一个配置项列表，每项加载一个插件：

```yaml title="graft.yml"
- id: database
  name: "@acme/graft-plugin-postgres"
  config:
    url: !env DATABASE_URL

- id: api
  name: ./plugins/api.mjs
  config:
    port: 8080

- id: tenants
  name: tenants
  group: true
  isolate:
    app/Database: true
  config:
    - id: tenant-db
      name: "@acme/graft-plugin-postgres"
      config:
        url: !env TENANT_DATABASE_URL
```

Loader/Include 要求整棵条目树的 ID 唯一，包括禁用项。直接嵌入的 `Group.Group`
则只要求同层兄弟项 ID 唯一；增加外层分组不会改变这一规则。

## 配置项字段

| 字段        | 作用                                                                            |
| ----------- | ------------------------------------------------------------------------------- |
| `id`        | 标识配置项。如果未指定，Graft 会生成一个并写回文件。                            |
| `name`      | 插件模块，可以是相对路径、包名或短名称。分组会忽略此字段。                      |
| `config`    | 插件的输入；对于分组，则是其配置项列表。                                        |
| `disabled`  | 设为 `true` 时卸载该项，但保留在文件中。                                        |
| `group`     | 设为 `true` 时，该项成为包含其他配置项的分组。                                  |
| `inject`    | 加载插件前需要等待的服务键，作为插件自身 `inject` 声明的补充。                  |
| `isolate`   | 需要[隔离](../isolation/)的键。`true` 表示私有领域（realm），标签表示共享领域。 |
| `intercept` | 经过 Schema 校验的已登记 Reference 配置补丁，对该项及其后代生效。               |

所有层级的配置项都遵循相同的解码规则。`note`
等额外字段作为元数据保留，API 编辑时也是如此，它们不会绕过对已声明字段的校验；已声明字段仍须通过类型校验。分组省略
`config` 时，按空分组（`config: []`）处理；分组的 `config` 不能显式设为 `null`。

加载器拥有已接纳目标的冻结快照。API 编辑在尝试入队前复制数组和普通对象（包括元数据），初始数据和刷新得到的目标也会建立快照。之后修改传入对象不会改变运行或持久化目标；需要提交新编辑才能应用新值。`loader.entries`
和 `loader.changes` 暴露的数据是冻结的。

嵌入 loader 时，`Env`、其他 Data 类、`Date`
等类实例和其他不透明值保留原引用；加载器不会复制或冻结其内部数据，调用者须将它们作为不可变配置使用。数组和普通对象中的共享引用与环在快照中保留；环仍在既有的条目或配置树边界以类型化错误拒绝。

环境变量解析会保留数组和普通对象的共享引用，不会把共享图展开成树。身份缓存仅属于单次执行，后续激活或更新仍会重新读取环境变量。快照复制、环检测和配置比较也考虑共享图；比较时每对普通容器只访问一次。不透明值继续使用 Effect 的相等性，包括其自定义比较实现。

重新写入未变化的匿名配置树时，已分配的 ID 和运行中的插件实例保持不变。加载器先恢复子项 ID，再匹配匿名父分组，完成匹配后才将 ID 写回 YAML。如果需要跨配置变化保持身份，或需要区分重新排列的相同条目，请显式指定 ID。

服务键和 Reference 键是创建它们时使用的字符串。例如，`Context.Service<...>()("app/Database")`
对应的服务键是 `app/Database`。

配置文件只能修改[显式登记的 Reference](../isolation/#配置文件中的-intercept)。每项登记包含 Reference 对象、配置补丁的 Schema，以及类型化的合并函数。加载器先解码补丁，再与外层值合并；没有外层覆盖值时，会读取 Reference 的默认值。是否合并对象字段由登记时的合并函数决定，不再自动合并任意对象。

未登记的键让该项以 `UnregisteredReference` 失败；输入类型无效时以
`InvalidIntercept` 失败，并在 cause 中保留 Schema 错误，不执行插件的
`apply`。嵌入 loader 时，登记表默认为空，需要宿主应用在启动时提供。`graft start`
默认提供以下两项登记：

| Reference 键                              | 配置值                                                              | 行为                                       |
| ----------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------ |
| `effect/References/CurrentLogAnnotations` | 对象                                                                | 与外层日志注解浅合并，同名键以配置值为准。 |
| `effect/References/MinimumLogLevel`       | `All`、`Fatal`、`Error`、`Warn`、`Info`、`Debug`、`Trace` 或 `None` | 替换外层最低日志级别，区分大小写。         |

```yaml title="graft.yml"
- id: api
  name: ./plugins/api.mjs
  intercept:
    effect/References/CurrentLogAnnotations:
      component: api
    effect/References/MinimumLogLevel: Warn
```

该项及其子插件继承日志注解和级别，兄弟配置项保持各自的设置。此例会过滤
`Info`、`Debug` 和 `Trace` 日志。`All` 允许所有级别，`None`
关闭所有日志。其他 Reference 需要由自定义宿主显式登记。

## 插件名称

以 `.` 开头的 `name` 是相对于配置文件的路径，以 `/` 开头的是绝对路径。以 `@`
开头或包含 `:`
的名称直接使用。其他名称会依次尝试原名称、`@graftland/plugin-<name>` 和
`graft-plugin-<name>`。包从应用目录解析。

如果找不到插件或模块导入失败，该配置项仍会出现在 fork 树中，显示为带错误的失败 fork。当配置项变化，或[热重载](../hot-reload/)检测到新代码时，会再次尝试加载。

每个启用的配置项都会先创建生命周期 fork，再开始模块解析。尚未完成的导入计为
`Loading`，因此 `ready`
会继续等待，但健康兄弟项和后续编辑仍能推进。删除、禁用或替换该项会取消其生命周期并释放解析器资源。解析期间修改配置会启动新一轮解析；未变化的配置项保留当前解析过程。已取消导入的迟到结果不会重新激活旧条目；原生 import
Promise 本身仍可能继续执行模块代码。

解析成功后，生命周期 fork 将实际插件作为子 fork 加载。`ready`
检查整棵子树，生命周期已 Active 不会掩盖仍在加载的插件。等待服务注入的 Pending
fork 和 Failed fork 仍视为已稳定。

Effect
importer 的每个模块候选都有独立的子 scope。候选失败后，先释放其资源，再决定是否尝试下一个名称。清理失败会阻止回退，并与导入失败的 cause 一并保留；成功候选的资源则由条目生命周期持续持有。

## 环境变量

`!env NAME`
在加载配置项时读取环境变量。文件中保留原始标签，因此密钥不会被写入文件。如果变量未设置，该项会失败，直到问题修复。

`!env`
得到的是字符串，最终变成什么由插件的配置 Schema 决定：`Schema.NumberFromString`
会把它转成数字，`Schema.RedactedFromValue(Schema.String)`
会把密钥包装起来，记录日志时不显示原文。读取哪个变量由编写配置文件的人决定，插件只描述自己需要的值。

`graft start --env-file .env` 还会从 `.env`
文件读取变量。进程环境变量优先，详见[命令行](../cli/#graft-start)。

`loader.retry` 会重新读取 `!env`
的值。运行中的条目若解析后的 config 变了，会通过 `update`
收到新值；解析后的 intercept 变了则重新加载该条目；值没有变化的条目保持运行。仍在导入模块的条目会在导入完成后才读取环境变量；重试时若条目仍在加载，会在其激活后再读取一次。`ready`
也会等待这次读取，所以 `retry` 之后再等
`ready`，所有运行中的条目都已用上当前的值。

插件如果想用 Effect `Config` 的组合子（例如默认值和备选来源），可以在 `apply`
里用它们读取自己的输入：

```ts
const Settings = Config.all({
	port: Config.Port("port").pipe(Config.withDefault(8080)),
})

export default Plugin.make({
	name: "server",
	config: Schema.Record(Schema.String, Schema.Unknown),
	apply: (input) =>
		Effect.gen(function* () {
			const settings = yield* Settings.parse(ConfigProvider.fromUnknown(input))
			// ...
		}),
})
```

插件的 Schema 仍然描述条目接受什么。插件自行从环境中的 provider 读取的 `Config`
不是 `!env` 标签，`retry` 不知道它们，也不会重新加载。

普通插件的 `config` 和 `intercept`
值均支持该标签，包括嵌套数组和对象。条目先解析自身 intercept 的环境变量，再由已登记的 Schema 解码并合并；解析后的值仍须通过 Schema 校验。分组只解析自身的 intercept，不提前解析后代描述。已持久化目标和文件均保留原始标签。

分组保留子项描述，不提前解析后代的环境变量。禁用项不解析变量；启用子项缺少变量时，只让该子项失败，不阻止整个分组或兄弟项启动。

数组和普通对象可以共享配置值，但不能成环。循环 config 或 intercept 会让该项以
`CyclicConfig`
失败，兄弟项和后续编辑仍可继续。环境变量解析将其他类实例视为不透明值。条目/分组结构本身成环时，会在分配 ID 和加载前以
`InvalidOperation` 拒绝。

## 编辑器支持

每个 Graft 版本都附带这个文件的 JSON
Schema，版本号与该版本相同。在文件第一行用注释把 YAML language server 指向它，VS
Code（装有 YAML 扩展）等编辑器就能补全和检查配置项字段：

```yaml title="graft.yml"
# yaml-language-server: $schema=https://cdn.jsdelivr.net/npm/@graftland/cli@1.2.3/schema.json
- id: api
  name: ./plugins/api.mjs
```

把 `1.2.3` 换成项目中 `@graftland/cli`
的版本，升级 Graft 时一并更新。`graft create`
会用自己的版本写入这一行。包里也带有这个 schema，路径为
`@graftland/cli/schema.json`。

Schema 检查配置项字段，以及 `graft start` 注册的 intercept。插件的 `config`
不在检查范围内：只有插件自己的 Schema 知道它的结构。为了让 language server 不把
`!env` 标为错误，需要在编辑器设置中声明这个标签，以 VS Code 为例：

```json title=".vscode/settings.json"
{ "yaml.customTags": ["!env scalar"] }
```

## 在运行期间修改配置

使用 `graft start --watch`
时，Graft 会监听配置文件。保存后，Graft 会比较新的配置项与当前正在运行的配置项：

- `config` 变化的配置项通过
  [`update`](../lifecycle/#fork-句柄)接收新输入，插件会原地更新或重启。
- `name`、`group`、`inject`、`isolate` 或 `intercept`
  变化的配置项会被卸载，再重新加载。
- 新增的配置项会被加载，移除或禁用的配置项会被卸载。
- 没有变化的配置项继续运行。

删除、禁用或替换条目时若清理失败，Graft 会记录完整 cause 及条目、fork 标识，并继续协调。被移除的 fork 已处置，替换项拥有独立的生命周期。仍保留的 fork 重启失败时，失败会以
`Failed` 状态保持可见，可以重试。`ready`
将失败 fork 视为已稳定，不保证清理成功。

这也包括 resolver 观察资源的清理：它与生命周期清理的失败一并记录，不重启健康兄弟。延迟环境刷新和普通编辑使用 group 的同一个串行协调执行器，不会为了应用更新的目标而中断 update 回调。已移除或过时代次的刷新请求会被丢弃；`ready`
会等待尚未完成的刷新。

如果文件内容无效，Graft 会记录错误，并继续运行上一次有效的配置。watch 模式下，即使初始文件无效，也会记录 cause 并以空条目继续监听；修正文件后自动加载。API 编辑不会将无效文件覆盖为空配置。非 watch 模式下，初始配置无效会导致启动失败。

嵌入 Include 并提供 `initial`
时，只有 YAML 准备、ID 分配、全树校验及序列化验证全部成功后，才会创建缺失的文件，并一次提交包含所有 ID 的完整文档。无效初始条目不会留下文件；已有文件优先于
`initial`。

## 通过代码编辑配置项

加载器发布了 `Loader` 服务，插件可以注入它来读取和编辑配置项：

```ts
import { Loader } from "@graftland/loader"

const admin = Plugin.make({
	name: "admin",
	inject: [Loader.Loader],
	apply: () =>
		Effect.gen(function* () {
			const loader = yield* Loader.Loader
			const id = yield* loader.create({ name: "./plugins/cron.mjs" })
			yield* loader.update(id, { config: { every: "5 minutes" } })
			yield* loader.update("api", { disabled: true })
		}),
})
```

| 成员                      | 作用                                                                            |
| ------------------------- | ------------------------------------------------------------------------------- |
| `entries`                 | 最新的已持久化目标配置项。                                                      |
| `changes`                 | 当前已持久化目标及后续接纳的目标，不代表运行树已协调完成。                      |
| `create(entry, options?)` | 将配置项添加到根列表末尾，或添加到 `parent` 分组的 `position` 位置，返回其 id。 |
| `update(id, patch)`       | 修改配置项的部分字段。                                                          |
| `remove(id)`              | 移除配置项。                                                                    |
| `ready`                   | 等待当前目标已协调到运行树，且树内没有 Loading fork。                           |
| `retry`                   | 重新发布当前目标，重试所有失败条目，并重新读取 `!env` 的值。                    |

编辑结果会写回文件。Graft 会保留文件中的注释、格式和 `!env`
标签，并先写入临时文件，避免配置文件只写了一半。

临时文件在同目录以 `0600`
权限独占创建。Graft 保留目标文件的权限位及可获取的 uid/gid，执行文件 fsync、关闭句柄，再 rename 替换。新文件默认为
`0600`。失败或中断会删除临时文件，清理失败的 cause 与原始 cause 一并保留。不复制扩展 ACL 或扩展属性，也不对目录执行 fsync，因此不承诺掉电时 rename 的持久性。

编辑修改或删除 YAML
anchor 前，受影响的 alias 会物化成保留原值的独立副本；无关 alias 保持不变。通过 alias 编辑分组内的子项时，也会先创建本地副本，不修改源集合。写盘前会重新解码最终文档，确认它与目标配置一致。解析或序列化失败时，通过
`StoreError` 保留原始 cause，文件不变。

entry/group 结构边界上的 alias 会在收集和分配 ID 前物化，因此 aliased
group 中的匿名子项也会获得独立 ID。源模板及普通插件配置中无关的 alias 保持不变。自动 ID 分配会先计算独立的逻辑目标，再进行 YAML 改写。插入 ID 前，受影响的 alias 会物化并保留原值，普通插件配置不会因引用源条目而混入生成的 ID。写盘前会重新解析序列化结果，确认它与计划目标一致；不一致时返回
`StoreError`，文件保持不变。

编辑成功进入加载器的有界工作队列时才算被接纳。接纳前取消调用者，编辑不生效；接纳后取消只会停止等待，加载器 scope 中的 worker 会继续完成持久化和目标发布。调用者通过 Deferred 接收此次操作的结果；即使调用者已经离开，失败仍会记录完整 cause。关闭加载器会停止 worker、结清等待中的调用，并以
`LoaderClosed` 拒绝新编辑。

独立的 scoped
fiber 负责协调运行树，可以跳过中间目标版本。编辑返回表示目标已持久化并发布，不表示插件已经更新完成。需要等待当前目标及其加载过程时，在生命周期回调之外调用
`ready`。回调可以提交编辑，但不能等待 `ready`，否则会等待自身完成。`retry`
重新发布相同目标时，`changes` 也会发出一次通知。 `retry`
会穿过生命周期、注入和分组包装层，对启动失败的实际插件 fork 调用
`restart`；健康实例及尚未完成的解析保持不变。普通目标协调也会重试失败条目。
`retry` 在请求发布后就返回；需要等待协调时，在生命周期回调之外继续调用 `ready`。

如果文件在 Graft 上次读取后被其他人修改，Graft 会先重新读取文件，再应用编辑。如果编辑涉及的字段也在文件中被修改，则以文件为准：Graft 会放弃这次编辑并记录警告。

临时文件准备完成后，Graft 会在 rename 前重新核对目标文件内容。如果已变化，会删除本次临时文件、读取新版本并重新应用编辑。同字段冲突仍以本次编辑最初的快照为基准，因此准备期间的修改也会被检测到。最多尝试三次；持续发生竞争时返回
`StoreError`，不提交这次 API 编辑。清理失败会停止重试并保留完整 cause。初始文件创建和自动分配 ID 后的写回也使用同样的版本检查。

**并发保存限制：**
内容核对与 rename 是两个独立的文件系统操作。外部编辑器仍可能在两者之间保存，这次保存仍可能被覆盖。原子替换保证文件不会只写一半，但无法与任意编辑器形成事务。如果不能接受这个剩余风险，请避免同时保存文件和通过 API 写入。

`ready` 将 `Pending` 和 `Failed`
视为已稳定。服务提供方启动后，依赖它的插件仍可能短暂处于 `Pending`
状态；就绪不保证所有插件都已激活。

## 符号链接

Include 会保留符号链接。每次磁盘操作先解析配置路径的真实目标，并将该路径与内容快照一起保存。读取、冲突检查、自动补 ID 和 API 编辑都使用同一目标，临时文件也建在目标目录。rename 前会再次解析入口；若指向已变，就删除临时文件，沿用已有的有界重试与同字段冲突规则，在新目标上重新应用编辑。

watch 模式同时监听入口目录和当前目标目录。入口链接改变后会重新读取，并关闭旧目标监听、切换到新目标目录；新监听就绪后再请求一次读取。新目标 YAML 无效时保留上一次有效的运行树，修正该文件后可恢复。未开启 watch 时，下次 API 编辑会读取新目标。位于这两个监听目录之外的中间链接，其变化会在下次读取时生效，但自身不一定触发通知。

普通文件不存在时可以初始化。断链、循环链接或不可访问的链接会返回类型化文件系统错误，不会被替换成普通文件；请先创建或修复目标，再重试。API 编辑或入口变化通知都会重新尝试解析路径。

路径核对与 rename 是两个独立操作。链接若在最终核对之后改变，进行中的编辑仍可能提交到旧目标；下次读取则跟随新目标。这与内容核对后的并发保存窗口相同，不构成跨文件事务。
