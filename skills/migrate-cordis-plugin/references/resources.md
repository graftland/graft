# Resources, background work, timers and logging

Everything cordis disposes when a fiber unloads is a resource of the fork's
`Scope` in Graft. `apply` runs inside that scope.

## Disposables

| cordis                                                        | Graft                                                                               |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `apply` returns a disposer `() => void`                       | `yield* Effect.addFinalizer(() => ...)`                                             |
| `ctx.effect(() => { open(); return () => close() })`          | `yield* Effect.acquireRelease(open, close)`                                         |
| `ctx.effect(function* () { yield disposeA; yield disposeB })` | One `acquireRelease` per resource, in order; release runs in reverse                |
| `ctx.effect(async () => ...)` / async generator               | `acquireRelease` with an Effect acquire                                             |
| Calling the returned disposer early                           | `Effect.scoped` around that part, or a child `Scope` (`Scope.make` + `Scope.close`) |
| `ctx.on('dispose', ...)` (older cordis)                       | `Effect.addFinalizer`                                                               |
| `ctx.on('ready', ...)` (older cordis)                         | Code after setup in `apply`; startup ends when `apply` returns                      |

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

Wrap promise APIs with `Effect.tryPromise({ try, catch })` when they can reject
with an expected error, and with `Effect.promise` only when a rejection is a
defect.

## Background work

cordis plugins start loops with `ctx.effect`, unawaited promises, or timers. In
Graft, every long-running task goes through `Plugin.fork`:

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

- The fork's `FiberSet` owns the fiber; `Effect.asVoid` on the handle is fine.
- An unhandled failure of the task fails the whole fork, with its `Cause`, and
  triggers `retry`. Recover inside the task, before `Plugin.fork`.
- Pure interruption does not count as failure.
- A fire-and-forget promise in cordis (`ctx.foo().catch(log)`) becomes a task
  that handles its own errors: `Effect.catch(task, (e) => Effect.logError(e))`
  passed to `Plugin.fork`, or a failure that is allowed to fail the fork. Ask
  the user which.

## Timers (`@cordisjs/plugin-timer`)

| cordis                                    | Graft                                                    |
| ----------------------------------------- | -------------------------------------------------------- |
| `ctx.timeout(cb, ms)`                     | `Plugin.fork(Effect.delay(cb, ms))`                      |
| `await ctx.timeout(ms)` / `sleep(ms)`     | `yield* Effect.sleep(ms)`                                |
| `ctx.interval(cb, ms)`                    | `Plugin.fork(Effect.repeat(cb, Schedule.spaced(ms)))`    |
| `for await (const _ of ctx.interval(ms))` | `Stream.tick(ms)` consumed in a `Plugin.fork` task       |
| `ctx.throttle(fn, ms)`                    | `Stream.throttle` on a stream of calls, or a `Semaphore` |
| `ctx.debounce(fn, ms)`                    | `Stream.debounce` on a `Queue` or `PubSub` of calls      |
| Raw `setTimeout` / `setInterval`          | The same rows; raw timers outlive the scope              |

Effect durations accept numbers (milliseconds) and strings such as
`"5 seconds"`. Tests can drive them with `TestClock`.

## Logging (`ctx.logger`)

| cordis                                | Graft                                                                     |
| ------------------------------------- | ------------------------------------------------------------------------- |
| `ctx.logger.info(...)`                | `Effect.log(...)` / `Effect.logInfo(...)`                                 |
| `ctx.logger.warn` / `error` / `debug` | `Effect.logWarning` / `Effect.logError` / `Effect.logDebug`               |
| `ctx.logger('name')`                  | `Effect.annotateLogs({ component: "name" })` on the effect                |
| Logger plugin with console output     | The host's `Logger` layer; `graft start` installs a pretty console logger |
| Plugin name in each line              | Automatic: logs carry `graft.fork` and `graft.plugin` annotations         |

Log a failure's `Cause` (`Effect.logError(cause)`), not its message string.
