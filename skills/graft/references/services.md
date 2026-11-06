# Services

A service is an Effect `Context` key with a value. Graft lets forks publish and
withdraw services while the app runs, and stops every consumer before its
provider goes away.

## Define the key

```ts
import { Clock, Context, Effect } from "effect"

export class Time extends Context.Service<
	Time,
	{ readonly now: Effect.Effect<number> }
>()("@acme/graft-plugin-time/Time") {}
```

- The string is the key's identity everywhere, including `graft.yml` (`inject`,
  `isolate`). Scope it to the package.
- Methods return Effects. A method runs in the caller's fiber, so it sees the
  caller's [intercepts](realms.md#intercepts).
- Describe expected failures with `Schema.TaggedError` or `Data.TaggedError` in
  the method types.

## Publish

```ts
const time = Plugin.make({
	name: "@acme/graft-plugin-time",
	apply: () => Graft.provide(Time, { now: Clock.currentTimeMillis }),
})
```

- The service belongs to the fork until it stops or restarts. A fork may publish
  several.
- One provider per key per [realm](realms.md). A second `Graft.provide` fails
  with `ServiceConflict`; use `Graft.replace` or a realm instead.
- Build the value inside `apply`, so its resources belong to the fork, then
  provide it. `Plugin.service` and `Plugin.layer` do both in one step.

## Consume

```ts
const uptime = Plugin.make({
	name: "app/uptime",
	inject: [Time],
	apply: () =>
		Effect.gen(function* () {
			const time = yield* Time
			const started = yield* time.now
			yield* Effect.addFinalizer(() =>
				Effect.flatMap(time.now, (now) =>
					Effect.log(`Ran for ${now - started} ms`),
				),
			)
		}),
})
```

The finalizer may still call `time`: a service stays usable until every fork
that injects it has stopped.

## Withdrawal order

When a provider stops:

1. Its `apply` stops, and its services are withdrawn in one transaction.
2. Consumers drain: each finishes its teardown, then restarts. It uses an
   environment fallback if one exists, waits in `Pending` for a required
   service, or runs without an optional one.
3. The provider's tasks stop, then its scope closes.

Consumers never see a half-stopped provider, whatever order finalizers were
registered in. If draining takes over 10 seconds, Graft warns: two plugins may
be waiting for each other.

## Environment services

Services in the environment where `Graft.layer` is built are visible to every
fork and live as long as the app:

```ts
const runtime = Layer.provideMerge(Graft.layer, NodeServices.layer)
```

A plugin can then inject `FileSystem.FileSystem` or `Path.Path` directly. For
each injected key, Graft looks in the consumer's realm first, then the
environment. A consumer on the fallback restarts when a provision appears or
goes away in its realm.

Put app-wide infrastructure in the environment; put anything that should be
swappable, configurable from `graft.yml`, or per-tenant in a plugin.

## `inject` versus `Effect.serviceOption`

Only `inject` looks up the realm, subscribes to changes and holds a lease. An
undeclared `Effect.serviceOption` reads the activation's context only. Declare
what you read.

## Cycles

Graft rejects a publication that would restart its own provider, directly
(`reason: "SelfDependency"`) or through other forks (`"DependencyCycle"`). When
a plugin wraps an environment service, publish under a separate key from the one
it injects.
