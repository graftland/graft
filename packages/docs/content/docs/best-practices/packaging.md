---
title: Plugin packages
description:
  Publish plugins as an npm package that applications load by name, build on and
  upgrade safely.
---

A **plugin package** is an npm package whose modules export plugins.
Applications install it, load it by name from `graft.yml` or import it from
code, and write their own plugins against the services and events it declares.
Start from the `plugin` template and its three rules in
[Publish a plugin](../../plugins/#publish-a-plugin); this page covers the rest.

## Lay out the package

Keep the tokens that consumers build on apart from the plugin that runs.
[Declare tokens in a shared module](../design/#declare-tokens-in-a-shared-module)
says what goes in them.

```ts title="src/tokens.ts"
import { Context, Effect, Schema } from "effect"

export class Database extends Context.Service<
	Database,
	{ readonly query: (sql: string) => Effect.Effect<ReadonlyArray<unknown>> }
>()("graft-plugin-postgres/Database") {}

export const Config = Schema.Struct({
	url: Schema.RedactedFromValue(Schema.String),
	poolSize: Schema.Int.pipe(Schema.withDecodingDefaultKey(Effect.succeed(10))),
})
```

```ts title="src/index.ts"
import { Effect, Redacted } from "effect"

import { Graft, Plugin } from "@graftland/graft"

import { Config, Database } from "./tokens.js"

declare const openPool: (
	url: Redacted.Redacted<string>,
	size: number,
) => Effect.Effect<{
	readonly query: (sql: string) => Effect.Effect<ReadonlyArray<unknown>>
	readonly close: Effect.Effect<void>
}>

export default Plugin.make({
	name: "postgres",
	config: Config,
	apply: ({ url, poolSize }) =>
		Effect.gen(function* () {
			const pool = yield* Effect.acquireRelease(
				openPool(url, poolSize),
				(pool) => pool.close,
			)
			yield* Graft.provide(Database, { query: pool.query })
		}),
})
```

Expose each part as its own entry point:

| Export       | Holds                                                                  | Imported by                                                                                    |
| ------------ | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `.`          | The plugin, as the default export or as an export named `plugin`.      | The loader, for `name:` in `graft.yml`.                                                        |
| `./tokens`   | Service keys, events, references, tagged errors and the config schema. | Consumer plugins, tests, and other packages that implement the same service.                   |
| `./<plugin>` | A further plugin, one per module.                                      | Entries such as `name: postgres/migrations`.                                                   |
| `./contract` | A [Remote contract](../../remote/hosts/#define-a-contract).            | Hosts and [runners](../../remote/runners/#set-up-a-runner), when the plugin can run elsewhere. |
| `./schema`   | The [editor registration](#editor-completion) of the config.           | [`graft schema`](../../cli/#graft-schema), for the application's editor schema.                |
| `./cli`      | A command plugin that adds `graft` subcommands.                        | [`graft add --plugin <package>`](../../cli/#command-plugins), which enables `<package>/cli`.   |

| Rule                                                 | Pitfall it avoids                                                                                                                       |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `./tokens` imports no implementation.                | A plugin that only injects `Database`, or a test that fakes it, would load your driver and its dependencies.                            |
| One plugin per module.                               | The loader takes one plugin from a module: the default export, or else `plugin`. Other exported plugins cannot be named in `graft.yml`. |
| A contract names the implementation by `module` URL. | Importing the implementation from the contract would load it on the host too, not only in the plugin process.                           |

## Declare dependencies

```json title="package.json"
{
	"name": "graft-plugin-postgres",
	"version": "1.0.0",
	"type": "module",
	"sideEffects": false,
	"engines": { "node": ">=22.19.0" },
	"exports": {
		".": "./dist/index.js",
		"./tokens": "./dist/tokens.js",
		"./schema": "./dist/schema.js"
	},
	"peerDependencies": {
		"@graftland/graft": "^0.4.0",
		"effect": "4.1.*"
	},
	"devDependencies": {
		"@graftland/graft": "0.4.1",
		"effect": "4.1.2"
	},
	"dependencies": {
		"postgres": "^3.4.0"
	}
}
```

| Package                                                           | List under                                 | Why                                                                                                                                                                                     |
| ----------------------------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `effect`, `@graftland/graft`                                      | `peerDependencies` and `devDependencies`   | The application must have [one copy of each](../../hot-reload/#rules-for-plugin-modules). Under `dependencies`, a range that the application's copy does not satisfy installs a second. |
| `@graftland/loader`, `@graftland/cli`, `@graftland/plugin-remote` | The same, only if your modules import them | They are released together with `@graftland/graft` and pin it, so give them the same range.                                                                                             |
| Everything else, such as drivers and clients                      | `dependencies`                             | They are private to your package.                                                                                                                                                       |

## Write modules that load and reload

Applications import your plugin module when an entry loads it, and again on hot
reload under `graft start --watch`. Every file of the package follows the
[rules for plugin modules](../../hot-reload/#rules-for-plugin-modules) and
[acquires in `apply`, not on import](../effect/#describe-on-import-acquire-in-apply).
A package breaks these most often:

| Rule                                                                                             | Pitfall it avoids                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ship ESM, and keep CommonJS and native-addon dependencies out of what the plugin module imports. | A CommonJS or native dependency reachable from the entry makes hot reload report `Skipped` / `restart-required` (see [When a reload does not apply](../../hot-reload/#when-a-reload-does-not-apply)). Accept a restart for such a dependency, or run the plugin under [Remote](../../remote/overview/). |
| Keep `node:module` and `module`, even `createRequire`, out of the plugin module.                 | Such an import puts the whole graph [out of hot reload](../../hot-reload/#when-a-reload-does-not-apply) until the process restarts.                                                                                                                                                                     |
| Read settings from `config`, not from `process.env`.                                             | Users cannot see or set them in `graft.yml`. [`--env-file` values](../../cli/#env-files) never reach `process.env`, and `loader.retry` does not read yours again.                                                                                                                                       |

## Treat config and keys as public API

Users write your config fields in `graft.yml`, and your key strings in
[`inject` and `isolate`](../../config-file/#rules), so changing either breaks
their files.

| Write                                                          | So that                                                                                     |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| A default with `Schema.withDecodingDefaultKey`                 | An entry can leave the field out.                                                           |
| Secrets as `Schema.RedactedFromValue(Schema.String)`           | Logs hide the value, and users pass it with [`!env`](../../config-file/#types-and-secrets). |
| Schemas that decode strings where a value may come from `!env` | `!env` gives a string; `Schema.NumberFromString`, for example, turns it into a number.      |
| Config that encodes as JSON                                    | The plugin can run under [Remote](../../remote/overview/).                                  |

What a change does to existing entries:

| Change                                   | Existing entries                                                                   |
| ---------------------------------------- | ---------------------------------------------------------------------------------- |
| Add a field with a default               | Keep working.                                                                      |
| Add a required field, or tighten a check | Fail with `SchemaError`, and stay `Failed` until their config changes.             |
| Remove a field                           | Keep working. Decoding drops unknown fields without an error.                      |
| Rename a field                           | The old value is dropped silently. With a default on the new field, nothing fails. |
| Change a service, event or reference key | Consumers and `graft.yml` keys no longer match. Required consumers stay `Pending`. |

Release a new required field, a tighter check, a rename or a key change as a new
major version, and say in the changelog what users must edit.

## Choose the package name

Short names in `graft.yml` find unscoped packages named `graft-plugin-<name>`:

| Package                                   | Users write                                       |
| ----------------------------------------- | ------------------------------------------------- |
| `graft-plugin-postgres`                   | `name: postgres` or `name: graft-plugin-postgres` |
| The `./migrations` export of that package | `name: postgres/migrations`                       |
| `@acme/graft-plugin-postgres`             | `name: "@acme/graft-plugin-postgres"`, in full    |

- An application resolves [plugin names](../../config-file/#plugin-names) from
  its own directory, so it must depend on your package, for example through
  `graft add`.
- A short name is tried as written first, and Graft moves on to the next
  candidate only when one does not exist. If the application can resolve a
  package named `postgres`, such as your driver, `name: postgres` and
  `name: postgres/migrations` fail with `ModuleInvalid`.
- Show the full package name in your README's `graft.yml` example. It cannot
  resolve to another package.
- `graft add --plugin` keeps a name that starts with `@` or `graft-plugin-`, and
  turns any other name into `@graftland/plugin-<name>`. A package with a `./cli`
  export needs one of those two forms.

## Editor completion

The editor schema of `graft.yml` leaves plugin config open. Export a
registration, so that applications can check your entries:

```ts title="src/schema.ts"
import { JsonSchema, Schema } from "effect"

import { Config } from "./tokens.js"

export const entries = () => [
	{
		names: ["postgres", "graft-plugin-postgres"],
		schema: JsonSchema.toDocumentDraft07(
			Schema.toJsonSchemaDocument(Config, {
				referencePolicy: () => undefined,
				onExcessProperty: "error",
			}),
		).schema,
		required: true,
	},
]
```

| Field      | Rule                                                                                                                                                                                                                          |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `names`    | Every `name` users may write for this plugin, short and full.                                                                                                                                                                 |
| `schema`   | The encoded side of the config schema. `referencePolicy: () => undefined` inlines definitions, which would otherwise be lost. `onExcessProperty: "error"` flags unknown fields, which decoding would otherwise drop silently. |
| `required` | `true` when the config has required fields, so an entry without `config` is flagged.                                                                                                                                          |

Import only the tokens module here: generating a schema must not load the
plugin. [`graft schema`](../../cli/#graft-schema) finds the module through the
`./schema` export and the `@graftland/graft` peer dependency.

## Support Graft versions

| Range                | Rule                                                                                                                                                             |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@graftland/*` peers | While Graft is 0.x, [any release may change the API](../../releases/#release-a-version). `^0.4.0` accepts only 0.4.x; widen it after you test the next minor.    |
| `effect` peer        | Use the range that the `@graftland/graft` versions you support declare, such as `4.1.*`.                                                                         |
| `devDependencies`    | Exact versions inside your peer ranges, so your tests run against a release you claim.                                                                           |
| Your own version     | A breaking config or key change, as above, is a new major. A host can require your version on a runner with [`connect.expect`](../../remote/runners/#instances). |

## Try the package in an application

For automated tests, see [Testing](../testing/). To try the package as users
will:

1. **Pack** it with `npm pack`.
2. **Create** an application with
   [`graft create playground`](../../cli/#graft-create). It already depends on
   `@graftland/graft`, `@graftland/cli` and `effect`, which satisfy your peers.
3. **Install** the packed tarball with the application's package manager.
4. **Add** an entry with the name from your README, and run `graft start`.

:::caution

Install the tarball, not a linked directory. A linked package resolves `effect`
and `@graftland/graft` from its own `node_modules`, where your `devDependencies`
live, so the application gets a second copy of each.

:::
