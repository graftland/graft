# Applications

An application is a list of entries plus a host that runs them. The stock host
is `graft start`; your own Effect program can be one too.

## Start a project

```sh
npm create @graftland@latest my-app
cd my-app
npm run dev
```

`-t plugin` creates a plugin package to publish, `-t minimal` only the config;
`--plugin <name>` adds plugins to either, and `--yes` skips the questions.
`graft add <package>` installs a plugin package with the project's package
manager and rolls back on failure; then add an entry for it. `graft schema`
writes `graft.schema.json`, the editor schema with the config of every installed
plugin that exports `./schema`; `graft create`, `graft add` and `graft remove`
keep it current. Commit it.

## `graft.yml`

```yaml
# yaml-language-server: $schema=./graft.schema.json
- id: database
  name: "@acme/graft-plugin-postgres"
  config:
    url: !env DATABASE_URL

- id: api
  name: ./plugins/api.mjs
  config:
    port: 8080

- id: jobs
  group: true
  config:
    - id: cleanup
      name: ./plugins/cleanup.mjs
      config:
        every: 1 hour
```

| Field       | What it does                                                                                                               |
| ----------- | -------------------------------------------------------------------------------------------------------------------------- |
| `id`        | Unique across the tree. Graft writes one into the file when it is missing.                                                 |
| `name`      | `./path`, `/path`, `@scope/pkg`, or a short name (`review` → `review`, `@graftland/plugin-review`, `graft-plugin-review`). |
| `config`    | The plugin's input; for a group, its child entries.                                                                        |
| `disabled`  | `true` unloads the entry and keeps it in the file.                                                                         |
| `group`     | `true` makes the entry a group.                                                                                            |
| `inject`    | Extra service key strings to wait for before loading. Embedded loader only.                                                |
| `isolate`   | Key strings: `true` for a private realm, a label for a shared one. Embedded loader only.                                   |
| `intercept` | Patches for registered references ([realms](realms.md#from-graftyml)). Embedded loader only.                               |

- `!env NAME` reads a variable when the entry is deployed and stays a tag in the
  file, so secrets never land in it. A missing variable fails with
  `ConfigError`. `graft start --env-file .env` adds a file and
  `--env-dir /run/secrets` a directory with one file per variable; the process
  environment wins. None of these are watched: restart after changing them.
- Declare the tag for the YAML language server:
  `{ "yaml.customTags": ["!env scalar"] }` in `.vscode/settings.json`.
- `graft start` runs each entry in its own unit and rejects entries that use
  `inject`, `isolate` or `intercept` with `DeploymentUnsupported`. Those fields
  work when you [embed](#embed-graft) the loader.
- Each entry must name built JavaScript in a package with a `package.json`.

## Changes while running (`--watch`)

`graft start --watch` turns each save into a Change. Without `--watch`, restart
after changing configuration or code.

| Change                                                         | Result                                                                  |
| -------------------------------------------------------------- | ----------------------------------------------------------------------- |
| An entry's `config`, or code in its package                    | Redeployed in a new generation; other entries and sessions keep running |
| Entry added / removed or disabled                              | Deployed / removed                                                      |
| Saves within 100 ms, or made while a Change runs               | Coalesced; only the newest is applied next                              |
| Invalid YAML, a failed import or a failed trial                | Logged; running entries stay as they are; the next save tries again     |
| `--env-file`, `--env-dir`, installed packages (`node_modules`) | Not watched: restart                                                    |

A module's artifact is its whole package, so an edit redeploys every entry from
that package. Give plugins their own packages to redeploy them alone.

Native deployments use fixed data and public Kernel control separately from
Loader entries. See [native units](remote.md).

## Edit entries from a plugin

When you embed the loader (`Loader.plugin` or `Include.Include`), plugins can
inject its `Loader` service. `graft start` does not provide it.

```ts
const admin = Plugin.make({
	name: "app/admin",
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

With `Include.Include`, edits are written to the file with comments and `!env`
tags kept. An edit completes when saved; `loader.ready` waits until forks are
reconciled. Call `ready` outside lifecycle callbacks, since it would wait for
the callback itself. Ordinary edits retry failed entries; to reread `!env`
values across the whole tree, call `loader.root.update(entries)`, then `ready`.

## Embed Graft

Run plugins from code:

```ts
import { Effect, Layer } from "effect"
import { NodeRuntime, NodeServices } from "@effect/platform-node"

import { Graft } from "@graftland/graft"

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

Embedded forks have cooperative lifecycle only: no Changes, outcomes or units.
Restart the process after code changes.

The loader resolves built module files and inspects them in disposable units, so
its `ModuleResolver` needs a live control endpoint:

```ts
import { Effect, Layer } from "effect"
import { NodeServices } from "@effect/platform-node"

import { Kernel } from "@graftland/graft"
import { ModuleResolver } from "@graftland/loader"
import * as Control from "@graftland/plugin-remote/Control"
import * as Units from "@graftland/plugin-remote/Units"

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
```

Provide the resolver, platform services (`NodeServices.layer`), a `Logger` layer
and any `Intercept.layer` registrations in the environment of `Graft.layer`.

Everything in that environment is visible to every plugin and lives as long as
the app: the place for infrastructure the host owns.
