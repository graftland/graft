---
title: 替换插件
description: 在一个事务中把插件替换为新版本，启动失败时回滚。
---

`Graft.replace`
将插件替换为新版本。旧插件的每个 fork 都会使用替换后的插件重启；之后再加载旧插件，也会加载新插件。重启的 fork 启动后它才返回：

```ts import.meta.vitest name="replace: swap a plugin for a new version"
import { Array, Effect, Option, Stream } from "effect"

import { Graft, Plugin } from "@graftland/graft"

const greeterV1 = Plugin.make({
	name: "app/greeterV1",
	apply: () => Effect.void,
})
const greeterV2 = Plugin.make({
	name: "app/greeterV2",
	apply: () => Effect.void,
})

const outcome = await Effect.runPromise(
	Effect.gen(function* () {
		const running = yield* Graft.plugin(greeterV1)
		yield* running.await
		const result = yield* Graft.replace([[greeterV1, greeterV2]])
		const later = yield* Graft.plugin(greeterV1)
		yield* later.await
		const tree = yield* Stream.runHead(Graft.forks)
		return [
			result._tag,
			Option.map(
				tree,
				Array.map((fork) => fork.name),
			),
		]
	}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)

outcome // => ["Replaced", Option.some(["app/greeterV2", "app/greeterV2"])]
```

## 类型规则

TypeScript 会逐对独立检查：

| 目标插件的部分 | 必须                                                          |
| -------------- | ------------------------------------------------------------- |
| 输入类型       | 与来源完全相同。                                              |
| 错误           | 是来源错误上界的子集。错误上界包含解码失败（`SchemaError`）。 |

这样可以保证已有的 fork 句柄在替换后仍然有效。定义的输入与错误契约是不变的，因此不能通过把同一个对象赋给更宽的错误类型或更窄的输入类型来绕过检查。需要的错误联合应在创建插件时、加载之前声明。

:::caution

动态加载的模块使用参数为 `any` 的
`Plugin`。这一边界刻意擦除了静态契约，HMR 和加载器仍可使用；在运行时**不会**验证替换兼容性。显式使用
`any` 或类型断言，同样可以绕过 TypeScript 的保证。

:::

## 插件身份

插件身份由其定义对象的引用决定，不由名称或字段决定。

- 同一个对象就是同一个插件。
- `{ ...plugin }` 会创建不同的插件。替换一个副本不会替换其他副本或原对象。
- 加载、alias 查找和冲突检查都遵循这一规则，冻结对象和自定义了 `Equal` 或 `Hash`
  的定义也不例外。Graft 不会修改调用方拥有的对象上的这些实现。

## 事务

Graft 在一个事务中应用所有配对，任何 fork 都不会看到只完成一部分的替换。随后，每个受影响的 fork 按照正常的[服务撤回顺序](../services/#服务撤回流程)停止并重新启动。[热重载](../hot-reload/)使用的就是
`replace`。

## 回滚

如果运行替换插件的某个 fork 启动失败，Graft 会回滚整批替换：每个 fork 回到旧插件，之后加载旧插件也会再次加载旧插件；旧插件重启后，`replace`
返回带有失败信息的 `RolledBack`：

```ts import.meta.vitest name="replace: roll back a replacement that fails"
import { Array, Effect, Option, Stream } from "effect"

import { Graft, Plugin } from "@graftland/graft"

// The error bound admits the failures of later versions; see Type rules.
const greeterV1 = Plugin.make({
	name: "app/greeterV1",
	apply: (): Effect.Effect<void, string> => Effect.void,
})
const broken = Plugin.make({
	name: "app/greeterV2",
	apply: () => Effect.fail("no greeting"),
})

const outcome = await Effect.runPromise(
	Effect.gen(function* () {
		const running = yield* Graft.plugin(greeterV1)
		yield* running.await
		const result = yield* Graft.replace([[greeterV1, broken]])
		const failed =
			result._tag === "RolledBack"
				? Array.map(result.failures, (failure) => failure.plugin)
				: []
		const tree = yield* Stream.runHead(Graft.forks)
		return [
			failed,
			Option.map(
				tree,
				Array.map((fork) => fork.name),
			),
		]
	}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)

outcome // => [["app/greeterV2"], Option.some(["app/greeterV1"])]
```

| 情形                                               | 结果                                               |
| -------------------------------------------------- | -------------------------------------------------- |
| 运行替换插件的每个 fork 都是 `Active` 或 `Pending` | `Replaced`。                                       |
| 其中一个失败，包括被替换的父插件加载的子插件       | `RolledBack`，带有 `Failed` 失败及其完整 `Cause`。 |
| 到 `timeout` 时仍有 fork 在启动                    | `RolledBack`，带有 `TimedOut` 失败。               |
| 插件设置了 `retry` 调度                            | 第一次失败即作决定；Graft 不等待重试。             |
| 某个 fork 在 `replace` 之前就已失败                | 它的结果不计入，但会一起回滚。                     |
| 某个 fork 在 `replace` 之前或期间直接请求目标插件  | 不计入，回滚后仍留在目标插件上。                   |
| 之后的 `replace` 或 `restart` 接管了某个 fork      | 该 fork 及其子 fork 不再计入，它也不会回滚。       |
| 调用方在 `replace` 等待时被中断                    | 保留替换。                                         |

- `timeout`
  是一个选项：`Graft.replace(pairs, { timeout: "30 seconds" })`。不设置时，`replace`
  会一直等到 fork 启动完成。[热重载](../hot-reload/)默认等待 30 秒。
- 每个失败都带有 `fork` id 和 `plugin` 名称。
- `Graft.resolve(plugin)` 返回现在加载 `plugin` 时实际加载的插件，因此在
  `replace` 等待期间被中断的代码可以据此判断替换是否保留。
- 使用被回滚插件服务的插件会重启两次：一次换成新版本，一次换回旧版本。它们自身的失败不会引起回滚。

## 冲突

有些批次无法用运行时的 alias 表达，会以 `Graft.ReplacementConflict` 失败，其
`indices` 字段列出冲突的配对。

| 冲突的批次                                     | 示例           |
| ---------------------------------------------- | -------------- |
| 同一来源对应不同目标                           | `P → Q, P → R` |
| 重叠的变更                                     | `P → Q, Q → R` |
| 会使现有 fork 仍停留在其他插件上的过期来源身份 | —              |

失败时，事务不会修改 alias 或 fork。以下两种情况仍然受支持：让多个来源指向同一个未变化的目标，以及回退到旧版本。
