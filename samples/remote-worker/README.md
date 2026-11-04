# Remote worker

English | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md)

The host calls the same `Formatter` service twice: once in a child process with
`Remote.local()`, then in a Node worker with `Remote.worker()`. Both return
`Worker: HELLO`. The host imports only the contract.

## Run it

Use Node.js 22.22 or later on Linux or macOS. From the repository root:

```sh
devenv shell -- pnpm build
devenv shell -- pnpm --filter @graftland/sample-remote-worker start
devenv shell -- pnpm --filter @graftland/sample-remote-worker test
```

The local result has a different PID and thread 0. The worker result shares the
host PID and has a positive threadId. Closing each scope disposes its proxy and
waits for exit. Neither needs a runner or credentials; generation is always 1.

`src/host.ts` explicitly loads `host/local` and `host/worker` before loading the
proxy and its consumer. `src/contract.ts` defines the RPC mapping;
`src/worker.ts` provides the service. `src/main.ts` selects each target. The
tests check both replies, process/thread identity, and local process exit. Build
first: the worker target starts the installed remote worker executable.

`WorkerUnavailable` keeps connection failures in the service's error channel.
Calls are not retried. A Node worker shares the host process and permissions: it
isolates execution, not access to files or the network. A child process also has
normal OS permissions.

For a wss/JWT runner, persistent generations, and SSH/stdio instructions, see
[remote-runner](../remote-runner/).
