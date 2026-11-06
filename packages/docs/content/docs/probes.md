---
title: Health probes
description: Register checks for a serving attempt and run them explicitly.
---

A **probe** is a named Effect registered by `Plugin.probe` inside `apply`.
Registration does not run the check. Each serving attempt owns its registrations
and any running checks.

## Register and request a probe

```ts import.meta.vitest name="probes: request a check"
import { Effect, Ref } from "effect"

import { Graft, Plugin } from "@graftland/graft"

const program = Effect.gen(function* () {
	const calls = yield* Ref.make(0)
	const plugin = Plugin.make({
		name: "app/integration",
		apply: () =>
			Plugin.probe(
				"upstream",
				Ref.update(calls, (n) => n + 1),
			),
	})
	const fork = yield* Graft.plugin(plugin)
	yield* fork.await
	yield* Ref.get(calls) // => 0
	yield* fork.probes // => ["upstream"]
	yield* fork.probe("upstream")
	yield* Ref.get(calls) // => 1
})
await Effect.runPromise(
	program.pipe(Effect.scoped, Effect.provide(Graft.layer)),
)
```

| Rule          | Behavior                                                                                                        |
| ------------- | --------------------------------------------------------------------------------------------------------------- |
| Ownership     | A registration lasts until its registering scope closes. A restart registers fresh checks.                      |
| Isolation     | Two forks may use the same probe name. Duplicate names in one attempt fail registration.                        |
| Context       | A check uses the services captured when it was registered. Each request gets its own scope.                     |
| Failure       | `Fork.ProbeError` retains the check's complete cause. A failed check does not automatically restart the plugin. |
| Cancellation  | Closing the registration scope interrupts its running checks. Interrupting a request cancels that invocation.   |
| Missing check | Requesting a name that is not registered fails with `ProbeError` and reason `Missing`.                          |

## Remote checks

Remote execution units accept probe requests over their control channel.
Describing an implementation does not run `apply` or probes. Serving runs
ordinary `apply`; readiness waits for the plugin and its exported services. A
successful probe is separate from readiness and from confirmed process exit.

`fork.probe` addresses that fork's own registrations. A host Remote fork does
not forward this API to its child. Automatic upgrade checks and overlap
transitions are not available yet.
