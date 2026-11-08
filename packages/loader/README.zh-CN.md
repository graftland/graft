# @graftland/loader

[English](https://github.com/graftland/graft/blob/main/packages/loader/README.md)
| 简体中文 |
[繁體中文](https://github.com/graftland/graft/blob/main/packages/loader/README.zh-TW.md)

从条目列表或 YAML 配置文件加载插件。

支持的最低 Node.js 版本是 22.19。

```sh
npm install @graftland/loader effect
```

- `Include` 把条目保存在 YAML 文件中，并把编辑写回该文件。
- `Loader` 在运行时编辑条目。
- `ModuleResolver` 把条目名称转换为插件。

从条目加载的插件可从 `@graftland/loader` 导入 `Entry`，读取
`yield* Entry.CurrentId`。它是
`Context.Reference<Option<string>>`，值为当前条目的 id，嵌套 group 中也一样；不经过条目加载时默认为
`None`。插件内部 fork 的子插件会继承它，不会为每个 fork 生成新 id。Include 会把生成的 id 保存到 YAML，供宿主重启后继续使用。

## 自定义存储

自定义存储需要实现 `Loader.Store`：

- `initial` 提供起始条目。
- `apply(op)` 保存一次 API 编辑。
- `external: Stream<void>` 表示某些内容可能已经变化。
- `refresh` 读取最新状态。

`refresh` 在快照有变化时返回 `Option.some(entries)`，没有变化时返回
`Option.none()`。通知流不得读取或修改存储的快照。

Loader 在同一把锁下运行 `apply` 和
`refresh`，并在释放锁之前发布它们保存的目标。所以存储不需要额外的锁。

对存储实现的规则：

- 只有在操作成功之后，才提交新的快照。
- 让可变的解析器对象保持在该操作内部。

Loader 如何处理失败：

- 失败的 refresh 会连同完整的 cause 一起记录日志。Loader 保留上一次成功的目标，并继续处理之后的通知。
- 调用 `apply` 和访问 `refresh`
  都被延迟到受保护的操作内部执行。同步抛出的错误会被报告为 defect，不会让回复悬空，也不会停止之后的编辑。
- 访问 `external`
  被延迟到它的流失败边界内部。出现 defect 时，通知会停止并记录日志，API 编辑仍然可用。
- 模块候选项的回退，要求恰好有一个失败，并且该失败表明候选项不存在。如果同时出现清理失败、defect 或中断，就不会回退，并保留完整的 Cause。
- Resolver 和 intercept 回调在条目激活内部运行。意外的同步抛出会使该条目失败，并保留原始 cause。

## API 编辑

API 编辑使用有界队列。队列由 loader 的 scope 持有。

- 成功进入队列就是准入。
- 在准入之前取消，没有任何效果。
- 在准入之后取消，只是停止等待结果。

Worker 在同一把锁下完成保存和目标发布，并通过 `Deferred` 交付它的
`Exit`。失败也会连同完整的 cause 一起记录日志，即使调用方已经不再等待。

关闭 loader 会做三件事：

- 停止 worker。
- 结束所有待处理的调用方。
- 用 `LoaderClosed` 拒绝新的编辑。

## 对账

一个独立的、带 scope 的 fiber 把最新的目标与正在运行的树对账。它可能跳过中间的目标，但绝不会为了应用更新的目标而中断正在运行的 update 回调。

每个 group 由一个归 scope 所有的协调执行器处理更新。延迟环境刷新 fiber 只提交请求，不直接调用
`Fork.update`。请求携带条目实例身份与协调代次；已移除、已替换或已被新代次取代的请求会被丢弃。`ready`
也会等待排队和执行中的环境刷新。

`entries` 和 `changes`
描述的是已保存的目标，而不是已完成的运行时更新。编辑在保存和发布之后返回。

普通 API 编辑和文件变更只对变化的条目做差量对账；未变的健康兄弟和子树保留当前环境值。编辑单个叶子不再隐式刷新全树。参与对账的组仍会重试失败条目，并保留未完成的解析。需要全树重新读取环境时，显式调用
`loader.root.update(entries)`；刷新会穿过嵌套组和注入包装器。

独立兄弟的更新和移除清理并发执行；同一条目的操作仍串行，替代实例须等待旧实例清理结束，组也会等待本轮必要工作全部完成。Include 合并入口和物理目标的通知，在连续 100ms 没有新通知后刷新；监听安装后的补读和符号链接目标切换仍保留。

`ready` 会一直等到当前目标版本已经对账完毕，并且没有 fork 处于
`Loading`。`Pending` 和 `Failed`
都算作已稳定。生命周期回调可以提交编辑，但不得等待
`ready`，因为那样会等待它们自己。

## 条目生命周期

每个启用的条目会立即得到一个生命周期 fork。模块解析和配置准备在该 fork 的激活中运行。所以缓慢的 import 会停留在
`Loading`，不会阻塞它的同级条目，也不会阻塞之后的目标对账。

移除、禁用或替换条目，会关闭该生命周期及其 resolver 资源。它的加载状态随后不再计入
`ready`。

- 解析期间的配置变化会取消当前尝试，并用最新的输入开始新的尝试。
- 无关的编辑不会影响未变化的解析，它会继续运行。

移除、禁用或替换期间的清理失败，会连同完整的 cause 以及条目和 fork 的标识符一起记录日志。对账会用目标的其余部分继续进行。

条目处置会收集生命周期和 resolver observation scope 两阶段的清理结果，统一报告为
`CleanupError`。两阶段同时失败时保留双方完整 Cause，不重启健康兄弟。调用方中断仍作为中断传播，不转换成条目清理错误。

- 被移除的 fork 会被释放，不会作为失败的条目留在树中。
- 替换项会得到自己的生命周期。
- 如果 core 在保留的 fork 上报告重启失败，该 fork 会保持明显的失败状态，直到它的配置或依赖发生变化。
- `ready` 表示已稳定，不表示清理成功。

解析成功之后，生命周期把实际的插件作为子 fork 持有。如果请求了注入等待，它还会持有一个等待注入的 fork。所以 fork 树包含这一层生命周期。

`ready` 会检查每一个后代，包括在其生命周期变为 `Active` 之后仍在加载的插件。

结果的发布由 core 的激活 scope 和 supervisor
generation 负责。所以被取消的 import 之后不能在已移除或已替换的条目下创建插件。原生 import 的 promise 可能会继续运行模块代码，但它们迟到的结果不会被激活。

## 树的校验与元数据

`Tree.validate`
先检查条目树的结构是否有环，然后解码整棵树。文件读取、编辑、写回校验，以及 Loader 接受的目标，都使用同一个边界。

- 未知的条目字段（例如 `note`）会在每一层都作为元数据保留。
- 已声明的字段仍然要通过 Schema 校验。
- `Entry.Entry` 把这些额外字段包含进来，类型为 `unknown`。
- `create` 和 `update` 接受元数据，并保持已知字段的类型。
- 没有 `config` 的 group 会被规范化为 `config: []`。
- 显式的 `null` 无效。
- 自定义存储必须在保存目标之前校验目标。

## 快照

Loader 拥有它自己的配置快照。

- 编辑 effect 运行时，它的数据会在被放入队列之前复制。调用方之后的修改不会改变这个已排队的编辑。
- 初始数据会被捕获，存储的 `apply` 或 `refresh` 返回的目标也会被捕获。
- 数组和普通 record（包括元数据）会被复制并递归冻结。共享引用和环会被保留。
- `entries` 和 `changes` 暴露这些已冻结的快照。不要修改它们。
- 调用方的原始对象保持未冻结。如果再次提交它们，Loader 会捕获它们的新值。
- Loader 已经拥有的快照可以直接共享，不需要再做一次深拷贝。

类实例（包括 `Env`
和其他 Data 类）以及其他不透明的值会保留它们的引用，不会被冻结或克隆。把它们作为配置提供时，请把它们当作不可变的。不透明值内部的修改不在快照的保证范围内。

普通 record 上自有的访问器属性，会在创建快照时按值捕获。

## Group ID

公开的 `Group.Group`
入口会在初次加载之前以及每次更新时检查同级 ID，包括被禁用的条目。

- 重复的同级条目会以 `SchemaError` 使 schema 解码失败，而不会合并成一个子条目。
- 这个检查仅限于每个 group 内部。一个有问题的嵌套 group 可能失败，而健康的同级条目照常运行。
- Loader 和 Include 还要求 ID 在整棵树中唯一。

## 环境变量

Group 保留子条目的描述，但不解析它们的环境变量。只有活动的普通条目才会解析自己的
`!env`
值。所以缺失的变量只会使该条目失败，而不会阻止它的同级条目加载。被禁用的条目不解析变量。

配置数组和普通 record 可以共享值，但不得包含环。

- 带环的 config 或 intercept 会使其条目以 `Entry.CyclicConfig`
  失败。它不会阻塞同级条目或之后的对账。
- 其他类实例在环境解析期间是不透明的值。
- 条目和 group 拓扑中的环会以 `InvalidOperation`
  被拒绝。这发生在分配 ID 或遍历树之前。
- 每次执行，环境解析都使用全新的标识缓存。共享的容器只解析一次，并保持共享。之后的执行会重新读取环境值。
- 快照复制和环检查也会跟踪对象标识。
- 配置比较对每一对普通容器只访问一次，不会对图做结构化哈希。共享拓扑不影响值的相等性。
- 不透明的值保留 Effect 的相等性，包括自定义的相等性实现。

## 文件写入

文件写入按以下步骤进行：

1. 在同一目录中以独占方式创建临时文件，模式为 `0600`。
2. 保留目标的权限位以及可用的 uid/gid。
3. 对文件执行 fsync 并关闭。
4. 将它重命名到位。

新文件默认为 `0600`。

- 失败或中断会清理临时文件。清理失败会与原始 Cause 合并。
- 这会保留 POSIX 权限，不会保留扩展 ACL 或扩展属性。
- 不会对所在目录执行 fsync。所以这不能保证重命名在断电后依然持久。

在重命名之前，写入器会再次读取目标文件，并检查其内容是否仍与编辑所用的版本一致。

- 如果文件变了，写入器会丢弃临时文件，并在新内容上重新应用这次编辑。最多尝试三次。
- 如果文件还修改了 API 编辑所涉及的字段，则以文件为准，编辑会被丢弃并给出警告。
- 持续的争用会返回 `StoreError`。
- 清理失败会保留其 cause，并停止重试。
- 初次创建和自动写入 ID，使用同样的版本检查。

这是乐观并发。编辑器仍可能在最后一次检查与重命名之间保存，而这次保存可能被覆盖。如果无法接受丢失重叠的保存，请避免同时进行 API 编辑和编辑器保存。

## YAML 别名与 ID

YAML 编辑会保留别名原有的值。

- 在编辑修改或移除锚点之前，受影响的别名会变成独立的副本。
- 通过带别名的 group 编辑子条目，同样会创建本地副本。源集合保持不变。
- 未受影响的别名保持完整。
- 最终的文档在写入之前会被解码，并与目标核对。
- YAML 解析和序列化失败会返回 `StoreError`，并保留原始 cause。

条目和 group 结构边界上的别名，会在收集、分配和校验 ID 之前被实体化。所以带别名的 group 中的匿名子条目会得到互不相同的 ID，而源模板不会被修改。普通插件配置内部无关的别名保持不变。

匿名标识自底向上匹配。子条目先恢复自己的 ID，然后才比较其父条目的配置。所以重写同一棵匿名树，会保留它正在运行的实例。

- ID 的分配只有在匹配完成之后才写入 YAML。
- 计划中包含一个独立的逻辑目标。
- 在插入 ID 之前，指向已变化条目或其祖先的别名，会以原始值实体化。所以普通配置的别名永远不会仅仅因为其源条目需要 ID 而得到 ID。
- 序列化后的文档在提交之前会被解析，并与计划的目标核对。不一致时返回
  `StoreError`，文件保持不变。
- 显式 ID 是在配置变化时保持标识的办法，也适用于原本相同的条目被含糊地重新排列的情况。

## Intercept

配置文件中的 intercept 需要显式注册。在加载条目之前，请在构建 `Graft.layer`
所用的环境中提供一个 `Intercept.layer`：

```ts
import { Context, Layer, Schema } from "effect"

import { Graft } from "@graftland/graft"
import { Intercept, ModuleResolver } from "@graftland/loader"

const Settings = Context.Reference("app/Settings", {
	defaultValue: () => ({ color: "blue", size: 12 }),
})

const references = Intercept.layer([
	Intercept.make(
		Settings,
		Schema.Struct({
			color: Schema.optionalKey(Schema.String),
			size: Schema.optionalKey(Schema.Finite),
		}),
		(outer, patch) => ({ ...outer, ...patch }),
	),
])

const environment = Layer.merge(references, ModuleResolver.fromRecord({}))
const runtime = Layer.provideMerge(Graft.layer, environment)
```

注册表默认为空。Group 会解析该条目 intercept 中的 `Env`
值。然后每个注册项做三件事：

1. 解码 patch。
2. 读取实际的 reference，包括它的默认值或继承而来的值。
3. 调用它带类型的合并函数。

不会自动合并对象。要替换标量值，请使用完整值的 schema 和
`(_, value) => value`。Schema 解码时不得需要服务。

Intercept 的错误：

- 未知的 key 会使该条目以 `UnregisteredReference` 失败。
- 无效的输入会使它以 `InvalidIntercept` 失败，schema 错误作为其 cause 保留。

请在应用启动时注册 reference。不要从由该 loader 管理的插件中发布注册表。

内置的 CLI 注册了两个 reference：

- `References.CurrentLogAnnotations` 合并注解字段。
- `References.MinimumLogLevel` 在校验之后替换级别。

其他 reference 需要在自定义的宿主环境中注册。

普通插件配置和 intercept 值中的环境变量，会在该条目的激活内部解析，包括嵌套的 intercept 数组和 record。注册的 schema 仍会在合并之前校验解析后的值。

- 缺失的变量会使条目以 `ConfigError` 失败。它保存的目标保留原始的 `Env` 值。
- Group 解析它们自己的 intercept，每个后代自行准备。
- 被禁用的条目不读取任何变量。

## 监视配置文件

使用 `Include` 的 `watch`
选项时，无效的初始文档会连同其 cause 一起记录日志。空的 loader 和配置监视器仍然可用。保存一个有效的文档，会在不重启的情况下加载其中的条目。

API 编辑必须先读取并校验文件，所以它们不会覆盖无效的文档。

没有 `watch` 时，无效的初始文档会使 `Include` 初始化失败。

## 模块解析器

`ModuleResolver.make` 接受 Promise importer，或需要 `Scope` 的 Effect
importer。`resolve`
在条目生命周期的激活 scope 中运行。移除条目会关闭该 scope，并卸载它的插件子节点。

`resolve(name, { observationScope })`
可以指定独立的观察 scope；resolver 将它作为第二个参数传给 importer。Group 按配置项持有观察 scope，并用
`ScopedRef`
在重试时替换代次。失败候选的资源仍立即清理。省略选项时，观察归调用方 scope 所有。

- 解析成功之后，普通的配置更新、待处理的注入和失败的插件激活，都会保留 resolver 租约。
- 重启生命周期会先释放旧租约，再获取新的租约。这包括解析期间的配置变化，以及从准备失败中恢复。

## 符号链接

Include 会保留符号链接。每次磁盘操作先解析配置路径的真实目标，并将该路径与内容快照一起保存。读取、冲突检查、自动补 ID 和 API 编辑都使用同一目标，临时文件也建在目标目录。rename 前会再次解析入口；若指向已变，就删除临时文件，沿用已有的有界重试与同字段冲突规则，在新目标上重新应用编辑。

watch 模式同时监听入口目录和当前目标目录。入口链接改变后会重新读取，并关闭旧目标监听、切换到新目标目录；新监听就绪后再请求一次读取。新目标 YAML 无效时保留上一次有效的运行树，修正该文件后可恢复。未开启 watch 时，下次 API 编辑会读取新目标。位于这两个监听目录之外的中间链接，其变化会在下次读取时生效，但自身不一定触发通知。

普通文件不存在时可以初始化。断链、循环链接或不可访问的链接会返回类型化文件系统错误，不会被替换成普通文件；请先创建或修复目标，再重试。API 编辑或入口变化通知都会重新尝试解析路径。

路径核对与 rename 是两个独立操作。链接若在最终核对之后改变，进行中的编辑仍可能提交到旧目标；下次读取则跟随新目标。这与内容核对后的并发保存窗口相同，不构成跨文件事务。

## 文档

- [配置文件](https://graftland.github.io/graft/zh-cn/config-file/)
- [在你的程序中使用 Graft](https://graftland.github.io/graft/zh-cn/embedding/)

属于 [Graft](https://github.com/graftland/graft)。基于
[Apache 2.0](https://github.com/graftland/graft/blob/main/LICENSE) 许可。

`ModuleResolver.make` 的可选 `resolution`
协议缓存解析计划，不缓存 importer 结果。`revision`
在安装、移除或解析环境变化后必须更新；`exists` 只检查候选是否存在；`observe`
在每次解析（包括缓存命中）中取得观察租约。未提供该协议时，每次仍按原名称优先执行 importer。详见
[Resolution plans](./README.md#resolution-plans)。
