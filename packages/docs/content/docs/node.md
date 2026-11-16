---
title: Node processes
description: Serve and connect over a child process's stdio or a worker thread.
---

The `node` entry supplies `effect/rpc` protocols for running a service in a
child process or a `worker_threads` worker. It is a thin wrapper: process launch
and shutdown, plus framing over stdio or the worker channel.

## Contract

Both processes import the same contract.

```ts title="contract.ts"
import { Context, Effect, Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"

import { Remote } from "@graftland/graft/rpc"

export class Pricing extends Context.Service<
	Pricing,
	{
		readonly quote: (
			sku: string,
		) => Effect.Effect<number, Remote.RemoteUnavailable>
	}
>()("app/Pricing") {}

class Quote extends Rpc.make("Quote", {
	payload: { sku: Schema.String },
	success: Schema.Finite,
	error: Remote.RemoteUnavailable,
}) {}

const PricingRpcs = RpcGroup.make(Quote)

export const pricing = Remote.service(Pricing, PricingRpcs, {
	toHandlers: (service) => ({
		Quote: ({ sku }: { readonly sku: string }) => service.quote(sku),
	}),
	fromClient: (client) => ({
		quote: (sku) =>
			client
				.Quote({ sku })
				.pipe(
					Effect.mapError(() =>
						Remote.RemoteUnavailable.make({ service: "app/Pricing" }),
					),
				),
	}),
})
```

## Child process

```ts
import { Schedule } from "effect"

import { subprocessProtocol } from "@graftland/graft/node"
import { Remote } from "@graftland/graft/rpc"

import { pricing } from "./contract.ts"

export const client = Remote.connect({
	services: [pricing],
	protocol: subprocessProtocol({
		entry: "dist/worker.js",
		args: ["--mode", "pricing"],
	}),
	retry: Schedule.exponential("200 millis"),
})
```

| Option     | Meaning                                                               |
| ---------- | --------------------------------------------------------------------- |
| `entry`    | Path to the child program.                                            |
| `args`     | Additional arguments after `entry`.                                   |
| `execPath` | Node executable; the current one by default.                          |
| `cwd`      | Working directory of the child.                                       |
| `env`      | Environment variables; inherited by default.                          |
| `stderr`   | `"inherit"` (default) or `"ignore"`; diagnostics must not use stdout. |

The child speaks length-prefixed RPC over its standard input and output.
Spawning happens in the current scope, and closing the scope kills the child. A
child that exits ends the connection, which looks like any other disconnect.

## Worker thread

```ts
import { Schedule } from "effect"

import { workerProtocol } from "@graftland/graft/node"
import { Remote } from "@graftland/graft/rpc"

import { pricing } from "./contract.ts"

export const client = Remote.connect({
	services: [pricing],
	protocol: workerProtocol({ entry: new URL("./worker.js", import.meta.url) }),
	retry: Schedule.exponential("200 millis"),
})
```

A worker uses its `MessagePort`; no stdio is involved. The worker is started in
the current scope and terminated when the scope closes, and a worker that exits
ends the connection in the same way.

## Serve from the other side

In the child or worker, build a graph normally and serve over the matching
protocol:

```ts
import { layerProtocolStdio } from "@graftland/graft/node"
import { Remote } from "@graftland/graft/rpc"

import { pricing } from "./contract.ts"

export const server = Remote.serve({
	services: [pricing],
	protocol: layerProtocolStdio,
})
```

| Where the server runs | Protocol              |
| --------------------- | --------------------- |
| A child process       | `layerProtocolStdio`  |
| A worker thread       | `layerProtocolWorker` |

The child or worker owns its own lifecycle; when the parent closes the pipe, its
reading ends.

## Choosing a transport

| Need                              | Use                            |
| --------------------------------- | ------------------------------ |
| Strong isolation, separate memory | A child process over stdio     |
| Cheap concurrency, shared memory  | A worker thread                |
| Another machine                   | A socket or WebSocket protocol |

`node` adds no abstraction of its own; it only supplies the protocol layer.
Contracts, `Remote.serve`, `Remote.connect` and reconnection work the same as
[remote services](../remote/). The entry needs `@effect/platform-node`, an
optional peer dependency, and runs only on Node.js.
