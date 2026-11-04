# Applications

An application is a list of entries plus a host that runs them. The stock host
is `graft start`; your own Effect program can be one too.

## Start a project

```sh
npx @graftland/cli create my-app --install
cd my-app
npx graft start --watch
```

`graft add <package>` installs a plugin package with the project's package
manager and rolls back on failure; then add an entry for it.

## `graft.yml`

```yaml
# yaml-language-server: $schema=https://cdn.jsdelivr.net/npm/@graftland/cli@<version>/schema.json
- id: database
  name: "@acme/graft-plugin-postgres"
  config:
    url: !env DATABASE_URL

- id: api
  name: ./plugins/api.mjs
  config:
    port: 8080

- id: tenants
  group: true
  isolate:
    "@acme/graft-plugin-postgres/Database": true
  config:
    - id: tenant-db
      name: "@acme/graft-plugin-postgres"
      config:
        url: !env TENANT_DATABASE_URL
```

| Field       | What it does                                                                                                               |
| ----------- | -------------------------------------------------------------------------------------------------------------------------- |
| `id`        | Unique across the tree. Graft writes one into the file when it is missing.                                                 |
| `name`      | `./path`, `/path`, `@scope/pkg`, or a short name (`review` → `review`, `@graftland/plugin-review`, `graft-plugin-review`). |
| `config`    | The plugin's input; for a group, its child entries.                                                                        |
| `disabled`  | `true` unloads the entry and keeps it in the file.                                                                         |
| `group`     | `true` makes the entry a group.                                                                                            |
| `inject`    | Extra service key strings to wait for before loading.                                                                      |
| `isolate`   | Key strings: `true` for a private realm, a label for a shared one.                                                         |
| `intercept` | Patches for registered references ([realms](realms.md#from-graftyml)).                                                     |

- `!env NAME` reads a variable at load time and stays a tag in the file, so
  secrets never land in it. A missing variable fails only that entry.
  `graft start --env-file .env` adds a file; the process environment wins.
- Declare the tag for the YAML language server:
  `{ "yaml.customTags": ["!env scalar"] }` in `.vscode/settings.json`.
- Groups with `isolate` are how a config file runs separate instances.

## Changes while running (`--watch`)

| Change                                            | Result                                                     |
| ------------------------------------------------- | ---------------------------------------------------------- |
| `config` of an entry                              | `update`: in place if the plugin supports it, else restart |
| `name`, `group`, `inject`, `isolate`, `intercept` | Unloaded and loaded again                                  |
| Entry added / removed or disabled                 | Loaded / unloaded                                          |
| A plugin module or its local imports              | Hot reload: affected plugins restart on the new code       |
| Invalid YAML or a module that fails to import     | Logged; the last valid version keeps running               |

Hot reload needs side-effect-free ECMAScript modules; CommonJS, native
dependencies and `createRequire` make it report `Restart required`. Packages in
`node_modules` are not reloaded, except the module a plugin is loaded from.

## Edit entries from a plugin

```ts
const admin = Plugin.make({
	name: "admin",
	inject: [Loader.Loader],
	apply: () =>
		Effect.gen(function* () {
			const loader = yield* Loader.Loader
			const id = yield* loader.create({ name: "./plugins/cron.mjs" })
			yield* loader.update(id, { config: { every: "5 minutes" } })
			yield* loader.update("api", { disabled: true })
		}),
})
```

Edits are written to the file with comments and `!env` tags kept. An edit
completes when saved; `loader.ready` waits until forks are reconciled. Call
`ready` outside lifecycle callbacks, since it would wait for the callback
itself. `loader.retry` retries failed entries and rereads `!env` values.

## Embed Graft

Run plugins from code:

```ts
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Graft } from "@graftland/graft"
import { Effect, Layer } from "effect"

const program = Effect.gen(function* () {
	yield* Graft.plugin(greeter, { greeting: "Hello" })
	return yield* Effect.never
})

program.pipe(
	Effect.scoped,
	Effect.provide(Layer.provideMerge(Graft.layer, NodeServices.layer)),
	NodeRuntime.runMain,
)
```

| To load…               | Use                                                                 |
| ---------------------- | ------------------------------------------------------------------- |
| Plugins from code      | `Graft.plugin` in a scope                                           |
| Entries kept in memory | `Graft.plugin(Loader.plugin, entries)` with a `ModuleResolver`      |
| A YAML file            | `Graft.plugin(Include.Include, { path: "graft.yml", watch: true })` |
| Hot reload             | `@graftland/hmr`                                                    |

Resolvers: `ModuleResolver.fromRecord({ greeter })` for bundled apps and tests;
`ModuleResolver.layer({ base: process.cwd(), importer: (specifier) => import(specifier) })`
for plugin files, which needs `Path`. Provide the resolver, platform services
(`NodeServices.layer`), a `Logger` layer and any `Intercept.layer` registrations
in the environment of `Graft.layer`.

Everything in that environment is visible to every plugin and lives as long as
the app: the place for infrastructure the host owns.
