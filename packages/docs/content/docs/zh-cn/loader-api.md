---
title: Loader API
description: 从插件和代码中读取、编辑配置项，以及每种编辑提供的保证。
---

加载器发布了 `Loader`
服务，插件可以注入它来读取和编辑[配置文件](../config-file/)中的配置项：

```ts import.meta.vitest name="loader-api: edit entries from a plugin"
import { Deferred, Effect, Layer } from "effect"

import { Graft, Plugin } from "@graftland/graft"
import { Entry, Loader, ModuleResolver } from "@graftland/loader"

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

const cron = Plugin.make({ name: "cron", apply: () => Effect.void })
const api = Plugin.make({ name: "api", apply: () => Effect.void })
const resolver = ModuleResolver.fromRecord({ "./plugins/cron.mjs": cron, api })

const entries = await Effect.runPromise(
	Effect.gen(function* () {
		const loaderFork = yield* Graft.plugin(Loader.plugin, [
			{ id: "api", name: "api" },
		])
		yield* loaderFork.await
		const fork = yield* Graft.plugin(admin)
		yield* fork.await
		const read = yield* Deferred.make<ReadonlyArray<Entry.Entry>>()
		const probe = Plugin.make({
			name: "probe",
			inject: [Loader.Loader],
			apply: () =>
				Loader.Loader.pipe(
					Effect.flatMap((loader) => Deferred.into(loader.entries, read)),
					Effect.asVoid,
				),
		})
		yield* Graft.plugin(probe)
		return yield* Deferred.await(read)
	}).pipe(
		Effect.scoped,
		Effect.provide(Layer.provideMerge(Graft.layer, resolver)),
	),
)

entries[0]?.disabled // => true
entries[1]?.config // => { every: "5 minutes" }
```

## 通过代码编辑配置项

| 成员                      | 作用                                                                            |
| ------------------------- | ------------------------------------------------------------------------------- |
| `entries`                 | 最新的已持久化目标配置项。                                                      |
| `changes`                 | 当前已持久化目标及后续接纳的目标，不代表运行树已协调完成。                      |
| `create(entry, options?)` | 将配置项添加到根列表末尾，或添加到 `parent` 分组的 `position` 位置，返回其 id。 |
| `update(id, patch)`       | 修改配置项的部分字段。                                                          |
| `remove(id)`              | 移除配置项。                                                                    |
| `ready`                   | 等待当前目标已协调到运行树，且树内没有 Loading fork。                           |
| `retry`                   | 重试所有失败项，并刷新整棵树的 `!env` 值。                                      |

编辑结果会写回文件。Graft 会保留文件中的注释、格式和 `!env` 标签。

## 编辑提供的保证

| 阶段       | 保证                                                             |
| ---------- | ---------------------------------------------------------------- |
| **已接纳** | 编辑已进入加载器的有界工作队列。在此之前取消调用者，编辑不生效。 |
| **已保存** | 文件已写入，目标已发布。编辑的效果到此完成。                     |
| **已协调** | 插件已完成更新。编辑完成**并不**意味着这一点，需要使用 `ready`。 |

接纳之后，取消调用者只会停止等待，加载器 scope 中的 worker 会继续完成文件保存和目标发布。

- 调用者通过 `Deferred`
  接收此次操作的结果；即使调用者已经离开，失败仍会记录完整 cause。
- 关闭加载器会停止 worker、结清等待中的调用，并以 `LoaderClosed` 拒绝新编辑。

### 等待结果

独立的 scoped fiber 负责协调运行树，可以跳过中间目标版本。

| 你想要……                    | 做法                                                                             |
| --------------------------- | -------------------------------------------------------------------------------- |
| 等待当前目标及加载中的 fork | 在生命周期回调之外调用 `ready`。                                                 |
| 在生命周期回调中提交编辑    | 可以提交，但不能在回调中等待 `ready`，否则会等待回调自身完成。                   |
| 刷新当前已保存的目标        | 先 `retry`，再 `ready`。`retry` 在请求发布后就返回。                             |
| 刷新整棵树的 `!env`         | `loader.retry`，或 `loader.root.update(entries)`（即使配置项没有变化也会刷新）。 |
| 持久化配置修改              | 使用普通编辑方法。                                                               |

`ready` 会等待当前目标版本、排队中和执行中的环境刷新，以及所有后代离开
`Loading`。它将 `Pending` 和 `Failed`
视为已稳定；服务提供方启动后，依赖它的插件仍可能短暂处于 `Pending` 状态。因此
`ready` 不保证所有插件都已激活。核心的 [`fork.stable`](../fork-handle/)
屏障只反映当前 fork 状态，不能替代加载器的这些检查。

关于 `retry`：

- `retry` 重新发布相同目标时，`changes` 也会发出一次通知。
- 它会穿过生命周期、注入和分组包装层，对启动失败的实际插件 fork 调用 `restart`。
- 除非刷新后的值要求更新或重新加载，否则会保留健康实例及尚未完成的解析。
- 普通编辑会重试参与调和的分组中的失败项，但不会刷新未变的健康子树。

## 快照

加载器为接纳的每个目标保留冻结的快照。

- API 编辑在入队前会复制数组和普通对象（包括元数据）；接纳初始目标或刷新得到的目标时也会复制。
- 之后修改传入的对象，不会改变运行或持久化的目标；需要提交新编辑才能应用新值。
- `loader.entries` 和 `loader.changes` 暴露的数据是冻结的。

| 值                                  | 处理方式                                               |
| ----------------------------------- | ------------------------------------------------------ |
| 数组和普通对象                      | 复制。共享引用与环在快照中保留，但环仍然无法通过校验。 |
| 类实例（`Env`、Data 类、`Date` 等） | 保留原引用。请将它们作为不可变配置使用。               |
| 环境变量解析中共享的数组和对象      | 保持原样，不展开成树。身份缓存仅属于单次执行。         |

快照复制、环检测和配置比较也考虑共享图。比较时每对普通容器只访问一次；不透明值继续使用 Effect 的相等性，包括其自定义比较实现。含环或不透明值的配置在 ID 匹配时采用保守的回退方式，同名项较多时仍可能需要平方级比较。

## 文件如何写入

Graft 先写入临时文件，避免配置文件只写了一半。

1. 在同目录以 `0600` 权限独占创建临时文件。
2. 保留目标文件的权限位及可获取的 uid/gid。新文件默认为 `0600`。
3. 执行 `fsync` 并关闭文件。
4. 通过 rename 替换原文件。

| 情形                | 行为                                                              |
| ------------------- | ----------------------------------------------------------------- |
| 写入失败或被中断    | Graft 删除临时文件。如果清理也失败，两个失败的 cause 会一并保留。 |
| 扩展 ACL 和扩展属性 | 不复制。                                                          |
| 掉电                | 不对目录执行 fsync，因此不承诺 rename 在掉电后仍然有效。          |
| 解析或序列化失败    | 以 `StoreError` 保留原始 cause，文件不变。                        |

写盘前，Graft 会重新解码最终文档，确认它与目标配置一致。

### YAML anchor 与 alias

| 情形                            | 行为                                                                                  |
| ------------------------------- | ------------------------------------------------------------------------------------- |
| 编辑修改或删除 anchor           | 受影响的 alias 会物化成保留原值的独立副本，无关 alias 保持不变。                      |
| 通过 alias 的分组编辑其中的子项 | Graft 先创建本地副本，不修改源集合。                                                  |
| entry/group 结构边界上的 alias  | 在收集和分配 ID 前物化，因此 alias 分组中的匿名子项也会获得独立 ID。                  |
| 自动分配 ID                     | Graft 先计算独立的逻辑目标，只物化受插入影响的 alias。普通插件配置不会混入生成的 ID。 |

Graft 会重新解析序列化后的 YAML，确认它与计划目标一致；不一致时返回
`StoreError`，文件保持不变。

## 与外部编辑的冲突

如果文件在 Graft 上次读取后被其他人修改，Graft 会先重新读取文件，再应用编辑。如果编辑涉及的字段也在文件中被修改，则**以文件为准**：Graft 会放弃这次编辑并记录警告。

临时文件准备完成后，Graft 会在 rename 前再次核对目标文件：

1. 如果文件已变化，Graft 会删除临时文件、读取新版本并重新应用编辑。
2. 同字段冲突仍以最初的快照为基准，因此准备期间的修改也会被检测到。
3. 最多尝试三次；文件持续变化时返回 `StoreError`，不提交这次编辑。
4. 清理失败会停止重试并保留完整 cause。

初始文件创建和自动分配 ID 后的写回也使用同样的检查。

### 并发保存

:::caution

内容核对与 rename 是两个独立的文件系统操作。外部编辑器仍可能在两者之间保存，这次保存仍可能被覆盖。原子替换保证文件不会只写一半，但无法与任意编辑器形成事务。如果不能接受这个剩余风险，请避免同时在编辑器中保存文件和通过 API 写入。

:::
