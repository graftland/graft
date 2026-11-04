# Resources, background work, timers and logging

## Resources

Everything `apply` acquires is released when the fork stops, in reverse order.

```ts
apply: ({ port }) =>
	Effect.gen(function* () {
		const server = yield* Effect.acquireRelease(
			Effect.promise(() => listen(port)),
			(server) => Effect.promise(() => server.close()),
		)
		yield* Effect.log(`listening on ${server.port}`)
	})
```

| Need                                    | Use                                                    |
| --------------------------------------- | ------------------------------------------------------ |
| Open and close a resource               | `Effect.acquireRelease(open, close)`                   |
| Run something on stop                   | `Effect.addFinalizer(() => ...)`                       |
| Release part of the work earlier        | `Effect.scoped` around it, or a child `Scope`          |
| Wrap a promise that rejects normally    | `Effect.tryPromise({ try, catch })` with a typed error |
| Wrap a promise whose rejection is a bug | `Effect.promise`                                       |

## Background work

Every long-running task goes through `Plugin.fork`:

```ts
apply: () =>
	Effect.gen(function* () {
		const feed = yield* Feed
		yield* feed.messages.pipe(
			Stream.runForEach((message) => Event.emit(Message, message)),
			Plugin.fork,
		)
	})
```

- The fork keeps the fiber in its `FiberSet`; dropping the handle with
  `Effect.asVoid` is fine.
- The task inherits the services in `inject` and has its own `Scope`.
- An unhandled failure or defect fails the whole fork with its `Cause`, then
  `retry` applies with a fresh task group. Interruption alone is not failure.
- To survive an error, catch it inside the task before `Plugin.fork`:

```ts
const prices = Plugin.make({
	name: "prices",
	apply: () =>
		fetchPrices.pipe(
			Effect.catch((error) => Effect.logWarning("poll failed", error)),
			Effect.repeat(Schedule.spaced("5 seconds")),
			Plugin.fork,
			Effect.asVoid,
		),
})
```

Catching the error of the launch effect or of a joined fiber does not undo
supervision. A bare `Effect.forkScoped` ends with the scope but hides its
failures from Graft; use it only when you watch its `Exit` yourself.

## Timers

| Need                       | Use                                                           |
| -------------------------- | ------------------------------------------------------------- |
| Wait                       | `yield* Effect.sleep("2 seconds")`                            |
| Run once later             | `Plugin.fork(Effect.delay(task, "2 seconds"))`                |
| Repeat                     | `Plugin.fork(Effect.repeat(task, Schedule.spaced(ms)))`       |
| Consume ticks              | `Stream.tick(ms)` in a `Plugin.fork` task                     |
| Throttle or debounce calls | `Stream.throttle` / `Stream.debounce` over a `Queue` of calls |
| Time out                   | `Effect.timeout`                                              |

Durations accept milliseconds or strings such as `"5 seconds"`. Tests drive them
with `TestClock`. Raw `setTimeout` and `setInterval` outlive the scope.

## Logging

- `Effect.log`, `logInfo`, `logWarning`, `logError`, `logDebug`.
- Lines a plugin writes carry `graft.fork` and `graft.plugin` annotations
  automatically; add more with `Effect.annotateLogs`.
- Log a failure's `Cause`, not its message:
  `Effect.logError("sync failed", cause)`.
- The host chooses output. `graft start` prints readable lines; an embedding
  host installs a `Logger` layer. `graft.yml` can set
  `effect/References/MinimumLogLevel` per entry.
- `Graft.logs` streams recent log entries (the last 1000, then live), for admin
  plugins and tests.
