# Testing

Test behavior at the level the design promises: which mounts reach `Active`,
which services are published, what is torn down in what order, and which
failures are retried. Each test runs in a fresh graph.

## A fresh graph per test

```ts
import { Effect, Layer } from "effect"
import { expect, it } from "@effect/vitest"

import { Graft, Mount } from "@graftland/graft"

const run = <A, E>(effect: Effect.Effect<A, E, Graft.Graft | Scope.Scope>) =>
	effect.pipe(Effect.scoped, Effect.provide(Layer.fresh(Graft.layer)))

it.effect("mounts pricing while the database is available", () =>
	run(
		Effect.gen(function* () {
			const db = yield* Graft.publish(Database, fakeDb)
			const pricing = yield* Graft.mount(pricingLayer, { requires: [Database] })
			yield* pricing.await
			expect(yield* reach(pricing, "Active")).toBe(true)
		}),
	),
)
```

- `Layer.fresh` gives each test its own graph; never share one between tests.
- `@effect/vitest`'s `it.effect` provides the runtime and `TestContext`.
- `Effect.scoped` at the top keeps mounts alive for the test and unmounts them
  after.

## Assert on states and services

```ts
const reach = (mount: Mount.Mount, tag: Mount.MountState["_tag"]) =>
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

- Record start and stop events in a `Ref` to assert teardown order.
- Use `mount.await` for "settled", `mount.stable` for "nothing loading below".
- Read services through `Graft.use` / `Graft.await` to test the consumer view.

## Time and retries

Provide `TestContext` and advance the clock with `TestClock`; a mount with
`retry: Schedule.exponential(...)` retries when time advances, without real
delay.

## Remote and in-memory transport

`@graftland/graft/testing` provides an in-memory pair of `effect/rpc` protocols,
so `Remote.serve` and `Remote.connect` run in one process without sockets, HTTP
or workers. Messages still go through encode/decode but never become bytes.

```ts
import { Remote } from "@graftland/graft/rpc"
import * as Testing from "@graftland/graft/testing"

const program = Effect.gen(function* () {
	const protocol = yield* Testing.make
	const serving = yield* Remote.serve({
		services: [PricingRemote],
		protocol: protocol.server,
	})
	const connected = yield* Remote.connect({
		services: [PricingRemote],
		protocol: protocol.client,
		retry: Schedule.exponential("10 millis"),
	})
	yield* connected.await
	// ... assert the remote service is published and callable
	yield* protocol.disconnect
})
```

- `Testing.make` is an `Effect` (`Scope`), not a function; it returns
  `{ server, client, disconnect }`.
- `server` is a `Layer<RpcServer.Protocol>` for `Remote.serve`.
- `client` is an `Effect` that opens a **new** connection each time it runs, so
  each reconnect attempt is independent.
- `disconnect` ends the current connection: calls in flight fail (with
  `RemoteUnavailable` through a remote service) and the next `client` run opens
  a fresh connection.
- Use it to test contracts, availability mirroring and reconnection without a
  child process. For real subprocess or worker behavior use [node](node.md) in
  an integration test.

## Checklist

- Every promised behavior has a test: waiting, building, tearing down, updating
  with `set`, the failures it handles.
- Lifecycle tests assert order and cleanup; do not weaken an assertion to make a
  race pass — fix the implementation or the synchronization.
- No test depends on real time; use `TestClock`.
