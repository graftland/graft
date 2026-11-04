# @graftland/plugin-remote

English | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md)

Run a Graft plugin in a child process, a Node worker, or on a runner. Declare
the services that cross the boundary; consumers keep their usual interfaces.

Keep the contract separate from the implementation. The host imports only the
contract. Build both modules to JavaScript, then load the capability and entry:

```ts
import * as Remote from "@graftland/plugin-remote"
import { contract } from "./contract.js"

export default Remote.plugin(contract, {
	contractModule: new URL("./contract.js", import.meta.url).href,
	target: Remote.local(),
})
```

```yaml
- name: "@graftland/plugin-remote/host/local"
- name: ./entry.ts
```

For threads, use `Remote.worker()` with `host/worker`. Workers share the host
process and permissions. For runners, use `Remote.runner({ transport, auth })`:
websocket (ws/wss), unix socket, or command/stdio; choose mTLS, bearer, JWT, or
none where supported. Load the matching `host/*` and `host/auth/*` plugins
explicitly. Missing capabilities leave the proxy Pending; `Remote.plugin`
installs none automatically.

Start a runner with `graft-remote serve --config runner.yml` or CLI shorthand.
Install its plugin packages in advance and preserve its state directory.
`graft-remote certificates` can issue deployment certificates. With `graft.yml`,
the saved entry id names the instance by default.

A custom host provides `NodeServices.layer` and `SecureRandom.layerWebCrypto`
(from `effect/crypto`) to its Graft runtime.

- [Remote plugin guide](https://graftland.github.io/graft/remote/)
- [Local and Node worker sample](../../samples/remote-worker/)
- [JWT runner and SSH sample](../../samples/remote-runner/)

This workspace package remains private. A separate process is not a permission
sandbox.

Part of [Graft](https://github.com/graftland/graft). Licensed under
[Apache 2.0](https://github.com/graftland/graft/blob/main/LICENSE).
