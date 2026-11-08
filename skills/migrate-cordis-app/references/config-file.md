# From `cordis.yml` to `graft.yml`

Both files are a YAML list of entries with the same field names, so most entries
carry over line by line. The work is in names, keys and `!!js` tags.

## Entry fields

| Field       | cordis                          | Graft                                                                                                                                                                                                 |
| ----------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`        | Entry id                        | Same. Keep existing ids so identity survives edits.                                                                                                                                                   |
| `name`      | Plugin module                   | Plugin module: `./path`, `/abs/path`, `@scope/pkg`, or a short name tried as written, then as `@graftland/plugin-<name>` and `graft-plugin-<name>` (both installed fails with `AmbiguousPluginName`). |
| `config`    | Plugin config                   | Plugin input, decoded by the plugin's Effect `Schema`. Adapt to the Graft plugin's schema.                                                                                                            |
| `disabled`  | Boolean or `!!js` expression    | Boolean only.                                                                                                                                                                                         |
| `group`     | Group of entries                | Same; children go in `config`.                                                                                                                                                                        |
| `inject`    | Service names to wait for       | Service **key strings** to wait for. Embedded loader only.                                                                                                                                            |
| `isolate`   | `{ name: true \| label }`       | `{ "<key string>": true \| label }`. Embedded loader only.                                                                                                                                            |
| `intercept` | `{ name: config }`, any service | Only references the host registered; the CLI registers `effect/References/CurrentLogAnnotations` and `effect/References/MinimumLogLevel`. Embedded loader only.                                       |

Fields Graft does not know (such as `note`) are kept as metadata.

`graft start` runs each entry in its own unit and rejects entries that use
`inject`, `isolate` or `intercept` with `DeploymentUnsupported`. Drop an
`inject` field when the plugin's own `inject` already lists the key. For
`isolate` and `intercept`, ask the user: drop the field, or embed the loader
([Embedding](#embedding)).

## Keys

cordis names services by `ctx` property (`database`). Graft names them by the
string their `Context.Service` class was created with
(`@acme/graft-plugin-db/Database`). For every key in `inject` and `isolate`:

1. Find the Graft plugin that publishes the service.
2. Copy its key string from the `Context.Service<...>()("...")` call or its
   docs.
3. Replace the cordis name.

Done when every key resolves to a service some entry publishes, or to an
environment service.

## `!!js` expressions

cordis evaluates `!!js` with the entry's context in scope. Graft config files
never run code. Translate by what the expression computes:

| Expression computes                       | Graft                                                                                                      |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| An environment variable (`process.env.X`) | `!env X`. Numbers and booleans: the plugin's schema decodes the string (`Schema.FiniteFromString`).        |
| A secret                                  | `!env X`, with `Schema.RedactedFromValue(Schema.String)` in the plugin's schema.                           |
| A default when a variable is missing      | A schema default in the plugin, or `Config.withDefault` read inside `apply`.                               |
| `disabled` from an environment check      | Separate config files per environment, or an `!env` value the plugin itself reads to decide. Ask the user. |
| A value derived from a service on `ctx`   | Move the logic into the plugin: inject the service and compute it in `apply`.                              |
| Arbitrary code                            | No equivalent. Ask the user.                                                                               |

`!env` reads the variable when the entry is deployed; a missing variable fails
with `ConfigError`. `graft start --env-file .env` adds a `.env` file; the
process environment wins. Restart after changing either.

## Nested config files

An entry that loads `@cordisjs/plugin-include` with another file becomes a
`group: true` entry whose `config` holds that file's entries, merged into
`graft.yml`. If the user wants the files kept apart, ask before choosing a
layout: embedding the loader with several `Include.Include` forks is a host
change.

## Editor support

Run `graft schema` in the project to write `graft.schema.json`, which checks
entry fields and the config of every installed plugin that exports `./schema`.
Put the schema comment on the first line, and commit the file:

```yaml
# yaml-language-server: $schema=./graft.schema.json
```

For VS Code, declare the tag: `{ "yaml.customTags": ["!env scalar"] }`.

## Example

```yaml
# cordis.yml
- id: db
  name: "@acme/cordis-plugin-db"
  config:
    url: !!js process.env.DATABASE_URL
- id: api
  name: ./plugins/api.js
  inject: [database]
  isolate:
    database: staging
  disabled: !!js process.env.NODE_ENV === 'test'
- id: hmr
  name: "@cordisjs/plugin-hmr"
```

```yaml
# graft.yml
- id: db
  name: "@acme/graft-plugin-db"
  config:
    url: !env DATABASE_URL
- id: api
  name: ./plugins/api.mjs
# hmr: removed; run `graft start --watch` in development
# api.inject: dropped; the plugin's own `inject` lists the database
# api.isolate: needs the user's decision (see Entry fields)
# api.disabled: needs the user's decision (see `!!js` expressions)
```

## Embedding

A host that built `new Context()` and loaded the loader becomes an Effect
program:

```ts
import { Effect, Layer } from "effect"
import { NodeRuntime, NodeServices } from "@effect/platform-node"

import { Graft, Kernel } from "@graftland/graft"
import { Include, ModuleResolver } from "@graftland/loader"
import * as Control from "@graftland/plugin-remote/Control"
import * as Units from "@graftland/plugin-remote/Units"

// The resolver inspects built modules in disposable units through control.
const resolver = Layer.effect(
	ModuleResolver.ModuleResolver,
	Effect.flatMap(Control.serve(), (control) =>
		ModuleResolver.make({ base: process.cwd(), control }),
	),
).pipe(
	Layer.provide(
		Kernel.layer({ authority: "app", maxUnits: 16, instances: [] }).pipe(
			Layer.provide(Units.layer),
			Layer.provideMerge(NodeServices.layer),
		),
	),
)

Effect.gen(function* () {
	yield* Graft.plugin(Include.Include, { path: "graft.yml", watch: true })
	return yield* Effect.never
}).pipe(
	Effect.scoped,
	Effect.provide(
		Layer.provideMerge(
			Graft.layer,
			Layer.mergeAll(NodeServices.layer, resolver),
		),
	),
	NodeRuntime.runMain,
)
```

Services the host used to set on the root `ctx` go into the same environment as
Layers; every plugin can then inject them.
