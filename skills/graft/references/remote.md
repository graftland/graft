# Remote services

`@graftland/graft/rpc` exposes a service from one graph to another over
`effect/rpc`, transport-agnostic. It moves **services, not layers**: Graft does
not ship code or install anything. Consumers require the same key; only where
the provider runs changes.

```ts
import { Remote } from "@graftland/graft/rpc"

// The disconnect error is `Remote.RemoteUnavailable`.
```

## When to reach for it

| The user wants…                                                  | Use                                           |
| ---------------------------------------------------------------- | --------------------------------------------- |
| A crash, leak or stalled loop in one service to spare the app    | A child process or worker via [node](node.md) |
| CPU-bound work on another thread                                 | A worker                                      |
| A service next to data, hardware or a network on another machine | A socket protocol, authentication at connect  |
| Separate instances or settings in one process                    | Not Remote: a [realm](isolation.md)           |

Remote isolates execution, not permissions. Every call becomes RPC; arguments
and results cross the wire as schema values. For a security boundary, run the
remote side in a container or VM.

## Define the contract

A contract module is shared by both sides and holds the service key, an
`RpcGroup`, and the two mappings:

```ts
import { RpcGroup } from "effect/rpc"

import { Remote } from "@graftland/graft/rpc"

export const PricingRpcs = RpcGroup.make(
	QuoteRpc, // one Rpc per method; args and success are schemas
)

export const PricingRemote = Remote.service(Pricing, PricingRpcs, {
	toHandlers: (pricing) => ({
		Quote: ({ sku }) => pricing.quote(sku),
	}),
	fromClient: (client) => ({
		quote: (sku) => client.Quote({ sku }),
	}),
})
```

- `toHandlers` turns one available instance of the local service into RPC
  handlers. A call waits for the service to be available and serves the instance
  available at that moment.
- `fromClient` turns the generated RPC client into the same service shape
  consumers expect. Its error channel is `RpcClientError | RemoteUnavailable`.
- `prefix` optionally overrides the RPC tag prefix; it defaults to the service
  key string, which keeps services apart on a shared connection.
- Both sides import this module; the implementation module is not shared.

## Serve

The server publishes the services it has locally. A service is offered only
while it is available locally:

```ts
const program = Effect.gen(function* () {
	const serving = yield* Remote.serve({
		services: [PricingRemote],
		protocol: serverProtocol, // Layer<RpcServer.Protocol, E, R>
	})
	yield* serving.await
})
```

- `serve` returns a `Mount<E | ServiceConflict>` belonging to the current scope;
  closing the scope stops serving.
- The protocol Layer's requirements are taken from the caller's context.
- A failing server fiber fails the mount; wrap it in a `retry` at a higher level
  if serving should restart.

## Connect

The client connects, then publishes the remote services into the local graph:

```ts
const program = Effect.gen(function* () {
	const connected = yield* Remote.connect({
		services: [PricingRemote],
		// Builds a fresh client protocol per connection attempt:
		protocol: openProtocol, // Effect<RpcClient.Protocol, E, Scope>
		retry: Schedule.exponential("100 millis"),
	})
	yield* connected.await
})
```

- `protocol` is an `Effect` rebuilt on every connection attempt; its scope is
  closed when the connection ends. Provide authentication when constructing it.
- `connect` returns a
  `Mount<E | RpcClientError | RemoteUnavailable | ServiceConflict>`. Consumers
  below it wait in `Pending` until the remote service is published.
- `retry` is optional; without it a dropped connection stays down until the
  mount is restarted.

## Availability and reconnection

- Each connection uses one merged `RpcGroup`: a control group with a streaming
  `Presence` RPC, plus each service's group under its prefix.
- `Presence` pushes the set of service keys the server currently provides. The
  client publishes or withdraws each remote service to match.
- When `Presence` ends or fails, Graft treats it as a disconnect: every remote
  service is withdrawn, in-flight calls fail with `RemoteUnavailable`, the
  protocol scope closes, and the connection is rebuilt on `retry`.
- Downstream teardown is handled by the core lifetimes, not by retrying inside a
  call.

## Test it

Use the in-memory protocols from `./testing` to run serve and connect in one
process; see [testing](testing.md). End the connection with `disconnect` and
assert the remote service withdraws and returns on reconnect.
