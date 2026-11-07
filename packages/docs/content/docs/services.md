---
title: Services
description: Publish services at run time, and how Graft withdraws them safely.
---

A service in Graft is an ordinary Effect `Context` key with a value. Graft adds
two guarantees:

- Services can be published and withdrawn while the application runs.
- Plugins that use a service are stopped before the service goes away.

## Publish a service

Call `Graft.provide` inside `apply`:

```ts title="clock.ts"
import { Context, DateTime, Effect } from "effect"

import { Graft, Plugin } from "@graftland/graft"

export class Clock extends Context.Service<
	Clock,
	{ readonly now: Effect.Effect<number> }
>()("app/Clock") {}

export const clock = Plugin.make({
	name: "app/clock",
	apply: () =>
		Graft.provide(Clock, {
			now: Effect.map(DateTime.now, DateTime.toEpochMillis),
		}),
})
```

| Rule           | Detail                                                                                       |
| -------------- | -------------------------------------------------------------------------------------------- |
| **Ownership**  | The service belongs to the fork that published it, until that fork is unloaded or restarted. |
| **Count**      | A fork can publish any number of services.                                                   |
| **Uniqueness** | Only one fork can publish a key in the same [realm](../isolation/).                          |
| **Conflict**   | A second `Graft.provide` for the same key fails with `ServiceConflict`.                      |
| **Swapping**   | Replace the plugin that publishes it, or use [`Graft.replace`](../replace/).                 |

## Use a service

List the key in `inject` and read it with `yield*`:

```ts import.meta.vitest name="services: use a service"
import { Effect, Option, Stream } from "effect"

import { Fork, Graft, Plugin } from "@graftland/graft"

import { Clock, clock } from "./clock.ts"

const uptime = Plugin.make({
	name: "app/uptime",
	inject: [Clock],
	apply: () =>
		Effect.gen(function* () {
			const clock = yield* Clock
			const started = yield* clock.now
			yield* Effect.addFinalizer(() =>
				Effect.flatMap(clock.now, (now) =>
					Effect.log(`Ran for ${now - started} ms`),
				),
			)
		}),
})

const state = await Effect.runPromise(
	Effect.gen(function* () {
		const provider = yield* Graft.plugin(clock)
		yield* provider.await
		const fork = yield* Graft.plugin(uptime)
		yield* fork.await
		return yield* Stream.runHead(fork.state)
	}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)
state // => Option.some(Fork.ForkState.Active())
```

The finalizer above calls `clock` while the plugin stops. This is safe: a
service stays usable until every plugin that injects it has stopped.

The publisher does not have to run in your process. A plugin moved into a child
process, a worker or another machine with [Remote](../remote/overview/) still
publishes its services here, and `uptime` would inject `Clock` the same way.
Calls then cross a connection, and their failures reach the caller as
[remote errors](../remote/hosts/#errors-callers-see).

## How withdrawal works

When a fork that publishes services stops, Graft follows this order:

1. **Stop `apply`** if it is still running.
2. **Close publication.** In one transaction, withdraw the fork's services. No
   new consumer can lease them, and this activation cannot publish again.
3. **Drain consumers.** Wait until every existing consumer releases its leases,
   then restart the consumers (see the table below). Healthy `Plugin.fork` tasks
   and their resources stay available to the consumers' finalizers meanwhile.
4. **Stop the remaining tasks.** Close their scopes and wait for cancellation
   cleanup.
5. **Close the activation scope.** Run finalizers, stop child plugins and remove
   event handlers.
6. **Release** the services the fork itself was using.

How a consumer restarts in step 3:

| Consumer's situation             | After the restart                |
| -------------------------------- | -------------------------------- |
| An environment fallback exists   | It uses the fallback.            |
| Required dependency, no fallback | It becomes `Pending`.            |
| Optional dependency, no fallback | It restarts without the service. |

:::note

If step 3 takes more than 10 seconds, Graft logs a warning: two plugins may be
waiting for each other. The order in which finalizers were registered does not
matter; the resources of healthy tasks and of the activation stay alive until
the leased consumers finish.

:::

### When a failure starts the teardown

The same order applies. The failed task has already stopped, and healthy tasks
continue until the consumers drain.

- Graft collects further task failures during draining and logs them with their
  complete `Cause`, including cleanup defects.
- A teardown started by a failure includes them in the final `Failed` state, as
  well as failures of resource finalizers.
- These failures do not stop the remaining cleanup phases or the release of
  dependency leases.
- An explicit `dispose` reports a cleanup failure as `Fork.CleanupError`. Its
  `cause` keeps the original failure reasons.

### Leases

A plugin that starts using a service holds it until the plugin stops. Graft
counts these uses in the same transaction that checks the plugin's dependencies,
so a service is never withdrawn while a plugin is half started.

## Services from the environment

Services in the environment where `Graft.layer` is built are visible to every
plugin. They can satisfy `inject`, and they live as long as that environment.
Use the environment for services that live as long as the whole application:

```ts import.meta.vitest name="services: services from the environment"
import { Effect, FileSystem, Layer, Option, Path, Stream } from "effect"
import { NodeServices } from "@effect/platform-node"

import { Fork, Graft, Plugin } from "@graftland/graft"

const layer = Layer.provideMerge(Graft.layer, NodeServices.layer)

const files = Plugin.make({
	name: "app/files",
	inject: [FileSystem.FileSystem, Path.Path],
	apply: () => Effect.void,
})

const state = await Effect.runPromise(
	Effect.gen(function* () {
		const fork = yield* Graft.plugin(files)
		yield* fork.await
		return yield* Stream.runHead(fork.state)
	}).pipe(Effect.scoped, Effect.provide(layer)),
)
state // => Option.some(Fork.ForkState.Active())
```

With this layer, a plugin can inject `FileSystem.FileSystem` or `Path.Path`
directly.

### Lookup order

For every key in `inject`, required or optional, Graft resolves in this order:

1. The registry in the consumer's realm.
2. The environment, if the registry has nothing.

A consumer that uses the fallback still watches its realm:

| Event in the realm         | The consumer…                              |
| -------------------------- | ------------------------------------------ |
| A new provision appears    | Restarts with the published value.         |
| The provision is withdrawn | Restarts with the environment value again. |

So consumers loaded before and after publication end up with the same value.
Publication does not wait for existing consumers to finish restarting.

### `inject` versus `Effect.serviceOption`

|                                          | `inject` | Undeclared `Effect.serviceOption`          |
| ---------------------------------------- | -------- | ------------------------------------------ |
| Looks up the realm, then the environment | Yes      | No, it reads the activation's context only |
| Subscribes to registry changes           | Yes      | No                                         |
| Takes a lease on the provision           | Yes      | No                                         |

Use `inject` when you want the lookup and restart behavior.

### References

A `Context.Reference` in `inject` always has a fallback, so it never leaves a
plugin `Pending`. Resolution order:

1. A provision in the consumer's realm.
2. The inherited reference value, including intercepts.
3. The reference's default.

It watches publication and withdrawal just like other injected keys.

## Publication cycles

Graft rejects a publication that would restart its own provider. It checks this
in the same transaction that publishes the service:

1. Find the running consumers that watch that realm and key, through an ambient
   fallback or an absent optional dependency.
2. Follow their descendants and the consumers of every affected provider, until
   no more forks would be stopped.
3. If the publisher is among them, the registry stays unchanged and
   `Graft.provide` fails with `ServiceConflict`.

Required dependencies of `Pending` forks are waiting to start, so they do not
count as restart watchers.

### The error

| Field    | Value                                                                           |
| -------- | ------------------------------------------------------------------------------- |
| `reason` | `"SelfDependency"` for a direct cycle, `"DependencyCycle"` for an indirect one. |
| `reason` | `"Invalidated"` when a dependency change already invalidated the provider.      |
| `fork`   | The publisher's fork ID.                                                        |
| `realm`  | The service's realm.                                                            |

When you wrap an environment service, use separate input and output keys.

### What happens next

- If a cycle error escapes `apply` or a `Plugin.fork` task, Graft cleans up the
  publisher and it enters `Failed`.
- It then waits for a change in configuration, dependencies or the graph. It
  does not follow its retry schedule again and again into the same cycle.
- Before it retries, Graft checks the graph with the failed fork's expected
  dependencies put back. Releasing the fork's leases during cleanup does not by
  itself break the cycle.
- Rejection does not publish a value or restart existing watchers. Normal
  failure propagation still applies: a plugin that awaits a child's failure may
  fail itself, and withdrawing services the failed fork had already published
  affects their consumers as usual.
