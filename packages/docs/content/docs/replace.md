---
title: Replace plugins
description:
  Swap plugins for new versions in one transaction, and roll back if they fail
  to start.
---

`Graft.replace` swaps plugins for new versions. Every fork of an old plugin
restarts with its replacement, and loading the old plugin later loads the new
one. It returns once the replacement or recovery settles:

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

`Graft.replace` rejects managed forks and their ancestors before changing
aliases or specs. See [Execution transitions](../transitions/) for the
`ManagedFork` conflict and coordinator outcomes.

## Type rules

TypeScript checks each pair on its own:

| Part of the target | Must be                                                                                 |
| ------------------ | --------------------------------------------------------------------------------------- |
| Input type         | Exactly the same as the source's.                                                       |
| Errors             | A subset of the source's error bound, which includes decoding failures (`SchemaError`). |

This keeps existing fork handles valid after replacement. A definition's input
and error contracts are invariant, so you cannot bypass the check by assigning
the same object to a wider error type or a narrower input type. Declare the
error union you need when you create the plugin, before you load it.

:::caution

Dynamically loaded modules use `Plugin` with `any` parameters. This boundary
removes the static contracts on purpose, so HMR and loaders can still use it.
Replacement compatibility is **not** checked at run time there. Explicit `any`
or type assertions can also bypass the TypeScript guarantees.

:::

## Plugin identity

A plugin's identity is the reference to its definition object, not its name or
fields.

- The same object is the same plugin.
- `{ ...plugin }` creates a different plugin. Replacing one copy does not
  replace another copy or the original.
- Loading, alias lookup and conflict checks all follow this rule, including for
  frozen objects and definitions with custom `Equal` or `Hash` implementations.
  Graft does not change those implementations on objects the caller owns.

## Transaction

Graft swaps all pairs in one transaction, so no fork sees half of a replacement.
Then each affected fork stops and starts as usual, in the
[withdrawal order](../services/#how-withdrawal-works).
[Hot reload](../hot-reload/) uses `replace`.

## Rollback

If a fork running a replacement fails to start, Graft rolls the whole batch back
and restores the old plugins. Once recovery settles, `replace` returns
`RolledBack` if no counted restored fork failed, or `RecoveryFailed` otherwise.
Both outcomes carry the replacement `failures`; `RecoveryFailed.recovery`
contains one `Failed` per failed restored fork, with its full `Cause`:

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

| Situation                                                    | Outcome                                                                                       |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| Every fork running a replacement is `Active` or `Pending`    | `Replaced`.                                                                                   |
| One fails, including a child that a replaced parent loads    | Roll back, recording a `Failed` failure and its full `Cause`.                                 |
| One is still starting when `timeout` passes                  | Roll back, recording a `TimedOut` failure.                                                    |
| All counted restored forks are `Active` or `Pending`         | `RolledBack`, with the replacement `failures`.                                                |
| Any counted restored fork is `Failed`                        | `RecoveryFailed`, with replacement `failures` and restored failures in `recovery`.            |
| The plugin has a `retry` schedule                            | The first failure decides; Graft does not wait for retries.                                   |
| A fork had already failed before `replace`                   | It does not decide whether to roll back, but is rolled back too. Its recovery failure counts. |
| A fork asked for a target itself, before or during `replace` | It is not judged and stays on the target.                                                     |
| A later `replace` or `restart` takes a fork over             | That fork and its children no longer count, and it is not rolled back.                        |
| The caller is interrupted while `replace` waits              | The swap stays.                                                                               |

A restored fork counts only while it remains on the plugin restored by rollback
and has not been disposed. Recovery also waits for descendants created by the
restored parent and includes their complete failure causes. A later replacement
or restart takes over the fork and its subtree, which no longer count. `Pending`
means it is waiting for a dependency and counts as restored, just as it counts
as started before replacement. Recovery waits are not bounded by `timeout`.

- `timeout` is an option: `Graft.replace(pairs, { timeout: "30 seconds" })`.
  Without it, `replace` waits as long as the forks take.
  [Hot reload](../hot-reload/) waits 30 seconds by default.
- Each failure names the `fork` id and the `plugin` name.
- `Graft.resolve(plugin)` returns the plugin that loading `plugin` loads now, so
  code that was interrupted while `replace` waited can see whether the swap
  stayed.
- Plugins that use a service of a rolled-back plugin restart twice: for the new
  version and again for the old one. Their own failures do not cause a rollback.

## Conflicts

Some batches cannot be represented by the runtime's aliases. They fail with
`Graft.ReplacementConflict`, whose `indices` field names the conflicting pairs.

| Conflicting batch                                                    | Example        |
| -------------------------------------------------------------------- | -------------- |
| Different targets for one source                                     | `P → Q, P → R` |
| Overlapping changes                                                  | `P → Q, Q → R` |
| Stale source identities that would leave forks on a different plugin | —              |

On failure, the transaction leaves aliases and forks unchanged. Two cases still
work: pointing several sources at one unchanged target, and rolling back to an
older version.
