---
title: Replace plugins
description: Swap plugins for new versions in one transaction.
---

`Graft.replace` swaps plugins for new versions. Every fork of an old plugin
restarts with its replacement, and loading the old plugin later loads the new
one:

```ts import.meta.vitest name="replace: swap a plugin for a new version"
import { Array, Effect, Option, Stream } from "effect"

import { Graft, Plugin } from "@graftland/graft"

const greeterV1 = Plugin.make({ name: "greeter v1", apply: () => Effect.void })
const greeterV2 = Plugin.make({ name: "greeter v2", apply: () => Effect.void })

const names = await Effect.runPromise(
	Effect.gen(function* () {
		const running = yield* Graft.plugin(greeterV1)
		yield* running.await
		yield* Graft.replace([[greeterV1, greeterV2]])
		const later = yield* Graft.plugin(greeterV1)
		yield* later.await
		// Wait until the running fork has restarted as well.
		return yield* Graft.forks.pipe(
			Stream.map(Array.map((fork) => fork.name)),
			Stream.filter(Array.every((name) => name === "greeter v2")),
			Stream.runHead,
		)
	}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)

names // => Option.some(["greeter v2", "greeter v2"])
```

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

Graft applies all pairs in one transaction, so no fork sees half of a
replacement. Then each affected fork stops and starts as usual, in the
[withdrawal order](../services/#how-withdrawal-works).
[Hot reload](../hot-reload/) uses `replace`.

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
