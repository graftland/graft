<img src="packages/docs/src/assets/graft-mark.svg" alt="" width="72" align="right">

# Graft

**Horticultural Effect Systems.** _Prune fearlessly._

English | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md)

Layers are not fixed at startup. They are grown.

Graft makes Effect `Layer`s dynamic. Mount a layer and Graft builds it while
everything it requires is available, publishes the services it provides, and
tears it down, dependents first, when a requirement goes away. Configuration is
an ordinary published value, and changing it rebuilds what depends on it.

```ts
import { Context, Effect, Layer } from "effect"

import { Graft } from "@graftland/graft"

class Region extends Context.Service<Region, string>()("app/Region") {}
class Report extends Context.Service<Report, string>()("app/Report") {}

const report = Layer.effect(
	Report,
	Effect.map(Region, (region) => `Report for ${region}`),
)

export const program = Effect.gen(function* () {
	// A value from outside any layer. `set` rebuilds its consumers.
	const region = yield* Graft.publish(Region, "eu")

	// Built while Region is available, torn down and rebuilt when it changes.
	const mount = yield* Graft.mount(report, {
		name: "report",
		requires: [Region],
	})
	yield* mount.await

	yield* region.set("us")
})
```

## Why Graft

- **Availability drives the graph.** A mount waits for its required services,
  builds when they are all there, and stops when one disappears. Optional
  requirements rebuild the mount when they come or go.
- **Teardown follows ownership.** Every mount owns a `Scope`, and every fiber it
  starts has an owner. Consumers stop before their provider, then resources
  close, and a failure keeps its full `Cause`.
- **Services can be read as they come and go.** `watch`, `await`, `use` and
  `whileAvailable` read the graph from ordinary Effect code, and withdrawal
  interrupts work instead of leaving stale values.
- **Remote services are still services.** Serve a service over any `effect/rpc`
  protocol and publish it in another process or on another machine. Mounts that
  use it do not change.

Graft depends only on `effect`; `@effect/platform-node` is optional and needed
only for the `node` entry. To run Graft on Node.js, you need version 22.19 or
later. To develop this workspace, you need Node.js 22.22 or later, which also
builds the documentation.

## Get started

```sh
npm install effect @graftland/graft
```

Read the [documentation](https://docs.graft.land/) (also in
[简体中文](https://docs.graft.land/zh-cn/) and
[繁體中文](https://docs.graft.land/zh-tw/)). The
[quickstart](https://docs.graft.land/quickstart/) mounts a first layer;
[concepts](https://docs.graft.land/concepts/) names the graph, mounts and
publications.

## One package

Graft publishes only `@graftland/graft`.

| Entry           | What it holds                                   |
| --------------- | ----------------------------------------------- |
| `graft`         | `Graft`, `Mount` and `Release`.                 |
| `graft/rpc`     | Remote services over `effect/rpc`.              |
| `graft/node`    | Child process and worker protocols for Node.js. |
| `graft/testing` | An in-memory protocol for tests.                |

## Former packages

Graft 0.7.0 is a dynamic Layer library. APIs from earlier versions were removed
and are not compatible.

These packages are no longer developed and receive no further updates:

| Package                        | Last release  | Use instead                                      |
| ------------------------------ | ------------- | ------------------------------------------------ |
| `@graftland/loader`            | `0.6.0`       | `Graft.mount` in your own program.               |
| `@graftland/hmr`               | `0.5.0`       | Nothing; Graft no longer reloads modules.        |
| `@graftland/cli`               | `0.6.0`       | Nothing; there is no command and no config file. |
| `@graftland/create`            | `0.6.0`       | Nothing.                                         |
| `@graftland/package-manager`   | `0.6.0`       | Nothing.                                         |
| `@graftland/plugin-remote`     | `0.6.0`       | The `graft/rpc` entry.                           |
| `@graftland/plugin-http`       | `0.5.0`       | Nothing.                                         |
| `@graftland/plugin-http-api`   | `0.5.0`       | Nothing.                                         |
| `@graftland/plugin-mcp-server` | `0.5.0`       | Nothing.                                         |
| `@graftland/plugin-otlp`       | `0.5.0`       | Nothing.                                         |
| `@graftland/plugin-release`    | Not published | Nothing.                                         |

`@graftland/plugin-release` was never published, so there is nothing to
deprecate. Marking the published packages as deprecated on npm is a separate,
optional decision.

## Contributing

Commands run in the project's [devenv](https://devenv.sh) shell:

```sh
devenv shell -- pnpm install
devenv shell -- pnpm typecheck
devenv shell -- pnpm test
```

See [Releases](https://docs.graft.land/releases/) for the checks, the release
process and the docs site.

## License

[Apache 2.0](LICENSE)
