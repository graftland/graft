# @graftland/plugin-remote

English | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md)

Run a Graft plugin in a child process, a Node worker, or on a runner. Declare
cross-boundary services in a contract; consumers keep their usual interfaces.
The host imports only the contract, whose `module` points to the implementation.
Build both to JavaScript.

```yaml
- id: greeter
  name: remote
  config:
    contract: ./dist/contract.js
    connect: { local: {} }
    config: { greeting: Hello }
```

Use `graft start`, or load this TypeScript plugin with `Graft.plugin(entry)`:

```ts
import * as Remote from "@graftland/plugin-remote"
import { contract } from "./contract.js"

export default Remote.plugin(contract, {
	contractModule: new URL("./contract.js", import.meta.url).href,
	connect: { worker: {} },
	config: { greeting: "Hello" },
})
```

TS and YAML share `connect`: local, worker, url (ws/wss), unix, or command. Auth
is mtls, bearer, jwt, none, or a third-party `{ name, config }` reference. No
separate capability entries or service-key strings are needed. TS credentials
can also be Effects or `{ inject, read }`. A custom host supplies
`NodeServices.layer` and `SecureRandom.layerWebCrypto` to Graft.

A runner configuration:

```yaml
- name: remote/runner
  config:
    root: ./installation
    state: ./state
    listen:
      - url: wss://0.0.0.0:7443
        cert: ./certs/server.crt
        key: ./certs/server.key
        auth: { mtls: { ca: ./certs/ca.crt } }
```

Run `graft-remote serve --config runner.yml`. Install its plugin packages in
advance, preserve the state directory, and supervise the runner and descendants.
`graft-remote certificates` can issue certificates. A saved host entry id names
the instance by default; the runner confirms old-process exit before replacement
and advances generation. Read the guide for leases and three stopping outcomes.

Workers do not isolate permissions. Unix relies on file permissions; stdio
relies on SSH or another external mechanism. Use wss for tokens; stolen tokens
can be replayed while valid. JWT is checked once at upgrade. Restart the host
after changing a contract; contract imports do not participate in HMR.

Public APIs: root default, `plugin`, `Contract`, `Instance`, public errors;
`/runner`; `/Auth`, `/Transport`, `/Errors`, `/Contract`, `/Testing`; and
capability modules under `host/*` and `runner/*`. The executable paths
`/internal/bin`, `/internal/worker`, `/internal/watchdog` are **not public
APIs**.

- [Remote](https://graftland.github.io/graft/remote/overview/)
- [Capabilities](https://graftland.github.io/graft/remote/capabilities/)
- [06 · Remote](../../samples/06-remote/)
- [Chat bot](../../samples/chat-bot/)

This workspace package remains private.

Part of [Graft](https://github.com/graftland/graft). Licensed under
[Apache 2.0](https://github.com/graftland/graft/blob/main/LICENSE).
