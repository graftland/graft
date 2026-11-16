# Consuming services

Inside a mounted layer, a service is just a requirement: add the key to
`requires` and read it in the layer or from a `Graft.fork`. Outside a mount — in
ordinary Effect code — a service can appear and disappear, so pick the operation
that matches how long you need it.

## Define the key

```ts
import { Clock, Context, Effect } from "effect"

export class Time extends Context.Service<
	Time,
	{ readonly now: Effect.Effect<number> }
>()("@acme/app/Time") {}
```

- The string is the key's identity, everywhere including realms. Scope it to the
  package.
- Methods return Effects. A method runs in the caller's fiber, so it sees the
  caller's [intercepts](isolation.md).
- Describe expected failures with `Schema.TaggedError` or `Data.TaggedError` in
  the method types.

## Reading a service across lifetimes

| Operation                      | Use when                                                               |
| ------------------------------ | ---------------------------------------------------------------------- |
| `Graft.await(Key)`             | Wait once for the service to be available, then take its value.        |
| `Graft.use(Key, f)`            | Run `f` once with the service, holding it until `f` finishes.          |
| `Graft.whileAvailable(Key, f)` | Run `f` whenever the service is available, restart on each new value.  |
| `Graft.watch(Key)`             | Observe availability as `Stream<Option<S>>`, some then none then some. |

```ts
const uptime = Graft.whileAvailable(Time, (time) =>
	Effect.gen(function* () {
		const started = yield* time.now
		yield* Effect.addFinalizer(() =>
			Effect.flatMap(time.now, (now) =>
				Effect.log(`Ran for ${now - started} ms`),
			),
		)
	}),
)
```

- `watch` emits the current availability first, then every change after it.
- `await` does not hold a lease: it returns a value that may be withdrawn
  immediately after; use `use` or `whileAvailable` when you need it held for the
  duration of work.
- `use` races `f` against withdrawal. If the service goes away first, `f` is
  interrupted and `use` fails with `ServiceWithdrawn`.
- `whileAvailable` treats withdrawal as an interruption and waits for the next
  value. If `f` fails, it fails; if it returns, it waits for the next value.
- `watch` emits the current availability, then every change. It only sees
  services in the graph, not the environment `Graft.layer` was built in.

## Background fibers

Inside a mount, work that outlives the current fiber goes through `Graft.fork`:

```ts
const program = Effect.gen(function* () {
	const fiber = yield* Graft.fork(Effect.forever(Effect.flatMap(poll, handler)))
})
```

- The fiber is owned by the current mount; it is interrupted when the mount is
  torn down.
- If it fails, the mount enters `Failed`; add `retry` on the mount to rebuild.
- `Graft.fork` requires a mounted layer; it dies outside one. A resource whose
  lifetime is the mount uses `Effect.acquireRelease` instead.

## Withdrawal order

When a requirement changes or a provider is unmounted:

1. The provider's services are withdrawn in one transaction.
2. Consumers tear down first: each drains its finalizers and stops, using an
   environment fallback if one exists, waiting in `Pending` for a required
   service, or continuing without an optional one.
3. The provider's background fibers stop, then its scope closes.

Consumers never see a half-stopped provider, whatever order finalizers were
registered in.

## Values vs. services

Config is not special: publish it as a service with `Graft.publish` and require
the key in the layers that read it. Use a real service, published from a layer,
when the value has resources of its own or methods that run code.
