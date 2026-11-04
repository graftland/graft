# 06 · Remote

English | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md)

The greeter is still an ordinary plugin. This time you choose where it runs. The
welcome plugin still injects `Greeter` and calls `greet("Alice")`.

You will learn:

- Replace one entry with `name: remote`; callers stay unchanged.
- Move the same plugin from a child process to a Node worker or a runner by
  editing `connect`.
- Share a contract, without importing the implementation into the host.

## Run it

From the repository root:

```sh
devenv shell -- pnpm build
cd samples/06-remote
devenv shell -- pnpm start
```

You see `Hello, Alice!`. Leave it running while you try the steps below.

## Move one entry

A normal provider entry looks like this:

```yaml
- id: greeter
  name: ./src/greeter.ts
  config:
    greeting: Hello
```

This sample's `graft.yml` replaces just that entry:

```yaml
- id: greeter
  name: remote
  config:
    contract: "@graftland/sample-remote/contract"
    connect:
      local: {}
    config:
      greeting: Hello
```

The `welcome` entry and [`src/welcome.ts`](src/welcome.ts) do not change. The
greeter is split in two:

| File                                 | Holds                                                                                                                                  | Imported by             |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| [`src/contract.ts`](src/contract.ts) | The plugin's name, config schema, and how `Greeter` crosses the boundary. `fromClient` maps `RpcClientError` to `GreetingUnavailable`. | Host and plugin process |
| [`src/greeter.ts`](src/greeter.ts)   | The plugin itself, importing `config` and `Greeter` from the contract.                                                                 | Plugin process only     |

The plugin process does not use the host's TypeScript loader, so
[`tsdown.config.ts`](tsdown.config.ts) builds both to `dist/`. Rebuild with
`devenv shell -- pnpm build` after changing either.

1. Change `greeting: Hello` to `greeting: Hi` and save. The provider restarts,
   then welcome prints `Hi, Alice!`.
2. Replace only `connect` with:

```yaml
connect:
  worker: {}
```

Save again. The same greeting now comes from a Node worker. A worker shares the
host process: it isolates execution, **not permissions**. Local uses a separate
process, also with your normal OS permissions. `worker: { execArgv: [...] }`
passes Node options, and `local: { command: [node, /path/to/bin.js] }` runs a
different command.

## Move it to a runner

In a second terminal, from this directory:

```sh
devenv shell -- pnpm runner
# Runs: graft-remote serve --config runner.yml
```

The build has copied this sample package into `.cache/installation`, the
installation used by [`runner.yml`](runner.yml). On another machine, install the
built plugin package and dependencies there instead; the host does not upload
code.

Replace only `connect` in `graft.yml` and save:

```yaml
connect:
  url: ws://127.0.0.1:7443
  auth:
    none: {}
```

The greeting is unchanged. Now the runner starts the child. The persisted
`greeter` entry id names the instance; replacement waits for the old child to
exit before starting a larger generation.

You will see WARNs: `ws` is unencrypted and `none` does not authenticate
callers. This loopback tutorial is for trying the flow; use wss and
authentication when deploying it. See
[Transport and authentication](../../packages/docs/content/docs/remote/transport-auth.md).

Press **Ctrl+C** in the host terminal first, then the runner terminal. Edit
business config or `connect` while running; after editing the contract, rebuild
and restart the host.

## Next

[Chat bot](../chat-bot) uses a child process for its weather integration, while
other commands stay in the host. The [other samples](../README.md) combine more
of the basics.
