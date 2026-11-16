# @graftland/graft

English |
[简体中文](https://github.com/graftland/graft/blob/main/packages/core/README.zh-CN.md)
|
[繁體中文](https://github.com/graftland/graft/blob/main/packages/core/README.zh-TW.md)

Effect layers that mount and unmount while the application runs.

```sh
npm install effect @graftland/graft
```

`effect` is a peer dependency, constrained to `4.1.*`. The supported Node.js
minimum is 22.19.

```ts
import { Context, Effect, Layer } from "effect"

import { Graft } from "@graftland/graft"

class Region extends Context.Service<Region, string>()("app/Region") {}

const region = Layer.effect(Region, Effect.succeed("eu"))

export const program = Effect.gen(function* () {
	const mount = yield* Graft.mount(region, { name: "region" })
	yield* mount.await
})
```

## What it does

- `Graft.mount` builds a layer while its `requires` are available, publishes its
  services, and tears it down when a requirement goes away.
- `Graft.publish` puts a value in the graph; `set` rebuilds what requires it.
- `Graft.watch`, `await`, `use` and `whileAvailable` read services as they come
  and go.
- `Graft.fork` starts a background fiber owned by the mount. Its failure fails
  the mount with the fiber's complete `Cause`; bare interruption does not.
- `Graft.mounts` and `Graft.logs` show the mount tree and the collected logs.

Each mount owns a `Scope`, so a teardown stops consumers before the provider and
then releases resources. `Mount.CleanupError` keeps every failure reason.

## Entries

| Entry       | Contents                                        |
| ----------- | ----------------------------------------------- |
| `.`         | `Graft`, `Mount` and `Release`.                 |
| `./rpc`     | Remote services over any `effect/rpc` protocol. |
| `./node`    | Child process and worker protocols for Node.js. |
| `./testing` | An in-memory protocol for tests.                |

## Documentation

- [Quickstart](https://graftland.github.io/graft/quickstart/)
- [Mounting](https://graftland.github.io/graft/mounting/)
- [Publications](https://graftland.github.io/graft/publications/)
- [Lifecycle](https://graftland.github.io/graft/lifecycle/)
- [Remote services](https://graftland.github.io/graft/remote/)

Part of [Graft](https://github.com/graftland/graft). Licensed under
[Apache 2.0](https://github.com/graftland/graft/blob/main/LICENSE).
