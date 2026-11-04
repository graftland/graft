# @graftland/plugin-remote

English | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md)

Run a Graft plugin somewhere else: in a child process, in a Node worker, or on
another machine through a runner. The plugins that use it keep injecting its
services as usual; only its config entry changes.

```yaml
- id: greeter
  name: remote
  config:
    contract: ./dist/contract.js
    connect: { local: {} }
    config: { greeting: Hello }
```

Remote isolates execution, not permissions. For a permission boundary, run the
runner in a container or a VM.

## Documentation

- [Overview](https://graftland.github.io/graft/remote/overview/): what Remote is
  for and how the pieces fit.
- [Getting started](https://graftland.github.io/graft/remote/getting-started/):
  move a plugin into a child process or a worker.
- [Run plugins on another machine](https://graftland.github.io/graft/remote/runners/):
  deploy a runner with `graft-remote serve`.
- [Choose transport and authentication](https://graftland.github.io/graft/remote/transport-auth/)
- [Restarts, replacements and stopping](https://graftland.github.io/graft/remote/restarts/)
- [Write your own transport or authentication](https://graftland.github.io/graft/remote/capabilities/)
- [Reference](https://graftland.github.io/graft/remote/reference/)

## Samples

- [06 · Remote](../../samples/06-remote/)
- [Chat bot](../../samples/chat-bot/)

This workspace package remains private.

Part of [Graft](https://github.com/graftland/graft). Licensed under
[Apache 2.0](https://github.com/graftland/graft/blob/main/LICENSE).
