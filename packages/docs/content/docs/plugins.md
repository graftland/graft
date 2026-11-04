---
title: Plugins
description: Define plugins with Plugin.make, Plugin.service and Plugin.layer.
---

A plugin is a value that describes how to start something. Loading a plugin
creates a **fork**: one running instance with its own configuration and its own
`Scope`. Load the same plugin twice and you get two independent forks.

| Term       | Meaning                                                         |
| ---------- | --------------------------------------------------------------- |
| **Plugin** | The definition. It is a value; nothing runs until it is loaded. |
| **Fork**   | One running instance of a plugin.                               |
| **Scope**  | Owns the fork's resources. Closing it releases them.            |

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

### Options

| Option   | What it does                                                                                      |
| -------- | ------------------------------------------------------------------------------------------------- |
| `name`   | A name for logs and the fork tree.                                                                |
| `config` | An Effect `Schema`. The input is decoded with it before `apply` runs. Leave it out for no config. |
| `inject` | The services the plugin needs. See [Dependencies](#dependencies).                                 |
| `apply`  | Starts the plugin. It runs inside the fork's `Scope`.                                             |
| `retry`  | A `Schedule` for restarting after `apply` or a supervised task fails.                             |

### What to use inside `apply`

`apply` runs in a `Scope` that stays open while the plugin is loaded. Put each
kind of work in the tool that owns it:

| You need               | Use                     |
| ---------------------- | ----------------------- |
| A resource to clean up | `Effect.acquireRelease` |
| Background work        | `Plugin.fork`           |
| A child plugin         | `Graft.plugin`          |
| An event handler       | `Event.on`              |

### Background tasks

`Plugin.fork(effect)` starts a supervised task and returns its fiber.

- **Ownership.** The activation keeps the fiber in a `FiberSet`, even if the
  caller drops the handle with `Effect.asVoid`.
- **Startup.** When `apply` finishes, startup is complete. The task may keep
  running.
- **Context.** A task inherits the launch context, so it can use the
  dependencies declared in `inject`.
- **Resources.** Each task has its own `Scope`. Resources it acquires are
  released when it finishes or is cancelled, even if it was launched from a
  scope that lives for a shorter time.

### When a task fails

An unhandled task failure or defect fails the whole activation, even while
`apply` is still loading or an in-place update is running. Graft tears down in
this order:

1. Stop `apply`, close publication and withdraw services.
2. Drain the consumers. Healthy tasks keep serving them.
3. Stop the remaining tasks and wait for their cleanup.
4. Close the activation's resources.

Failure details:

- **The cause is kept.** Graft logs the full cause of task failures and
  cancellation defects.
- **Interruption is not failure.** A task that is only interrupted does not fail
  the plugin.
- **Retries start clean.** The plugin's `retry` schedule applies, and every
  attempt gets a fresh task group.
- **Fast teardown.** If an update or a disposal happens before Graft handles the
  failure, Graft still logs it while it cleans up the old activation.

### Task errors in types

Errors from tasks become part of the plugin's error type and of `fork.await`.
This includes tasks started from update callbacks, services, layers, or other
tasks. `Plugin.Tasks<E>` carries this requirement until the plugin definition is
made, so helper functions with type annotations must keep it.

:::caution

To recover from an error, catch it **inside** the task, before you pass the task
to `Plugin.fork`. Neither of these undoes supervision:

- Catching the error of the launch effect.
- Joining the returned fiber and catching its error.

:::

A bare `Effect.forkScoped` controls how long a fiber lives, but it does not
report the fiber's failures to Graft. Use `Plugin.fork` for plugin work. With a
raw fiber, you must watch its complete `Exit` or `Cause` yourself.

### Config decoding

The config schema can do anything a schema can do, including decoding that is
asynchronous or needs services.

- List the services that decoding needs in `inject`, like any other dependency.
  The compiler checks this.
- If decoding fails, the fork fails with the `SchemaError`.

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

| Kind         | Declared as              | Read with              | When the service is missing                             |
| ------------ | ------------------------ | ---------------------- | ------------------------------------------------------- |
| **Required** | `Database`               | `yield* Database`      | The fork waits in `Pending`.                            |
| **Optional** | `Plugin.optional(Cache)` | `Effect.serviceOption` | The plugin starts anyway, and restarts when it changes. |

- Reading a service that is not in `inject` is a type error, so you cannot
  forget to declare one.
- An optional dependency restarts the plugin when the service appears or goes
  away, so the plugin always sees the current state.

While its required services are missing, a fork is `Pending`. See
[Lifecycle](../lifecycle/).

## Update in place

By default, a new configuration restarts the plugin: Graft closes the old scope
and runs `apply` again. To keep the plugin running instead, `apply` can return
an update function.

| The update function…                            | Means                       |
| ----------------------------------------------- | --------------------------- |
| Receives the configuration the supervisor chose | —                           |
| Returns `true`                                  | The change was applied.     |
| Returns `false`                                 | Restart the plugin instead. |

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

:::note

Updates keep only the latest requested configuration; they are not queued for
individual delivery. Concurrent requests can skip intermediate configurations
entirely. A superseded `fork.update` also succeeds, even if its input never
reached the callback.

:::

Decoding and applying an update form one cancellable operation:

- A later config or dependency change cancels it and waits for its cleanup
  before teardown.
- Ordinary update failures are logged with their full `Cause` before restarting.
  Failures collected during unloading are also included in `CleanupError.cause`.
- Resources acquired by an update still belong to the activation scope.

## Failures and retries

If `apply` or a supervised task fails, the fork becomes `Failed` with the full
`Cause`. Graft releases everything the plugin had acquired and logs the failure.
Then the fork waits. It tries again when any of these happens:

- Its configuration changes.
- One of its dependencies changes.
- Its `retry` schedule fires.

```ts
const client = Plugin.make({
	name: "client",
	retry: Schedule.exponential("1 second"),
	apply: () => connect,
})
```

## Plugins from services and layers

Two shorthands cover plugins that only publish services.

| Shorthand        | Builds            | Publishes                          |
| ---------------- | ----------------- | ---------------------------------- |
| `Plugin.service` | One service       | That service.                      |
| `Plugin.layer`   | An Effect `Layer` | The services listed in `provides`. |

```ts
const database = Plugin.service(Database, openDatabase, { name: "database" })
```

`Plugin.layer` builds the layer from scratch for each fork and tears it down
with the fork:

```ts
const storage = Plugin.layer(StorageLive, {
	name: "storage",
	inject: [Database],
	provides: [Storage, StorageAdmin],
})
```

## Plugin modules

The loader and the CLI import plugins from modules.

- **Export.** A module exports its plugin as the default export, or as an export
  named `plugin`. `Plugin.fromModule` reads it the same way.
- **No side effects.** Importing a plugin module must do nothing except define
  the plugin. Graft can release only what `apply` acquires.
- **Reloading.** Automatic [hot reload](../hot-reload/) reimports modules
  affected by a change. Public `hmr.reload` forces a full reload.
