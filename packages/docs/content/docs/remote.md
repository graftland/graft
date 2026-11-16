---
title: Remote services
description: Publish services from another process or machine over effect/rpc.
---

The `rpc` entry of Graft exposes services over any `effect/rpc` protocol and
publishes the remote side's services into the local graph. The mounts that use
them do not change.

## Define the contract

A remote service pairs a service key, an `RpcGroup` and the mapping between
them. Both sides import the same definition.

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

The shared shape names `Remote.RemoteUnavailable`, so a dropped connection fails
callers with an error they can handle instead of the transport's own error.

| Field        | What it is                                         |
| ------------ | -------------------------------------------------- |
| `toHandlers` | Runs a server-side service to answer each RPC.     |
| `fromClient` | Builds the client-side service from an RPC client. |

RPC names are prefixed per service, so two services can use the same name.

## Serve local services

```ts
import type { Layer } from "effect"
import type { RpcServer } from "effect/rpc"

import { Remote } from "@graftland/graft/rpc"

import { pricing } from "./contract.ts"

declare const protocol: Layer.Layer<RpcServer.Protocol>

export const server = Remote.serve({
	services: [pricing],
	protocol,
})
```

`protocol` is any complete `RpcServer.Protocol` layer: a socket server with its
serialization and socket service, a worker, or an in-memory protocol.

`serve` returns a `Mount` in the calling scope. Each service is exposed only
while it is available in the local graph; a service that disappears is withdrawn
from every connected client.

## Connect to a server

```ts
import { Schedule, type Effect, type Scope } from "effect"
import type { RpcClient } from "effect/rpc"

import { Remote } from "@graftland/graft/rpc"

import { pricing } from "./contract.ts"

declare const protocol: Effect.Effect<
	RpcClient.Protocol["Service"],
	never,
	Scope.Scope
>

export const client = Remote.connect({
	services: [pricing],
	protocol,
	retry: Schedule.exponential("100 millis"),
})
```

`connect` returns a `Mount` too. When the connection ends, every remote service
is withdrawn from the local graph, the protocol's scope is closed, and the
connection is rebuilt on the retry schedule.

## Availability

1. **Connect.** The client opens the protocol and calls one control RPC,
   `Presence`, on a stream.
2. **Push the set.** The server keeps pushing the set of services it can provide
   right now.
3. **Publish or withdraw.** The client publishes each service in the set and
   withdraws the ones that leave it.
4. **Disconnect.** When `Presence` ends or fails, every remote service is
   withdrawn and the protocol scope closes.
5. **Reconnect.** The retry schedule builds a new protocol and repeats from
   step 1.

Availability follows the graph, not the transport's own connection events, so
the same rules hold for sockets, HTTP, WebSocket, workers and stdio.

### Withdrawing a service

When the server withdraws one service, its running handlers are interrupted and
their resources are released. The client's call in flight for that service ends
as a defect carrying `Graft.ServiceWithdrawn`; it does not hang. A connection
that drops instead fails in-flight calls with `RemoteUnavailable`.

## Errors callers see

| Error                    | Raised when                                                                |
| ------------------------ | -------------------------------------------------------------------------- |
| `RemoteUnavailable`      | A call is in flight when the connection drops.                             |
| `Graft.ServiceWithdrawn` | The server withdraws the service during a call; the call ends as a defect. |
| Transport errors         | The protocol fails to connect; the retry schedule handles them.            |

Declared RPC errors cross the wire with their schemas. A defect on the server
stays a defect on the client, because Graft configures servers with
`disableFatalDefects: true`.

## What Graft does not do

Graft does not send code, install dependencies or deploy the other process. You
run the server where you want it, open the protocol, and share the contract
module. The remote service is then an ordinary service in the local graph. See
[Node processes](../node/) for child processes and workers, and
[Testing](../testing/) for an in-memory protocol.
