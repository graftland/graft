# @graftland/remote

English | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md)

Run a Graft plugin in a local Node.js child or on another machine. Declare the
services that cross the boundary; host plugins keep using their usual service
interfaces.

```ts
import * as Remote from "@graftland/remote"
import { contract } from "./contract.js"

export default Remote.plugin(contract, {
	contractModule: new URL("./contract.js", import.meta.url).href,
	target: Remote.local(),
})
```

Keep the shared `Contract.make(...)` definition separate from the
implementation. The host imports only the contract. Build the contract and
implementation to JavaScript before starting the child, then load this entry
with `Graft.plugin` or `graft.yml`. A custom host provides `NodeServices.layer`
and `SecureRandom.layerWebCrypto` (from `effect/crypto`) to its Graft runtime.

Use `Remote.runner(...)` for an authenticated network runner. Install plugin
packages on that machine and provision certificates from a dedicated CA using
`graft-remote certificates` or your usual certificate tooling. With `graft.yml`,
the saved entry id names the instance by default.

- [Remote plugins](https://graftland.github.io/graft/remote/): contracts,
  services, configuration, deployment, and stopping.
- [Runnable example](../../samples/remote-worker/): call a child service and
  confirm exit on shutdown.

This workspace package is private. It separates execution, not permissions; use
a VM or container when plugins need an isolation boundary.

Part of [Graft](https://github.com/graftland/graft). Licensed under
[Apache 2.0](https://github.com/graftland/graft/blob/main/LICENSE).
