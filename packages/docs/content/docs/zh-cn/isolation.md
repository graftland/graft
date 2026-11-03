---
title: 隔离与 intercept
description: 为插件树的某个分支提供独立的服务、事件或设置。
---

## 领域

每个服务键和事件都归属于一个**领域（realm）**。默认情况下，整个应用只有一个领域：无论在哪里发布服务，所有插件都能看到；事件也会传递给所有处理函数。

`Graft.plugin` 的 `isolate`
选项可以针对指定的键，为一个 fork 及其所有后代创建独立的领域：

```ts
const tenants = Plugin.make({
	name: "tenants",
	apply: () =>
		Effect.gen(function* () {
			yield* Graft.plugin(tenant, { name: "a" }, { isolate: [Database] })
			yield* Graft.plugin(tenant, { name: "b" }, { isolate: [Database] })
		}),
})
```

每个 `tenant` fork 都可以发布自己的 `Database`，内部插件只能看到这个
`Database`。外部发布的 `Database`
对内部不可见，反之亦然。未隔离的键仍然照常共享。

`isolate` 接受任何带 `key` 的对象，可以是 `Database`
这样的服务键，也可以是[事件](../events/)。

### 共享领域

使用标签可以让多个 fork 加入同一个共享领域，而非各自使用私有领域：

```ts
const staging = Effect.gen(function* () {
	yield* Graft.plugin(api, undefined, { isolate: [[Database, "staging"]] })
	yield* Graft.plugin(worker, undefined, { isolate: [[Database, "staging"]] })
})
```

无论 `api` 和 `worker` 位于树的什么位置，它们都共享 `staging` 领域的
`Database`，看不到其他 `Database`。

## intercept

intercept 为一个 fork 及其所有后代修改 `Context.Reference`
的值。Reference 是始终有值的键。Effect 自身的设置（例如每行日志附带的注解）就是 Reference。

```ts
import { References } from "effect"

const tenantA = Graft.plugin(
	tenant,
	{ name: "a" },
	{
		intercept: [
			Graft.intercept(References.CurrentLogAnnotations, (outer) => ({
				...outer,
				tenant: "a",
			})),
		],
	},
)
```

函数接收外层的值，因此 intercept 可以嵌套：该 fork 及其后代插件输出的每行日志都会带上
`tenant: "a"`，同时保留上层添加的注解。

如果某项设置需要由服务从调用者处读取，可以使用 Reference。返回 Effect 的服务方法在调用者的 fiber 中运行，因此能读到调用者的 intercept：

```ts
const Formal = Context.Reference<boolean>("app/Formal", {
	defaultValue: () => false,
})

// Inside the Greeter service:
const greet = (name: string) =>
	Effect.flatMap(Formal, (formal) =>
		Effect.log(formal ? `Good day, ${name}.` : `Hi, ${name}!`),
	)
```

加载插件时使用 `Graft.intercept(Formal, () => true)`，就能让它从大家共用的同一个
`Greeter` 收到正式的问候。
