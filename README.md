<img src="packages/docs/src/assets/graft-mark.svg" alt="" width="72" align="right">

# Graft

**Horticultural Effect Systems.** _Prune fearlessly._

English | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md)

Software is not built. It is grown.

Graft is a plugin framework for [Effect](https://effect.website). Your
application is a tree of plugins. Each plugin is grafted onto a scope, draws on
the services around it, and publishes services of its own. You can load,
reconfigure, replace and unload any branch while the process keeps running. Cut
anywhere, and the rest of the tree carries on.

```ts
import { Graft, Plugin } from "@graftland/graft"
import { Context, Effect, Schema } from "effect"

class Greeter extends Context.Service<
	Greeter,
	{ readonly greet: (name: string) => Effect.Effect<void> }
>()("app/Greeter") {}

// Publishes a Greeter while it is loaded.
const greeter = Plugin.make({
	name: "greeter",
	config: Schema.Struct({ greeting: Schema.String }),
	apply: ({ greeting }) =>
		Graft.provide(Greeter, {
			greet: (name) => Effect.log(`${greeting}, ${name}!`),
		}),
})

// Starts once a Greeter exists, and stops before it goes away.
const hello = Plugin.make({
	name: "hello",
	inject: [Greeter],
	apply: () => Effect.flatMap(Greeter, (greeter) => greeter.greet("world")),
})
```

## Why Graft

- **Rootstock.** Services are Effect `Context` keys, provided by `Layer`s or by
  other plugins. A plugin declares what it needs in `inject`, and the compiler
  checks it.
- **Pruning.** Every plugin runs in its own `Scope`, and every fiber it starts
  has an owner. When a plugin goes away, the plugins that depend on it stop
  first. Then its finalizers run. Nothing is left behind, and a failure keeps
  its full `Cause`.
- **Top-working.** Change the variety without felling the tree.
  `graft start --watch` reimports only what your change affects and swaps the
  affected plugins in one transaction. If the new code fails, the old plugins
  keep running.

To run Graft on Node.js, you need version 22.19 or later. To develop this
workspace, you need Node.js 22.22 or later. This includes building the
documentation with Astro.

## Get started

```sh
npx @graftland/cli create my-app --install
cd my-app
npx graft start --watch
```

Read the [documentation](https://graftland.github.io/graft/) (also in
[简体中文](https://graftland.github.io/graft/zh-cn/) and
[繁體中文](https://graftland.github.io/graft/zh-tw/)). Working with a coding
agent? The [`graft` skill](skills/graft) teaches it to design an application as
plugins and Effects, then write, test and run them:
`npx skills add graftland/graft`.

Graft draws its plugin model from
[cordis](https://github.com/cordiverse/cordis). Where cordis composes across
space and time, Graft keeps to the garden. See
[how cordis concepts map to Graft](https://graftland.github.io/graft/cordis/).
To let a coding agent do the port, install the [migration skills](skills).

## Samples

[`samples/`](samples) starts with five short, numbered samples. Each one teaches
one idea, from a first plugin to running from `graft.yml`.

After those, larger applications show what Graft is for:

- a chat bot built from plugins
- a checkout that swaps its pricing engine and database under load
- an HTTP gateway driven by `graft.yml`
- a multi-tenant service
- a market data pipeline that survives a flaky upstream

## Packages

| Package                                                  | What it does                                                                              |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| [`@graftland/graft`](packages/core)                      | A plugin framework built on Effect: plugins, forks, services, isolation, events and logs. |
| [`@graftland/loader`](packages/loader)                   | Loads plugins from a list of entries or a YAML config file.                               |
| [`@graftland/hmr`](packages/hmr)                         | Reloads plugin modules on Node.js without restarting the process.                         |
| [`@graftland/cli`](packages/cli)                         | The `graft` command: `start`, `create`, `add` and `remove`.                               |
| [`@graftland/create`](packages/create)                   | Generates a new Graft project. `graft create` uses it.                                    |
| [`@graftland/package-manager`](packages/package-manager) | Installs dependencies with npm, pnpm or Yarn, and rolls back on failure.                  |

All packages are released together with the same version. They all need `effect`
4.1.x.

## Contributing

Commands run in the project's [devenv](https://devenv.sh) shell:

```sh
devenv shell -- pnpm install
devenv shell -- pnpm typecheck
devenv shell -- pnpm test
```

See [Releases](https://graftland.github.io/graft/releases/) for the checks, the
release process and the docs site.

## License

[Apache 2.0](LICENSE)
