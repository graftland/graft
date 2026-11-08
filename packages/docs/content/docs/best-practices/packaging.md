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
	name: "graft-plugin-postgres",
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

| Export       | Holds                                                                  | Imported by                                                                                  |
| ------------ | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `.`          | The plugin, as the default export or as an export named `plugin`.      | The loader, for `name:` in `graft.yml`.                                                      |
| `./tokens`   | Service keys, events, references, tagged errors and the config schema. | Consumer plugins, tests, and other packages that implement the same service.                 |
| `./<plugin>` | A further plugin, one per module.                                      | Entries such as `name: postgres/migrations`.                                                 |
| `./contract` | A [Remote contract](../../remote/contracts/).                          | Native units.                                                                                |
| `./schema`   | The [editor registration](#editor-completion) of the config.           | [`graft schema`](../../cli/#graft-schema), for the application's editor schema.              |
| `./cli`      | A command plugin that adds `graft` subcommands.                        | [`graft add --plugin <package>`](../../cli/#command-plugins), which enables `<package>/cli`. |

| Rule                                                    | Pitfall it avoids                                                                                                                       |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `./tokens` imports no implementation.                   | A plugin that only injects `Database`, or a test that fakes it, would load your driver and its dependencies.                            |
| One plugin per module.                                  | The loader takes one plugin from a module: the default export, or else `plugin`. Other exported plugins cannot be named in `graft.yml`. |
| Deployment configuration identifies the implementation. | Contracts contain protocol declarations only.                                                                                           |

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

| Package                                                           | List under                                 | Why                                                                                                                                                                          |
| ----------------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `effect`, `@graftland/graft`                                      | `peerDependencies` and `devDependencies`   | The application must have [one copy of each](../../plugins/#publish-a-plugin). Under `dependencies`, a range that the application's copy does not satisfy installs a second. |
| `@graftland/loader`, `@graftland/cli`, `@graftland/plugin-remote` | The same, only if your modules import them | They are released together with `@graftland/graft` and pin it, so give them the same range.                                                                                  |
| Everything else, such as drivers and clients                      | `dependencies`                             | They are private to your package.                                                                                                                                            |

## Write modules that load and reload

Native units import captured, built plugin modules. Keep imports free of I/O;
acquire resources in plugin effects.

| Rule                                                 | Pitfall it avoids                                                                                                                                            |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Read settings from `config`, not from `process.env`. | Users cannot see or set them in `graft.yml`. [`--env-file` values](../../cli/#env-files) never reach `process.env`, and a refresh does not read yours again. |

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
- A short name is tried as written first. Graft moves on to the conventions when
  that module does not exist, or when it imports but exports no plugin, such as
  Node's `http` or your `postgres` driver. Any other import failure stops
  resolution with `ModuleInvalid`.
- Show the full package name in your README's `graft.yml` example. It cannot
  resolve to another package.
- `graft add --plugin` keeps a name that starts with `@` or `graft-plugin-`. It
  turns any other name into whichever of `@graftland/plugin-<name>` and
  `graft-plugin-<name>` the registry has, and fails if it has both. A package
  with a `./cli` export needs one of those forms.

## Name the plugin

The plugin's `name` labels it in logs, spans and the fork tree. Build it the way
Effect's `deterministicKeys` diagnostic builds service keys, so the name says
which module defines the plugin:

| Part | Value                                                                                                                       |
| ---- | --------------------------------------------------------------------------------------------------------------------------- |
| 1    | The package name.                                                                                                           |
| 2    | The module's path under `src/`, without the extension. `index` is left out.                                                 |
| 3    | The binding that holds the plugin. Left out for the default export, an export named `plugin`, or one named like the module. |

| Plugin                                    | `name`                                    |
| ----------------------------------------- | ----------------------------------------- |
| The default export of `src/index.ts`      | `graft-plugin-postgres`                   |
| The default export of `src/migrations.ts` | `graft-plugin-postgres/migrations`        |
| `const warmup` in `src/migrations.ts`     | `graft-plugin-postgres/migrations/warmup` |

Graft does not check the name. An application names its own plugins the same
way, from its `package.json` name.

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

| Range                | Rule                                                                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@graftland/*` peers | While Graft is 0.x, [any release may change the API](../../releases/#release-a-version). `^0.4.0` accepts only 0.4.x; widen it after you test the next minor. |
| `effect` peer        | Use the range that the `@graftland/graft` versions you support declare, such as `4.1.*`.                                                                      |
| `devDependencies`    | Exact versions inside your peer ranges, so your tests run against a release you claim.                                                                        |
| Your own version     | A breaking config or key change, as above, is a new major.                                                                                                    |

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

## Author an independent integration

| Package        | Public declarations                                                                                 |
| -------------- | --------------------------------------------------------------------------------------------------- |
| Contract       | Service key, RPC schemas and `Contract.operation(name, version, rpc)`; no implementation locations. |
| Implementation | `Plugin.make({ provides, overlap })`, ordinary `apply`, and `Plugin.probe("health", effect)`.       |
| Host           | Installs the contract, captures the built implementation, and supplies deployment configuration.    |

Declare Effect and shared Graft packages as peers. Probes run only when
requested in a serving attempt. Capture the built package directory before
deployment; external runtime dependencies are not captured or pinned. The
[integration-gateway sample](https://github.com/graftland/graft/tree/main/samples/integration-gateway)
packs and installs separate contract and implementation packages.

## Publish a manifest

Generate the [plugin manifest](../../ecosystem/manifest/) from the built
package, then verify it before packing. Service identities come from `inject`,
`provides` and contract descriptors; runtime ranges come from package metadata.
Keep placement capabilities explicit and trust in operator policy.

Run the [conformance kit](../../ecosystem/conformance/) on the installed tarball
and the [compatibility check](../../ecosystem/compatibility/) against each host
you claim to support. First-party packages follow the same checks. The
[plugin author fixtures](https://github.com/graftland/graft/tree/main/samples/plugin-authors)
exercise this workflow without workspace aliases or private imports.
