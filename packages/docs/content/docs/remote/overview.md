---
title: Overview
description: Run a plugin in a child process, a Node worker, or on a runner.
---

Run a plugin in a child process, a Node worker, or on a runner. Start here to
choose where it should execute; callers keep using ordinary Graft services.

## Choose an execution mode

- **Direct:** `local` starts a child process; `worker` starts a Node worker in
  the host process. Neither needs a runner, and each activation uses
  generation 1.
- **Runner:** the host connects to a separately managed runner, which starts
  plugin processes. It persists generations and confirms the old process has
  exited before accepting a replacement.

The host loads `name: remote`. The runner loads `name: remote/runner` from its
own configuration and starts with `graft-remote serve --config runner.yml`.

Remote separates execution, not permissions. Use a container or VM for a
permission boundary; use [isolation](../../isolation/) for service visibility
within one process.

## Try it

With a [built contract and implementation](../host/#define-a-contract), load
this entry:

```yaml title="graft.yml"
- id: greeter
  name: remote
  config:
    contract: ./dist/contract.js
    connect:
      local: {}
    config:
      greeting: Hello
```

Run `graft start`. Change `local: {}` to `worker: {}` to use a Node worker
without changing the caller.

Follow
[06 · Remote](https://github.com/graftland/graft/tree/main/samples/06-remote) to
try local, worker, and runner connections.
[Chat bot](https://github.com/graftland/graft/tree/main/samples/chat-bot) uses a
child process for its weather integration.

## Next

- [Host](../host/): YAML, TypeScript, and shared services.
- [Runner](../runner/): installation, configuration, and SSH.
- [Transport and authentication](../transport-auth/): combinations, WARNs, and
  trust boundaries.
- [Replacement, leases, and stopping](../lifecycle/): generations, deadlines,
  and failures.
- [Write capability plugins](../capabilities/): extend remote and run shared
  checks.
