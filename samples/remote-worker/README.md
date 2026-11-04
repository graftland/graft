# Remote worker

English | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md)

The host asks a child process to format `hello`. The child publishes
`Formatter`; the host injects it and receives `Worker: HELLO` with the child's
PID. The host imports the contract, never the worker implementation.

## Run it

Use Node.js 22.22 or later on Linux or macOS. From the repository root:

```sh
devenv shell -- pnpm build
devenv shell -- pnpm --filter @graftland/sample-remote-worker start
devenv shell -- pnpm --filter @graftland/sample-remote-worker test
```

The program prints `Worker: HELLO (child ..., host ...)` with two different
PIDs, then closes its scope and waits for the child to exit. No certificates or
network services are needed. The test checks the reply, separate PID, and
confirmed exit. It builds its own child executable so it can run alongside the
package tests.

## Files

| File                         | Purpose                                                        |
| ---------------------------- | -------------------------------------------------------------- |
| `src/contract.ts`            | Config, service key, RPC mapping, and implementation location. |
| `src/worker.ts`              | Publishes the formatter in the child.                          |
| `src/host.ts`                | Loads the proxy, injects the service, and makes a call.        |
| `src/main.ts`                | Supplies Node services, runs the host, and prints the result.  |
| `test/remote-worker.test.ts` | Checks the call and cleanup with a real child.                 |

`WorkerUnavailable` keeps connection failures in the service's typed error
channel. Calls are not retried. The child has normal OS permissions; a separate
process is not a security sandbox.

## Run the worker on another machine

The [remote-runner](../remote-runner) sample runs a plugin on a real runner over
mutual TLS, loaded from `graft.yml`. Its README covers certificates, installing
packages on the runner, and starting `graft-remote serve`. To point this sample
at a runner, pass `Remote.runner(...)` as the `target` in `src/main.ts`, with
`contractModule: "@graftland/sample-remote-worker/contract"`. This sample's test
only runs the local target.
