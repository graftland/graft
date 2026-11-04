# Plugins, config, dependencies and lifecycle

## Plugin shape

cordis:

```ts
import type { Context } from "cordis"
import z from "schemastery"

export const name = "greeter"
export const inject = ["database"]
export const Config = z.object({ greeting: z.string() })

export function apply(ctx: Context, config: z.infer<typeof Config>) {
	ctx.on("message", (text) => ctx.database.save(`${config.greeting}, ${text}`))
	return () => ctx.logger.info("greeter stopped")
}
```

Graft:

```ts
import { Event, Plugin } from "@graftland/graft"
import { Effect, Schema } from "effect"
import { Database, Message } from "./tokens.ts"

export default Plugin.make({
	name: "greeter",
	config: Schema.Struct({ greeting: Schema.String }),
	inject: [Database],
	apply: ({ greeting }) =>
		Effect.gen(function* () {
			const database = yield* Database
			yield* Event.on(Message, (text) => database.save(`${greeting}, ${text}`))
			yield* Effect.addFinalizer(() => Effect.log("greeter stopped"))
		}),
})
```

- `name` is required. It shows up in logs (`graft.plugin`) and the fork tree.
- Module-level `name` / `inject` / `Config` exports become fields of one
  `Plugin.make` call. The plugin is the default export.
- A class plugin's constructor body and `[Service.init]` both become `apply`.
  Instance fields become local values in `apply`, captured by closures.

## Config

| cordis                                        | Graft                                                          |
| --------------------------------------------- | -------------------------------------------------------------- |
| `Config` (Schemastery or any Standard Schema) | `config: Schema.*` (Effect `Schema`)                           |
| Sync validation only                          | Decoding may be async and may use services listed in `inject`  |
| `ValidationError` thrown, fiber failed        | `Schema.SchemaError`; the fork is `Failed` until input changes |
| `Plugin.Transform` (`Config(s) => t`)         | `Schema.decodeTo` from the input schema to the config schema   |
| Defaults inside the schema                    | `Schema.withDecodingDefault` or optional keys                  |
| Secrets as plain strings                      | `Schema.RedactedFromValue(Schema.String)`                      |

`apply` receives the decoded config. The input type (what `Graft.plugin` and
config files pass) is the schema's encoded side.

## Dependencies

| cordis                                      | Graft                                                                                             |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `inject: ['db']`                            | `inject: [Database]`                                                                              |
| Runtime checks such as `if (ctx.get('db'))` | `inject: [Plugin.optional(Database)]`, read with `Effect.serviceOption(Database)`                 |
| `inject: { db: config }` (intercept config) | `Graft.plugin(child, input, { intercept: [...] })` on the consumer; see [isolation](isolation.md) |
| `@Inject('db')` on a class                  | The same `inject` array                                                                           |
| `@Inject('db')` on a method                 | A child `Graft.plugin` with its own `inject`, see below                                           |
| `ctx.inject(['db'], (ctx) => ...)`          | A child plugin with `inject: [Database]`                                                          |
| Reading `ctx.db` without declaring it       | A type error: add the key to `inject`                                                             |

A required dependency that is missing leaves the fork `Pending`. cordis has no
optional dependencies; code that probed for a service at run time becomes a
`Plugin.optional` entry, which restarts the plugin when the service appears or
goes away.

`ctx.inject(deps, callback)` and `@Inject` on methods are inline child plugins:

```ts
apply: () =>
	Effect.gen(function* () {
		// runs whenever Cache exists, stops when it goes away
		yield* Graft.plugin(
			Plugin.make({
				name: "greeter/cache-warmup",
				inject: [Cache],
				apply: () => Effect.flatMap(Cache, (cache) => cache.warm),
			}),
		)
	})
```

Define the inline plugin once at module level when it does not close over values
from `apply`; a new definition object per activation is a new plugin identity
for `Graft.replace`.

## Child plugins

`ctx.plugin(p, config)` inside a plugin → `yield* Graft.plugin(p, input)` inside
`apply`. The child belongs to the parent's `Scope` and stops when the parent
stops or restarts. `await ctx.plugin(...)` → `yield* fork.await`. Note that
`fork.await` settles on `Pending` too; to wait for `Active`, watch `fork.state`.

## Update in place

cordis restarts on config change unless an `internal/update` listener handles it
without calling `next()`. Graft restarts unless `apply` returns an update
function that answers `true`:

```ts
apply: (config) =>
	Effect.gen(function* () {
		const banner = yield* Ref.make(config.banner)
		yield* startServer(config.port, banner)
		return (next) =>
			next.port === config.port
				? Effect.as(Ref.set(banner, next.banner), true)
				: Effect.succeed(false)
	})
```

| cordis                                    | Graft                           |
| ----------------------------------------- | ------------------------------- |
| Listener returns without `next()`         | Update function returns `true`  |
| Listener calls `next()`                   | Update function returns `false` |
| `fiber.update(config)`                    | `fork.update(input)`            |
| `fiber.restart()` / `ctx.fiber.restart()` | `fork.restart`                  |
| `fiber.dispose()`                         | `fork.dispose`                  |

Graft keeps only the latest requested input; intermediate updates may be
skipped. Code that counted delivered updates must instead read current state.

## States and failures

| cordis `FiberState` | Graft `Fork` state | Notes                                    |
| ------------------- | ------------------ | ---------------------------------------- |
| `PENDING`           | `Pending`          | `missing` lists the absent keys.         |
| `LOADING`           | `Loading`          | Decoding config or running `apply`.      |
| `ACTIVE`            | `Active`           |                                          |
| `FAILED`            | `Failed`           | `cause` is the full `Cause`.             |
| `UNLOADING`         | —                  | Teardown is not a separate public state. |
| `DISPOSED`          | `Disposed`         | Final.                                   |

Recovery differs: a failed cordis fiber recovers only through `update()`. A
failed Graft fork retries when its config changes, when a dependency changes, or
when its `retry` schedule fires:

```ts
Plugin.make({
	name: "client",
	retry: Schedule.exponential("1 second"),
	apply: () => connect,
})
```

If the cordis plugin caught errors in `apply` and logged them to stay "up",
consider letting them fail the fork with a `retry` schedule instead, and ask the
user which behavior they want.

## Observing other plugins

| cordis                                         | Graft                                               |
| ---------------------------------------------- | --------------------------------------------------- |
| `internal/plugin`, `internal/status` listeners | `Graft.forks` stream (whole tree)                   |
| A fiber's own state                            | `fork.state` stream                                 |
| `ctx.registry` iteration                       | `Graft.forks`                                       |
| `registry.replace(old, next)`                  | `Graft.replace([[old, next]])`, atomic over a batch |

`Graft.replace` requires the same input type and an error type within the old
plugin's bound.
