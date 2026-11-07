# @graftland/plugin-remote

English | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md)

Run a Graft plugin somewhere else: in a child process, in a Node worker, or on
another machine through a runner. The plugins that use it keep injecting its
[services](https://docs.graft.land/services/) as usual; only its
[config entry](https://docs.graft.land/config-file/) changes.

```yaml
- id: greeter
  name: remote
  config:
    contract: ./dist/contract.js
    implementation: ./dist/greeter.js
    connect: { local: {} }
    config: { greeting: Hello }
```

Remote isolates execution, not permissions. For a permission boundary, run the
runner in a container or a VM.

## Documentation

- [Remote](https://docs.graft.land/remote/overview/): what Remote does and its
  limits.
- [Host entries](https://docs.graft.land/remote/hosts/): contracts, `remote`
  entries, services and errors.
- [Runners](https://docs.graft.land/remote/runners/): run plugins on another
  machine with `graft start runner.yml`.
- [Transport and authentication](https://docs.graft.land/remote/transport-auth/)
- [Replacement and stopping](https://docs.graft.land/remote/lifecycle/)
- [Capability plugins](https://docs.graft.land/remote/capabilities/)
- [API reference](https://docs.graft.land/reference/plugin-remote/readme/)

## Samples

- [06 · Remote](../../samples/06-remote/)
- [Chat bot](../../samples/chat-bot/)

Part of [Graft](https://github.com/graftland/graft). Licensed under
[Apache 2.0](https://github.com/graftland/graft/blob/main/LICENSE).
