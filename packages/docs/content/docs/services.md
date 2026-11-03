---
title: Services
description: Publish services at run time, and how Graft withdraws them safely.
---

A service in Graft is an ordinary Effect `Context` key with a value. What Graft
adds is that services can be published and withdrawn while the application runs,
and that plugins using a service are stopped before it goes away.

## Publish a service

Call `Graft.provide` inside `apply`:

```ts
import { Graft, Plugin } from "@graftland/graft"
import { Context, Effect } from "effect"

class Clock extends Context.Service<
	Clock,
	{ readonly now: Effect.Effect<number> }
>()("app/Clock") {}

const clock = Plugin.make({
	name: "clock",
	apply: () => Graft.provide(Clock, { now: Effect.sync(() => Date.now()) }),
})
```

The service belongs to the fork that published it. It stays available until that
fork is unloaded or restarted. A fork can publish any number of services.

Only one fork can publish a key in the same [realm](../isolation/). A second
`Graft.provide` for the same key fails with `ServiceConflict`. To swap a service
implementation, replace the plugin that publishes it, or use
[`Graft.replace`](../lifecycle/#replace-plugins).

## Use a service

List the key in `inject` and read it with `yield*`:

```ts
const uptime = Plugin.make({
	name: "uptime",
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
```

The finalizer above calls `clock` while the plugin stops. That is safe: a
service stays usable until every plugin that injects it has stopped.

## How withdrawal works

When a fork that publishes services stops, Graft goes through these steps in
order:

1. It withdraws the fork's services in one transaction. No plugin can start
   using them from now on.
2. It waits until every plugin that uses them has stopped. Those plugins see
   their dependency go away, stop, and go back to `Pending`.
3. It closes the fork's scope. Its finalizers run, its child plugins stop, and
   its event handlers are removed.
4. It releases the services the fork itself was using.

So resources are released only after nothing can call them, whatever order the
finalizers were registered in. If step 2 takes more than 10 seconds, Graft logs
a warning: two plugins may be waiting for each other.

A plugin that starts using a service holds it until it stops. Graft counts these
uses in the same transaction that checks the plugin's dependencies, so a service
is never withdrawn while a plugin is half started.

## Services from the environment

Services in the environment where `Graft.layer` is built are visible to every
plugin. They satisfy `inject` like published ones, but they are never withdrawn:

```ts
import { NodeServices } from "@effect/platform-node"

const layer = Layer.provideMerge(Graft.layer, NodeServices.layer)
```

With this layer, a plugin can inject `FileSystem.FileSystem` or `Path.Path`
directly. Use the environment for services that live as long as the whole
application.
