---
title: Plugins
description: Define plugins with Plugin.make, Plugin.service and Plugin.layer.
---

A plugin is a value that describes how to start something. Loading a plugin
creates a **fork**. A fork is one running instance, with its own configuration
and its own `Scope`. If you load the same plugin twice, you get two independent
forks.

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
			Plugin.fork,
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
| `retry`  | A `Schedule` for restarting after `apply` or a supervised task fails.                             |

`apply` runs inside a `Scope` that stays open while the plugin is loaded. Use
`Effect.acquireRelease` for resources, `Plugin.fork` for background tasks,
`Graft.plugin` for child plugins, and `Event.on` for event handlers.

`Plugin.fork(effect)` returns the task's fiber. The activation keeps the fiber
in a `FiberSet`, even if the caller drops the handle with `Effect.asVoid`. When
`apply` finishes, startup is complete. The task may keep running. A task
inherits the launch context, so it can use the dependencies declared in
`inject`. Each task has its own `Scope`. Resources that the task acquires are
released when it finishes or is cancelled, even if it was launched from a scope
that lives for a shorter time.

An unhandled task failure or defect fails the whole activation. This is true
even while `apply` is still loading or an in-place update is running. Graft
first stops `apply`, closes publication and withdraws services. Then it drains
the consumers, and healthy tasks keep serving them. Only after draining does it
stop the remaining tasks, wait for their cleanup, and close the activation's
resources. Graft keeps the full cause of task failures and cancellation defects,
and logs them. A task that is only interrupted does not fail the plugin. The
plugin's usual `retry` schedule applies, and every attempt gets a fresh task
group. Sometimes an update or a disposal happens before Graft handles the
failure. Graft still logs the failure while it cleans up the old activation.

Errors from tasks become part of the plugin's error type and of `fork.await`.
This includes tasks that are started from update callbacks, services, layers, or
other tasks. `Plugin.Tasks<E>` carries this requirement until the plugin
definition is made. Helper functions with type annotations must keep it. If an
error is recoverable, catch it **inside** the task, before you pass the task to
`Plugin.fork`. Catching the error of the launch effect does not undo
supervision. Joining the returned fiber and catching its error does not undo it
either.

A bare `Effect.forkScoped` controls how long a fiber lives, but it does not
report the fiber's failures to Graft. Use `Plugin.fork` for plugin work. If you
choose to use a raw fiber, you must watch its complete `Exit` or `Cause`
yourself.

### Config decoding

The config schema can do anything that a schema can do. This includes decoding
that is asynchronous or needs services. List the services that decoding needs in
`inject`, like any other dependency. The compiler checks this. If decoding
fails, the fork fails with the `SchemaError`.

## Dependencies

`inject` lists the services a plugin needs. The plugin starts only when all of
them exist. It stops before any of them goes away.

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
and runs `apply` again. To keep the plugin running instead, `apply` can return
an update function. The function receives the configuration selected by the
supervisor. It returns `true` if it applied the change, or `false` to ask for a
restart.

Updates keep only the latest requested configuration; they are not queued for
individual delivery. Concurrent requests can skip intermediate configurations
entirely. A superseded `fork.update` also succeeds, even if its input was never
passed to the callback and the latest configuration has not yet been applied.

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

Decoding and applying an update form one cancellable operation. A later config
or dependency change cancels it and waits for its cleanup before teardown.
Ordinary update failures are logged with their full Cause before restarting;
failures collected during unloading are also included in `CleanupError.cause`.
Resources acquired by an update still belong to the activation scope.

## Failures and retries

If `apply` or a supervised task fails, the fork becomes `Failed` with the full
`Cause`. Graft releases everything the plugin had acquired, and logs the
failure. Then the fork waits. It tries again when its configuration changes,
when one of its dependencies changes, or when its `retry` schedule fires:

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
`provides`. Graft builds the layer from scratch for each fork, and tears it down
with the fork:

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

Importing a plugin module must do nothing except define the plugin. Graft can
release only what `apply` acquires. Also, automatic [hot reload](../hot-reload/)
reimports modules affected by a change; public `hmr.reload` forces a full
reload.
