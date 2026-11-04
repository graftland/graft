---
title: 隔离与 intercept
description: 为插件树的某个分支提供独立的服务、事件或设置。
---

领域控制同一进程内的服务可见性。要把插件放进另一个进程或另一台机器，请使用[远程插件](../remote/overview/)。

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
`Database`，看不到其他领域发布的 `Database`。

标签与服务键或事件键是身份的两个独立部分。Graft 把它们各自当作完整的字符串处理，包括内嵌的 NUL 字符。以
`#` 或 `@`
开头的标签不会指向私有领域；空标签表示一个共享领域，这个领域与默认的根领域不同。

### 环境兜底与继承

领域隔离的是已发布的服务，不是构建 `Graft.layer`
时环境中的服务。如果领域中没有某个注入键的 provision，消费者可以使用同键的环境值。在领域 A 发布或撤回服务，不会触发领域 B 中使用环境兜底的消费者重启。

父插件解析得到的 provision 不会通过 Effect
context 继承传给子插件。子插件必须通过自己的 `inject`
依赖，在自己的领域中取得 provision。来自环境的值仍然可用。如果父插件的 provision 遮蔽了根环境中的同键值，子插件仍可以重新使用该环境兜底。这个规则也适用于多代子插件。

## intercept

intercept 为一个 fork 及其所有后代修改 `Context.Reference`
的值。Reference 是始终有值的键。Effect 自身的设置就是 Reference，例如每行日志附带的注解。

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

Reference 也可以列在 `inject`
中：本领域的 provision 优先于 intercept 的兜底值。子插件先剥离父级 provision，再应用自己的 intercept；它们会保留父级的兜底值，包括被该 provision 遮蔽的 intercept。

### 配置文件中的 intercept

`Graft.intercept` 是类型化的代码 API；加载器的 YAML `intercept`
字段则是不可信边界，不接受任意字符串键，必须显式登记。在应用启动时，登记 Reference 对象、其输入的 Schema 和类型化的合并函数：

```ts
import { Graft } from "@graftland/graft"
import { Intercept, ModuleResolver } from "@graftland/loader"
import { Context, Layer, Schema } from "effect"

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

在此 runtime 中运行加载器，并将实际的插件解析器和其他所需平台服务加入
`environment`。之后配置项可以写成：

```yaml
intercept:
  app/Settings:
    color: red
```

结果为
`{ color: "red", size: 12 }`。嵌套配置项的补丁接收父级值，兄弟项保留各自的值。Schema 在合并函数运行前解码输入，且不能依赖解码服务；合并函数的返回类型必须匹配 Reference。标量替换或需要整体校验的设置，可使用完整值 Schema，配合
`(_, value) => value`。

登记表默认为空。未知的键让配置项以 `UnregisteredReference` 失败；无效的值以
`InvalidIntercept`
失败，并在 cause 中保留 Schema 错误。这两种情况下，该配置项的插件都不会启动。应在创建加载器前通过宿主环境提供登记表；加载器管理树中的插件不能通过发布服务来登记 Reference。默认 CLI 登记了
`References.CurrentLogAnnotations`（用于合并日志注解字段）和
`References.MinimumLogLevel`（校验后替换日志级别）；其他 Reference 需要由自定义宿主登记。直接从代码使用的类型化
`Graft.intercept` API 不受此影响。
