---
title: Plugins
description: Define plugins with Plugin.make, Plugin.service and Plugin.layer.
---

A plugin is a value that describes how to start something. Loading it creates a
**fork**: one running instance with its own configuration and its own `Scope`.
Loading the same plugin twice gives two independent forks.

## Define a plugin

```ts
import { Plugin } from "@graftland/graft"
import { Effect, Schedule, Schema } from "effect"

export const ticker = Plugin.make({
	name: "ticker",
	config: Schema.Struct({ every: Schema.Duration }),
	apply: ({ every }) =>
		Effect.log("tick").pipe(
			Effect.repeat({ schedule: Schedule.spaced(every) }),
			Effect.forkScoped,
			Effect.asVoid,
		),
})
```

| Option   | What it does                                                                                      |
| -------- | ------------------------------------------------------------------------------------------------- |
| `name`   | A name for logs and the fork tree.                                                                |
| `config` | An Effect `Schema`. The input is decoded with it before `apply` runs. Leave it out for no config. |
| `inject` | The services the plugin needs. See [Dependencies](#dependencies).                                 |
| `apply`  | Starts the plugin. It runs inside the fork's `Scope`.                                             |
| `retry`  | A `Schedule` for restarting the plugin after `apply` fails.                                       |

`apply` runs inside a `Scope` that stays open while the plugin is loaded. Use it
for everything the plugin owns: `Effect.acquireRelease` for resources,
`Effect.forkScoped` for background fibers, `Graft.plugin` for child plugins and
`Event.on` for event handlers. When the plugin is unloaded or restarted, Graft
closes the scope, which releases all of them in reverse order.

`apply` finishing means the plugin has started. A plugin that keeps working runs
that work in a fiber it forks into its scope, as `ticker` does. `apply` returns
nothing, or an [update function](#update-in-place), so `ticker` discards the
fiber with `Effect.asVoid`.

### Config decoding

The config schema can do anything a schema can, including decoding that is
asynchronous or needs services. Services that decoding needs must be listed in
`inject`, like any other dependency; the compiler checks this. When decoding
fails, the fork fails with the `SchemaError`.

## Dependencies

`inject` lists the services a plugin needs. The plugin starts only when all of
them exist, and stops before any of them goes away.

```ts
const report = Plugin.make({
	name: "report",
	inject: [Database, Plugin.optional(Cache)],
	apply: () =>
		Effect.gen(function* () {
			const database = yield* Database
			const cache = yield* Effect.serviceOption(Cache)
			// ...
		}),
})
```

- A **required** dependency, such as `Database`, can be read with `yield*`.
  Reading a service that is not in `inject` is a type error, so you cannot
  forget to declare one.
- An **optional** dependency, `Plugin.optional(Cache)`, does not hold the plugin
  back. Read it with `Effect.serviceOption`. The plugin restarts when the
  service appears or goes away, so it always sees the current state.

While its required services are missing, a fork is `Pending`. See
[Lifecycle](../lifecycle/).

## Update in place

By default, a new configuration restarts the plugin: Graft closes the old scope
and runs `apply` again. To keep running instead, `apply` can return an update
function. It receives each new configuration, and returns `true` if it applied
the change, or `false` to restart after all.

```ts
const server = Plugin.make({
	name: "server",
	config: Schema.Struct({ port: Schema.Int, banner: Schema.String }),
	apply: (config) =>
		Effect.gen(function* () {
			const banner = yield* Ref.make(config.banner)
			yield* startServer(config.port, banner)
			return (next) =>
				next.port === config.port
					? Effect.as(Ref.set(banner, next.banner), true)
					: Effect.succeed(false)
		}),
})
```

The update function is a closure, so it can use anything `apply` created, such
as `banner` here.

## Failures and retries

If `apply` fails, the fork becomes `Failed` with the full `Cause`, everything
the plugin had acquired is released, and the failure is logged. Then the fork
waits. It tries again when its configuration changes, when one of its
dependencies changes, or when its `retry` schedule fires:

```ts
const client = Plugin.make({
	name: "client",
	retry: Schedule.exponential("1 second"),
	apply: () => connect,
})
```

## Plugins from services and layers

Two shorthands cover plugins that only publish services.

`Plugin.service` builds one service and publishes it:

```ts
const database = Plugin.service(Database, openDatabase, { name: "database" })
```

`Plugin.layer` builds an Effect `Layer` and publishes the services listed in
`provides`. The layer is built from scratch for each fork, and torn down with
it:

```ts
const storage = Plugin.layer(StorageLive, {
	name: "storage",
	inject: [Database],
	provides: [Storage, StorageAdmin],
})
```

## Plugin modules

The loader and the CLI import plugins from modules. A module exports its plugin
as the default export, or as an export named `plugin`. `Plugin.fromModule` reads
it the same way.

Importing a plugin module must not do anything except define the plugin. Graft
can only release what `apply` acquires, and [hot reload](../hot-reload/) imports
a module again for every change.
