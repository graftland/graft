# Plugins

## Define

```ts
import { Effect, Schedule, Schema } from "effect"

import { Plugin } from "@graftland/graft"

export default Plugin.make({
	name: "app/ticker",
	config: Schema.Struct({ every: Schema.Duration }),
	apply: ({ every }) =>
		Effect.log("tick").pipe(
			Effect.repeat({ schedule: Schedule.spaced(every) }),
			Plugin.fork,
			Effect.asVoid,
		),
})
```

| Option   | What it does                                                                |
| -------- | --------------------------------------------------------------------------- |
| `name`   | Shown in logs and the fork tree.                                            |
| `config` | A `Schema` that decodes the input before `apply`. Omit for no config.       |
| `inject` | The services the plugin reads. See [Dependencies](#dependencies).           |
| `apply`  | Starts the plugin, inside the fork's `Scope`. Startup ends when it returns. |
| `retry`  | A `Schedule` for trying again after `apply` or a task fails.                |

`apply` returns `void` or an [update function](#update-in-place). When it would
return something else, such as a fork handle, end it with `Effect.asVoid`.

## Config

The schema is the plugin's contract with whoever writes the config file.

| Need                             | Schema                                                                 |
| -------------------------------- | ---------------------------------------------------------------------- |
| A field with a default           | `Schema.Int.pipe(Schema.withDecodingDefaultKey(Effect.succeed(8080)))` |
| An optional field                | `Schema.optionalKey(Schema.String)`                                    |
| A secret that logs hide          | `Schema.RedactedFromValue(Schema.String)`                              |
| A number from an `!env` string   | `Schema.FiniteFromString`                                              |
| A duration such as `"5 seconds"` | `Schema.Duration`                                                      |
| A check (`port > 0`)             | `Schema.check(...)` on the field                                       |

- Decoding may be asynchronous or use services; list those services in `inject`.
- A decoding failure fails the fork with `SchemaError` until the input changes.
- `!env` gives strings; the schema decides what they become.

## Dependencies

```ts
const report = Plugin.make({
	name: "app/report",
	inject: [Database, Plugin.optional(Cache)],
	apply: () =>
		Effect.gen(function* () {
			const database = yield* Database
			const cache = yield* Effect.serviceOption(Cache)
			// ...
		}),
})
```

| Kind     | Declared as              | Read with              | When missing                                           |
| -------- | ------------------------ | ---------------------- | ------------------------------------------------------ |
| Required | `Database`               | `yield* Database`      | The fork waits in `Pending`.                           |
| Optional | `Plugin.optional(Cache)` | `Effect.serviceOption` | The plugin starts anyway; it restarts when it changes. |

The fork restarts whenever an injected service is withdrawn or replaced, so the
code inside `apply` always sees the current value and never checks for it.

## Child plugins

`Graft.plugin(plugin, input, options)` inside `apply` loads a child. Children
stop when the parent stops or restarts, in reverse order of loading. Options are
`isolate` and `intercept`: [realms](realms.md).

```ts
const app = Plugin.make({
	name: "app/app",
	apply: () =>
		Effect.gen(function* () {
			const fork = yield* Graft.plugin(greeter, { greeting: "Hello" })
			yield* fork.await
		}),
})
```

The fork handle: `id`, `state` (a stream), `await` (until not `Loading`; fails
if `Failed`), `stable` (whole subtree not `Loading`), `update(input)`,
`restart`, `dispose`.

## Update in place

A new input restarts the plugin by default. To keep it running, return an update
function from `apply`: `true` means applied, `false` means restart.

```ts
const server = Plugin.make({
	name: "app/server",
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

- The function receives decoded input, and closes over what `apply` created.
- Only the latest requested input is applied; intermediate inputs may be
  skipped.
- Resources it acquires belong to the activation scope.

## Failures and retries

If `apply` or a `Plugin.fork` task fails, the fork becomes `Failed` with the
full `Cause`, its resources are released, and it tries again when its config or
dependencies change, or its `retry` schedule fires:

```ts
const client = Plugin.make({
	name: "app/client",
	retry: Schedule.exponential("1 second"),
	apply: () => connect,
})
```

Pure interruption is not a failure. Without `retry`, a failed fork waits for a
change.

Typed errors from `apply`, tasks and decoding join the plugin's error type and
`fork.await`. A helper typed as returning plain `Effect` may drop the
`Plugin.Tasks<E>` requirement that carries task errors; let TypeScript infer
helper types, or keep that requirement.

## Shorthands

```ts
const database = Plugin.service(Database, openDatabase, { name: "database" })

const storage = Plugin.layer(StorageLive, {
	name: "app/storage",
	inject: [Database],
	provides: [Storage, StorageAdmin],
})
```

`openDatabase` is an Effect that builds the service and may acquire scoped
resources. `Plugin.layer` builds the layer afresh for each fork and tears it
down with the fork.

## Replace a plugin

`Graft.replace([[v1, v2]])` restarts every fork of `v1` with `v2` in one
transaction. The input type must match exactly and the errors must be a subset.
A plugin's identity is its definition object: `{ ...plugin }` is a different
plugin. Hot reload uses `replace`.

## Publish a plugin package

- Name it `graft-plugin-<name>` or `@scope/graft-plugin-<name>`; a config entry
  `name: <name>` finds `graft-plugin-<name>`.
- Make the plugin the package's default export (or `plugin`), and export the
  tokens consumers need from the same package or a separate entry point.
- Ship ECMAScript modules; CommonJS and native dependencies block hot reload.
- List `@graftland/graft` and `effect` under `peerDependencies`, so the app
  keeps one copy of each.
- Export the config's editor registration as `./schema` (an `entries()`
  function, importing only the tokens), so `graft schema` checks entries in
  applications' editors.
- Document the config schema and the service key strings, since `graft.yml`
  users write them by hand.
