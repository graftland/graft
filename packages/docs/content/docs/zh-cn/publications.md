---
title: 发布
description: 从 Layer 外部把一个值放进图里，并在运行期间替换它。
---

`Graft.publish`
把一个值放在某个服务键下，放进图里。所有需要这个键的挂载都会带着它构建，并在它变化时重建。

## 发布一个值

```ts import.meta.vitest name="publications: a published value reaches a layer"
import { Context, Effect, Layer } from "effect"

import { Graft } from "@graftland/graft"

class Region extends Context.Service<Region, string>()("app/Region") {}
class Report extends Context.Service<Report, { region: string }>()(
	"app/Report",
) {}

const report = Layer.effect(
	Report,
	Effect.map(Region, (region) => ({ region })),
)

const region = await Effect.runPromise(
	Effect.gen(function* () {
		const publication = yield* Graft.publish(Region, "eu")
		yield* publication.await
		const mount = yield* Graft.mount(report, { requires: [Region] })
		yield* mount.await
		const value = yield* Graft.await(Report)
		yield* publication.set("us")
		return value.region
	}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)
region // => "eu"
```

发布属于创建它的那个 scope。关闭 scope 会撤回值；需要它的挂载变成
`Pending`，如果依赖是可选的，就重建为不含该值。

`Graft.publish`
返回句柄时，值还没有真正发布：supervisor 会异步应用它。在立刻依赖这个值之前，先
`yield* publication.await`（或 `publication.stable`）。

## 在挂载内部发布

在挂载内部调用 `Graft.publish`——无论是在 Layer 的构建里，还是在 `Graft.fork`
的 fiber 里——这次发布也归那个挂载所有。

- 挂载被拆除时，发布随之撤回。
- 挂载已经开始拆除后再发布，会以 defect 终止。

发布仍然属于创建它的 scope，所以它也会随那个 scope 结束。

## 替换值

`Publication` 在[挂载句柄](../mounting/#持有挂载)的基础上增加 `set`：

| 成员      | 行为                                                                 |
| --------- | -------------------------------------------------------------------- |
| `set`     | 替换值，并重建所有需要它的挂载。                                     |
| `state`   | 依赖方重建期间回到 `Loading`，之后是 `Active`。                      |
| `await`   | 等到发布稳定；`Failed` 状态以它的 `Cause` 失败，即使设置了 `retry`。 |
| `unmount` | 撤回值，并从挂载树中移除这次发布。                                   |

`set`
在变化被接受时完成，而不是等重建结束。快速连续调用它可能跳过中间值；最后一个被接受的值生效。

## 规则

| 规则       | 说明                                                                           |
| ---------- | ------------------------------------------------------------------------------ |
| **身份**   | 一次发布在其领域里拥有这个键，直到它被卸载。                                   |
| **唯一性** | 同一领域里，一个键只能由一个发布或一个挂载提供。                               |
| **冲突**   | 因为键已被占用而被拒绝的值，会让这次发布的 `await` 以 `ServiceConflict` 失败。 |
| **环境**   | 发布的值存在期间，会遮住环境中同名的键。                                       |
| **顺序**   | 发布和撤回与依赖检查共用一个事务。                                             |

发布一个会重建它自己提供者的值，也会被同样拒绝；见[发布环](../isolation/#发布环)。

## 文件与配置

配置文件就是一个值的列表，所以在创建发布的地方读取文件，然后逐个发布：

```ts
import { Context, Effect } from "effect"

import { Graft } from "@graftland/graft"

class AppConfig extends Context.Service<AppConfig, { region: string }>()(
	"app/Config",
) {}

declare const readConfig: Effect.Effect<{ region: string }>

export const program = Effect.gen(function* () {
	const config = yield* readConfig
	const publication = yield* Graft.publish(AppConfig, config)
	yield* publication.await
})
```

用 `publication.set` 修改值。每个需要 `AppConfig`
的挂载都会带着新值重建，所以配置变化无需重启程序即可生效。
