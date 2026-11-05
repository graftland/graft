# From `cordis.yml` to `graft.yml`

Both files are a YAML list of entries with the same field names, so most entries
carry over line by line. The work is in names, keys and `!!js` tags.

## Entry fields

| Field       | cordis                          | Graft                                                                                                                                              |
| ----------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`        | Entry id                        | Same. Keep existing ids so identity survives edits.                                                                                                |
| `name`      | Plugin module                   | Plugin module: `./path`, `/abs/path`, `@scope/pkg`, or a short name tried as written, then `@graftland/plugin-<name>`, then `graft-plugin-<name>`. |
| `config`    | Plugin config                   | Plugin input, decoded by the plugin's Effect `Schema`. Adapt to the Graft plugin's schema.                                                         |
| `disabled`  | Boolean or `!!js` expression    | Boolean only.                                                                                                                                      |
| `group`     | Group of entries                | Same; children go in `config`.                                                                                                                     |
| `inject`    | Service names to wait for       | Service **key strings** to wait for.                                                                                                               |
| `isolate`   | `{ name: true \| label }`       | `{ "<key string>": true \| label }`.                                                                                                               |
| `intercept` | `{ name: config }`, any service | Only references the host registered. `graft start` registers `effect/References/CurrentLogAnnotations` and `effect/References/MinimumLogLevel`.    |

Fields Graft does not know (such as `note`) are kept as metadata.

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

`!env` reads the variable when the entry loads; a missing variable fails only
that entry. `graft start --env-file .env` adds a `.env` file; the process
environment wins.

## Nested config files

An entry that loads `@cordisjs/plugin-include` with another file becomes a
`group: true` entry whose `config` holds that file's entries, merged into
`graft.yml`. If the user wants the files kept apart, ask before choosing a
layout: embedding the loader with several `Include.Include` forks is a host
change.

## Editor support

Put the schema comment on the first line, with the project's `@graftland/cli`
version:

```yaml
# yaml-language-server: $schema=https://cdn.jsdelivr.net/npm/@graftland/cli@<version>/schema.json
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
  inject: ["@acme/graft-plugin-db/Database"]
  isolate:
    "@acme/graft-plugin-db/Database": staging
# hmr: removed; run `graft start --watch` in development
# api.disabled: needs the user's decision (see `!!js` expressions)
```

## Embedding

A host that built `new Context()` and loaded the loader becomes an Effect
program:

```ts
import { Effect, Layer } from "effect"
import { NodeRuntime, NodeServices } from "@effect/platform-node"

import { Graft } from "@graftland/graft"
import { Include, ModuleResolver } from "@graftland/loader"

// Written in the application, so package names resolve from its dependencies.
const resolver = ModuleResolver.layer({
	base: process.cwd(),
	importer: (specifier) => import(specifier),
}).pipe(Layer.provide(NodeServices.layer))

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
