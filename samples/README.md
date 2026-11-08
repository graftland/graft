# Samples

English | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md)

Each sample is a program you can run. Each one is in its own package.

## Start here

New to Graft? Read these in order. Each one is a short file that teaches one
idea, prints what happens, and suggests something to try.

| Sample                             | You will learn                                                                         |
| ---------------------------------- | -------------------------------------------------------------------------------------- |
| [01 · Hello](01-hello)             | Define a plugin, load it, change its config, unload it.                                |
| [02 · Services](02-services)       | Publish a service from one plugin and use it in another plugin, which waits for it.    |
| [03 · Events](03-events)           | Event handlers that go away when their plugin unloads.                                 |
| [04 · Failures](04-failures)       | Failed plugins, retry schedules, and background work that belongs to a plugin.         |
| [05 · Config file](05-config-file) | Run plugins from `graft.yml` with `graft start --watch`, and edit them while they run. |

For deployment and authentication, see the
[Remote guide](../packages/docs/content/docs/remote/overview.md).

## Real-world applications

These samples join the basics into larger programs. Each README starts with a
problem that you would otherwise solve by hand. Then it shows what Graft does
about it.

| Sample                                     | Scenario                                                                                    | What it shows                                                                                                     |
| ------------------------------------------ | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| [integration-gateway](integration-gateway) | A persistent WebSocket bot gateway while an independently packaged integration transitions. | Worker and child-process transitions; installed public packages.                                                  |
| [chat-bot](chat-bot)                       | A chat bot whose commands and filters are plugins.                                          | Event handlers owned by plugins, dependency gating, update in place, a weather integration in a child process.    |
| [http-gateway](http-gateway)               | An HTTP gateway with a shared todo store.                                                   | HttpApi contracts, typed clients, live OpenAPI and Scalar UI; watch edits, Pending routes and the live fork tree. |
| [mcp-tools](mcp-tools)                     | An MCP server whose tools are plugins.                                                      | `plugin-mcp-server`, tools that reload while a client is connected, rollback of a broken tool.                    |
| [saas-tenants](saas-tenants)               | One set of plugins serving several tenants.                                                 | `isolate` and `intercept` per tenant, a shared service with per-tenant settings, onboarding and offboarding.      |
| [market-feed](market-feed)                 | A market data pipeline behind an unreliable exchange.                                       | Supervised background tasks, retry schedules, `Pending` and `Failed` states, optional dependencies.               |

## Run a sample

The samples import the workspace packages. Node loads these packages from their
build output. From the repository root:

```sh
devenv shell -- pnpm build
devenv shell -- pnpm --filter @graftland/sample-hello start
```

`http-gateway` keep running until you press <kbd>Ctrl</kbd>+<kbd>C</kbd>. The
other samples print their story and exit.

`devenv shell -- pnpm test` runs the samples' tests together with the rest of
the workspace.
