# @graftland/plugin-remote

English | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md)

Run a Graft plugin somewhere else: in a child process, in a Node worker, or on
another machine through a runner. The plugins that use it keep injecting its
[services](https://graftland.github.io/graft/services/) as usual; only its
[config entry](https://graftland.github.io/graft/config-file/) changes.

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

- [Remote](https://graftland.github.io/graft/remote/overview/): what Remote does
  and its limits.
- [Host entries](https://graftland.github.io/graft/remote/hosts/): contracts,
  `remote` entries, services and errors.
- [Runners](https://graftland.github.io/graft/remote/runners/): run plugins on
  another machine with `graft-remote serve`.
- [Transport and authentication](https://graftland.github.io/graft/remote/transport-auth/)
- [Replacement and stopping](https://graftland.github.io/graft/remote/lifecycle/)
- [Capability plugins](https://graftland.github.io/graft/remote/capabilities/)
- [API reference](https://graftland.github.io/graft/reference/plugin-remote/readme/)

## Samples

- [06 · Remote](../../samples/06-remote/)
- [Chat bot](../../samples/chat-bot/)

Part of [Graft](https://github.com/graftland/graft). Licensed under
[Apache 2.0](https://github.com/graftland/graft/blob/main/LICENSE).
