# Node: subprocess and worker transports

`@graftland/graft/node` supplies `effect/rpc` transports for a child process and
a `worker_threads` worker. It is a thin adapter: nothing here supervises a
process or retries a connection — start and stop belong to the calling scope.
`@effect/platform-node` is an optional peer; use this entry only in Node.

```ts
import * as Node from "@graftland/graft/node"
```

## Client side

Both functions return a client Protocol in the current `Scope`. Closing the
scope kills the child or terminates the worker.

```ts
const program = Effect.gen(function* () {
	const protocol = Node.subprocessProtocol({
		entry: "dist/service.js",
		args: [],
		// execPath, execArgv, cwd, env, stderr are optional
	})
	yield* Remote.connect({
		services: [PricingRemote],
		protocol,
		retry: Schedule.exponential("200 millis"),
	})
})
```

- `subprocessProtocol(options)` spawns `entry` with the current Node executable
  (override with `execPath`) and carries RPC over its stdin/stdout. The child
  must keep stdout for the protocol; write diagnostics to stderr. Set
  `stderr: "ignore"` or `"inherit"` as needed.
- `workerProtocol(options)` starts a `worker_threads` worker from `entry` and
  carries RPC over its channel. `workerData`, `execArgv`, `env` and
  `resourceLimits` are passed through. The worker serves concurrent calls,
  including long-lived streams.

A crashed child or worker ends the connection like any other disconnect; the
`retry` on `Remote.connect` reopens it.

## Server side

In the child or worker, serve over the matching server Protocol Layer:

```ts
const program = Effect.gen(function* () {
	yield* Remote.serve({
		services: [PricingRemote],
		protocol: Node.layerProtocolStdio,
	})
})
```

| Side           | Function                           | Kind                                      |
| -------------- | ---------------------------------- | ----------------------------------------- |
| Child, client  | `Node.subprocessProtocol(options)` | `Effect<Protocol, RpcClientError, Scope>` |
| Worker, client | `Node.workerProtocol(options)`     | `Effect<Protocol, WorkerError, Scope>`    |
| Child, server  | `Node.layerProtocolStdio`          | `Layer<RpcServer.Protocol>`               |
| Worker, server | `Node.layerProtocolWorker`         | `Layer<RpcServer.Protocol, WorkerError>`  |

## Choosing a transport

| Need                                 | Use                                            |
| ------------------------------------ | ---------------------------------------------- |
| Strong process isolation, own memory | `subprocessProtocol` over stdio                |
| Cheap concurrency, shared memory     | `workerProtocol`                               |
| Another machine                      | A socket or WebSocket protocol, not this entry |

Everything else — contract, `Remote.serve`, `Remote.connect`, reconnection — is
the same as [Remote](remote.md).
