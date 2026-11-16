---
title: 隔离
description: 给一个挂载自己的服务，或在多个挂载之间共享一套服务。
---

**领域（realm）**是服务解析时所在的命名空间。默认情况下，所有挂载共用一个领域。`isolate`
给一个挂载换一个领域。

## 给挂载自己的领域

```ts
import { Context, Effect, Layer } from "effect"

import { Graft } from "@graftland/graft"

class Database extends Context.Service<Database, string>()("app/Database") {}
class Tenant extends Context.Service<Tenant, string>()("app/Tenant") {}

const tenant = Layer.effect(
	Tenant,
	Effect.gen(function* () {
		const database = yield* Database
		return `tenant on ${database}`
	}),
)

export const program = Effect.gen(function* () {
	yield* Graft.mount(Layer.effect(Database, Effect.succeed("dedicated")), {
		name: "database",
		isolate: [Database],
	})
	yield* Graft.mount(tenant, { name: "tenant", requires: [Database] })
})
```

`isolate: [Database]` 给这个挂载一个专属于 `Database`
的私有领域。它的子挂载继承这层映射：它们在同一个私有领域里查找
`Database`，所以看到的是这个专属值。

| 选项形式                      | 领域                                                 |
| ----------------------------- | ---------------------------------------------------- |
| 不传                          | 共享的根领域。                                       |
| `isolate: [Database]`         | 这个挂载的私有领域。                                 |
| `isolate: [[Database, "eu"]]` | 标签为 `eu` 的共享领域；所有使用该标签的挂载共用它。 |

标签让多个挂载共用一套服务。私有领域和根领域都无法通过标签访问。

## 隔离覆盖什么

| 规则       | 说明                                                          |
| ---------- | ------------------------------------------------------------- |
| 按键隔离   | 每个键单独隔离。一个挂载可以隔离 `Database`，其他一切都共享。 |
| 继承       | 子挂载从创建它的位置继承领域。                                |
| 提供者唯一 | 一个领域里，一个键只由一个挂载或一次发布提供。                |
| 查找       | 挂载先在自己的领域里找服务，再找 `Graft.layer` 的环境。       |
| 不继承值   | 子挂载从不直接拿到父级的提供值；它在同一个领域里自行解析。    |
| 环境       | 来自环境的服务在每个领域里都可见。                            |

领域标签和服务键是服务身份中相互独立的部分，即使其中任一包含特殊字符也是如此。

## 发布环

发布一个值，可能直接或经由其他挂载重启发布它的那个挂载。Graft 以
`Graft.ServiceConflict` 原子地拒绝这样的发布，领域保持不变。

1. **找到观察者**：目标领域里把这个键当作可选依赖、或通过环境回落使用它的运行中挂载。
2. **跟随**它们的子挂载，以及它们使用的每个提供者的消费者。
3. 如果发布者也在其中，**拒绝**这次发布。

| `reason`          | 情况                           |
| ----------------- | ------------------------------ |
| `SelfDependency`  | 挂载在观察它自己正在发布的键。 |
| `DependencyCycle` | 环里的另一个挂载在观察它。     |
| `Invalidated`     | 依赖变化已经使这个挂载失效。   |

被拒绝的挂载等待它的规格、依赖或造成阻塞的图发生变化。它不会反复重试进同一个环。见[失败与重试](../failures-retry/#serviceconflict)。

## 隔离与 Intercept

| 工具        | 改变什么                                       |
| ----------- | ---------------------------------------------- |
| `isolate`   | 服务在哪个领域解析，也就是挂载看到哪个提供者。 |
| `intercept` | 挂载及其子挂载看到的 `Context.Reference` 值。  |

用 `isolate` 把租户隔开；用 [Intercept](../intercepts/)
调整超时、特性开关这类设置。
