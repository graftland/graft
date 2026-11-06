<img src="packages/docs/src/assets/graft-mark.svg" alt="" width="72" align="right">

# Graft

**Horticultural Effect Systems.** _Prune fearlessly._

English | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md)

[![npm](https://img.shields.io/npm/v/@graftland/graft)](https://www.npmjs.com/package/@graftland/graft)
[![CI](https://github.com/graftland/graft/actions/workflows/ci.yml/badge.svg)](https://github.com/graftland/graft/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/graftland/graft)](LICENSE)

Graft is an [Effect](https://effect.website)-native plugin runtime for
long-running TypeScript applications. Each capability is a plugin with explicit
dependencies and its own lifecycle, so you can change one capability with a
controlled blast radius. Edit a plugin and `graft start --watch` swaps only the
plugins your change affects, inside the running process.

Software is not built. It is grown. Your application is a tree of plugins. Each
plugin is grafted onto a scope, draws on the services around it, and publishes
services of its own. You can load, reconfigure, replace and unload any branch
while the process keeps running. Cut anywhere, and the rest of the tree carries
on.

```ts
import { Context, Effect, Schema } from "effect"

import { Graft, Plugin } from "@graftland/graft"

class Greeter extends Context.Service<
	Greeter,
	{ readonly greet: (name: string) => Effect.Effect<void> }
>()("app/Greeter") {}

// Publishes a Greeter while it is loaded.
const greeter = Plugin.make({
	name: "app/greeter",
	config: Schema.Struct({ greeting: Schema.String }),
	apply: ({ greeting }) =>
		Graft.provide(Greeter, {
			greet: (name) => Effect.log(`${greeting}, ${name}!`),
		}),
})

// Starts once a Greeter exists, and stops before it goes away.
const hello = Plugin.make({
	name: "app/hello",
	inject: [Greeter],
	apply: () => Effect.flatMap(Greeter, (greeter) => greeter.greet("world")),
})
```

## Why Graft

- **Hot swap.** Change the variety without felling the tree.
  `graft start --watch` reimports only what your change affects and swaps the
  affected plugins in one transaction. If the new code fails to import or to
  start, the old plugins keep running.
- **Clean teardown.** Every plugin runs in its own `Scope`, and every fiber it
  starts has an owner. When a plugin goes away, the plugins that depend on it
  stop first. Then its finalizers run. Nothing is left behind, and a failure
  keeps its full `Cause`.
- **Checked dependencies.** Services are Effect `Context` keys, provided by
  `Layer`s or by other plugins. A plugin declares what it needs in `inject`, and
  the compiler checks it.

When one branch needs ground of its own,
[Remote](https://graftland.github.io/graft/remote/overview/) runs that plugin in
a child process, a Node worker or on another machine. The plugins that use its
services do not change.

To run Graft on Node.js, you need version 22.19 or later. To develop this
workspace, you need Node.js 22.22 or later. This includes building the
documentation with Astro.

## Get started

```sh
npm create @graftland@latest my-app
cd my-app
npm run dev
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

[`samples/`](samples) starts with six short, numbered samples. Each one teaches
one idea, from a first plugin to running from `graft.yml` and moving a plugin
into another process.

After those, larger applications show what Graft is for:

- a chat bot built from plugins, with its weather integration in a child process
- a checkout that swaps its pricing engine and database under load
- an HTTP gateway driven by `graft.yml`
- an MCP server whose tools are plugins that reload while a client is connected
- a multi-tenant service
- a market data pipeline that survives a flaky upstream

## Packages

| Package                                                      | What it does                                                                                |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| [`@graftland/graft`](packages/core)                          | A plugin framework built on Effect: plugins, forks, services, isolation, events and logs.   |
| [`@graftland/loader`](packages/loader)                       | Loads plugins from a list of entries or a YAML config file.                                 |
| [`@graftland/hmr`](packages/hmr)                             | Reloads plugin modules on Node.js without restarting the process.                           |
| [`@graftland/cli`](packages/cli)                             | The `graft` command: `start`, `create`, `add` and `remove`.                                 |
| [`@graftland/create`](packages/create)                       | Generates a new Graft project: `npm create @graftland` and `graft create`.                  |
| [`@graftland/package-manager`](packages/package-manager)     | Installs dependencies with npm, pnpm or Yarn, and rolls back on failure.                    |
| [`@graftland/plugin-remote`](packages/plugin-remote)         | Runs a plugin in a child process, a worker or on another machine; `graft start runner.yml`. |
| [`@graftland/plugin-otlp`](packages/plugin-otlp)             | Exports the spans of a subtree of plugins to an OpenTelemetry collector.                    |
| [`@graftland/plugin-http`](packages/plugin-http)             | Shared HTTP server; routes and streams follow plugin lifetimes.                             |
| [`@graftland/plugin-http-api`](packages/plugin-http-api)     | Live Effect HttpApi groups, typed clients and OpenAPI documentation.                        |
| [`@graftland/plugin-mcp-server`](packages/plugin-mcp-server) | Serves the tools of plugins to MCP clients; tools reload without reconnecting.              |

All packages are released together with the same version. They all need `effect`
4.1.x.

## Direction

Graft is growing toward live upgrades for long-running gateways: replace one
independently authored integration while the gateway keeps its upstream session,
with bounded drains, readiness checks and truthful outcomes. The design is
public: the [value definition](design/value.md) and the
[target architecture](design/upgrades.md), both in Chinese. This README
describes only what is implemented.

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
