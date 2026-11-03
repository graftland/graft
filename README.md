# Graft

A plugin framework built on [Effect](https://effect.website). Graft runs an
application as a tree of plugins that publish and use services, and lets you
load, reconfigure, replace and unload them while the process keeps running.

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

## Get started

```sh
npx @graftland/cli create my-app --install
cd my-app
npx graft start --watch
```

Read the [documentation](https://graftland.github.io/graft/)
([简体中文](https://graftland.github.io/graft/zh-cn/)). Coming from cordis? See
[how its concepts map to Graft](https://graftland.github.io/graft/cordis/).

## Packages

| Package                                                  | What it does                                                                              |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| [`@graftland/graft`](packages/core)                      | A plugin framework built on Effect: plugins, forks, services, isolation, events and logs. |
| [`@graftland/loader`](packages/loader)                   | Loads plugins from a list of entries or a YAML config file.                               |
| [`@graftland/hmr`](packages/hmr)                         | Reloads plugin modules on Node.js without restarting the process.                         |
| [`@graftland/cli`](packages/cli)                         | The `graft` command: `start`, `create`, `add` and `remove`.                               |
| [`@graftland/create`](packages/create)                   | Generates a new Graft project. `graft create` uses it.                                    |
| [`@graftland/package-manager`](packages/package-manager) | Installs dependencies with npm, pnpm or Yarn, and rolls back on failure.                  |

All packages are released together with the same version, and need `effect`
4.1.2.

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
