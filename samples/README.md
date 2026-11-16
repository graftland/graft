# Samples

English

Each sample is a small program in its own package. Read them in order; each one
teaches one idea and prints what happens.

| Sample                                         | You will learn                                                              |
| ---------------------------------------------- | --------------------------------------------------------------------------- |
| [01 · Mount a layer](01-mount-layer)           | Mount a normal `Layer`, use its service, and release it.                    |
| [02 · Publish and rebuild](02-publish-rebuild) | Publish a value and rebuild the mounts that require it when it changes.     |
| [03 · Failure and retry](03-failure-retry)     | Failed mounts, retry schedules, and background fibers owned by a mount.     |
| [04 · Tenants](04-tenants)                     | `isolate` and `intercept` for several tenants with one set of layers.       |
| [05 · Remote](05-remote)                       | Serve services over `effect/rpc` and connect to them from another graph.    |
| [06 · Reconnect](06-reconnect)                 | A dropped connection withdraws remote services; reconnecting restores them. |

## Run a sample

From the repository root:

```sh
devenv shell -- pnpm build
devenv shell -- pnpm --filter @graftland-samples/01-mount-layer start
```

Each README gives its exact command. Samples 01–04 print their story and exit.
Samples 05 and 06 use the in-memory protocol from `@graftland/graft/testing`, so
they also finish on their own.
