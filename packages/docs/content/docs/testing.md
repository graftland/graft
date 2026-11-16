---
title: Testing
description:
  Run each test in a fresh graph, and exercise remote wiring without sockets.
---

Test the behavior the design promises: which mounts reach `Active`, which
services are published, what is torn down in what order, and which failures are
retried. Every test gets a fresh graph.

## A fresh graph per test

```ts
import { Context, Effect, Layer, type Scope } from "effect"
import { expect, it } from "@effect/vitest"

import { Graft } from "@graftland/graft"

class Region extends Context.Service<Region, string>()("app/Region") {}

const run = <A, E>(effect: Effect.Effect<A, E, Graft.Graft | Scope.Scope>) =>
	effect.pipe(Effect.scoped, Effect.provide(Layer.fresh(Graft.layer)))

it.effect("publishes a config value", () =>
	run(
		Effect.gen(function* () {
			const publication = yield* Graft.publish(Region, "eu")
			yield* publication.await
			const value = yield* Graft.await(Region)
			expect(value).toBe("eu")
		}),
	),
)
```

| Rule                       | Why                                                               |
| -------------------------- | ----------------------------------------------------------------- |
| `Layer.fresh(Graft.layer)` | A graph shared between tests keeps mounts and publications alive. |
| `Effect.scoped` at the top | It keeps mounts alive for the test and unmounts them after it.    |
| `it.effect`                | Provides the runtime and `TestContext`.                           |

## Assert on states

Read `mount.state` and wait for the state the test is about. Do not read a
single snapshot and assume the mount has settled.

```ts
import { Effect, Option, Stream } from "effect"

import { Mount } from "@graftland/graft"

export const reached = (mount: Mount.Mount, tag: Mount.MountState["_tag"]) =>
	mount.state.pipe(
		Stream.filter((state) => state._tag === tag),
		Stream.runHead,
		Effect.flatMap(
			Option.match({
				onNone: () => Effect.die(new Error(`Mount ended before ${tag}`)),
				onSome: () => Effect.succeed(true),
			}),
		),
	)
```

- Use `mount.await` for "settled" and `mount.stable` for "nothing is loading
  below this mount".
- Record start and stop events in a `Ref` to assert teardown order.
- Read services through `Graft.use` or `Graft.await` to test the consumer view.

## Time and retries

Provide `TestContext` and advance the clock with `TestClock`. A mount with
`retry: Schedule.exponential(...)` then retries without a real delay.

## Test remote wiring in memory

The `testing` entry provides a pair of `effect/rpc` protocols that never become
bytes. Messages still go through the normal encode and decode path, and the
connection can be ended on demand.

```ts import.meta.vitest name="testing: call and disconnect in memory"
import { Context, Effect, Layer, Schema, Stream } from "effect"
import { Rpc, RpcClient, RpcGroup, RpcServer } from "effect/rpc"

import * as Testing from "@graftland/graft/testing"

const Add = Rpc.make("Add", {
	payload: Schema.Struct({ a: Schema.Finite, b: Schema.Finite }),
	success: Schema.Finite,
})

const Calculator = RpcGroup.make(Add)

const sum = await Effect.runPromise(
	Effect.gen(function* () {
		const protocol = yield* Testing.make
		const server = yield* Layer.build(
			Layer.merge(
				protocol.server,
				Calculator.toLayer({
					Add: ({ a, b }) => Effect.succeed(a + b),
				}),
			),
		)
		yield* RpcServer.make(Calculator).pipe(
			Effect.provideContext(server),
			Effect.forkScoped,
		)
		const client = yield* RpcClient.make(Calculator).pipe(
			Effect.provideServiceEffect(RpcClient.Protocol, protocol.client),
		)
		return yield* client.Add({ a: 1, b: 2 })
	}).pipe(Effect.scoped),
)
sum // => 3
```

| Member       | Use                                                      |
| ------------ | -------------------------------------------------------- |
| `make`       | Creates the protocol pair; belongs to the current scope. |
| `server`     | The server protocol layer, passed to `Remote.serve`.     |
| `client`     | Opens one connection; each run opens an independent one. |
| `disconnect` | Ends the current connection and fails calls in flight.   |

Because `client` opens a new connection each run, a mount with `retry`
reconnects to the in-memory server, so reconnection behavior is testable without
a port. Return `disconnect` from a test to check that remote services are
withdrawn and published again.
