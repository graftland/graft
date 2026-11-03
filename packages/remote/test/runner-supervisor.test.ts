import type { SessionError } from "../src/internal/runner/Wire"
import { assert, layer } from "@effect/vitest"
import {
	Array,
	Cause,
	Deferred,
	Effect,
	Exit,
	Fiber,
	Queue,
	Option,
	Ref,
	Schema,
} from "effect"
import { SecureRandom } from "effect/crypto"
import { TestClock } from "effect/testing"
import * as Supervisor from "../src/internal/runner/Supervisor"
import * as Stores from "../src/internal/runner/Store"
import {
	Execution,
	Store,
	type ExecutionFailure,
	childOf,
	RemoteTerminationUnconfirmed,
	awaitTermination,
	defaults,
	ExecutionError,
	StateStorageError,
	type ExitStatus,
	type ProcessIdentity,
	type SessionRecord,
	type Termination,
} from "../src/internal/runner/model"

const key = { identity: "certificate-a", instance: "worker" }
const code = { name: "fixture", version: "1.0.0", digest: "fixture-digest" }
const exited: ExitStatus = { code: 0, signal: null }
const termination: Termination = {
	kind: "Killed",
	exit: { code: null, signal: "SIGKILL" },
	cause: Cause.empty,
}
const fake = (
	options: {
		readonly graceful?: boolean
		readonly killExit?: boolean
		readonly gate?: Deferred.Deferred<void>
		readonly recover?: (
			child: ProcessIdentity,
		) => Effect.Effect<Termination, ExecutionFailure>
	} = {},
) =>
	Effect.gen(function* () {
		const spawned = yield* Queue.bounded<{
			readonly exit: Deferred.Deferred<ExitStatus>
			readonly interrupted: Deferred.Deferred<void>
			readonly killed: Deferred.Deferred<void>
		}>(16)
		const count = yield* Ref.make(0)
		const closed = yield* Ref.make(0)
		const driver = Execution.of({
			spawn: (_handle, _request, _limits, register) =>
				Effect.gen(function* () {
					const pid = yield* Ref.updateAndGet(count, (n) => n + 1)
					const exit = yield* Deferred.make<ExitStatus>()
					const interrupted = yield* Deferred.make<void>()
					const killed = yield* Deferred.make<void>()
					yield* Effect.addFinalizer(() => Ref.update(closed, (n) => n + 1))
					yield* register({
						identity: {
							pid,
							start: { born: "start-" + pid, nonce: "nonce-" + pid },
						},
						exited: Deferred.await(exit),
						interrupt: Deferred.succeed(interrupted, undefined).pipe(
							Effect.andThen(
								options.graceful === false
									? Effect.void
									: Deferred.succeed(exit, exited),
							),
							Effect.asVoid,
						),
						kill: Deferred.succeed(killed, undefined).pipe(
							Effect.andThen(
								options.killExit === false
									? Effect.void
									: Deferred.succeed(exit, termination.exit),
							),
							Effect.asVoid,
						),
					}).pipe(Effect.uninterruptible)
					yield* Queue.offer(spawned, { exit, interrupted, killed })
					if (options.gate !== undefined) yield* Deferred.await(options.gate)
					return code
				}),
			recover: options.recover ?? (() => Effect.succeed(termination)),
		})
		return { driver, spawned, count, closed }
	})
const setup = (options: Parameters<typeof fake>[0] = {}) =>
	Effect.gen(function* () {
		const execution = yield* fake(options)
		const store = yield* Stores.memory
		const supervisor = yield* Supervisor.make().pipe(
			Effect.provideService(Store, store),
			Effect.provideService(Execution, execution.driver),
		)
		return { ...execution, store, supervisor }
	})
const reason = <A>(
	exit: Exit.Exit<A, SessionError>,
	expected: SessionError["_tag"],
) => {
	assert.isTrue(Exit.isFailure(exit))
	if (Exit.isFailure(exit))
		assert.isTrue(
			Array.some(
				exit.cause.reasons,
				(reason) => reason._tag === "Fail" && reason.error._tag === expected,
			),
		)
}
const orphan: SessionRecord = {
	version: 1,
	handle: { key, token: "old-token", generation: 7 },
	requestId: "old-open",
	leaseMillis: 15_000,
	limits: defaults,
	phase: "Loaded",
	child: {
		pid: 123,
		start: { born: "original-process-start", nonce: "original-nonce" },
	},
	load: { specifier: "fixture" },
	code,
}

layer(SecureRandom.layerWebCrypto)("runner session supervisor", (it) => {
	it.effect(
		"fences competing and forgotten Open requests before disturbing the current child",
		() =>
			Effect.gen(function* () {
				const { supervisor, store, spawned } = yield* setup()
				const initialGeneration = yield* supervisor.highWater(key)
				assert.isNull(initialGeneration)
				const first = yield* supervisor.open({ key, requestId: "first" })
				yield* supervisor.load(first.handle, { specifier: "fixture" })
				const unit = yield* Queue.take(spawned)
				const stale = yield* Effect.exit(
					supervisor.open({ key, requestId: "wrong", expectedGeneration: 2 }),
				)
				reason(stale, "StaleSession")
				assert.isFalse(Deferred.isDoneUnsafe(unit.interrupted))
				const results = yield* Effect.forEach(
					["a", "b"],
					(requestId) =>
						Effect.exit(
							supervisor.open({ key, requestId, expectedGeneration: 1 }),
						),
					{ concurrency: "unbounded" },
				)
				assert.lengthOf(Array.filter(results, Exit.isSuccess), 1)
				assert.lengthOf(Array.filter(results, Exit.isFailure), 1)
				for (const result of results)
					if (Exit.isFailure(result)) reason(result, "StaleSession")
				for (const generation of Array.range(2, 19)) {
					yield* supervisor.open({
						key,
						requestId: "request-" + generation,
						expectedGeneration: generation,
					})
					const retainedRecords = yield* store.list
					assert.lengthOf(retainedRecords, 1)
				}
				const latestGeneration = yield* supervisor.highWater(key)
				assert.equal(latestGeneration, 20)
				const forgotten = yield* Effect.exit(
					supervisor.open({ key, requestId: "first" }),
				)
				reason(forgotten, "StaleSession")
				const current = yield* supervisor.open({
					key,
					requestId: "request-19",
					expectedGeneration: 19,
				})
				assert.equal(current.handle.generation, 20)
			}).pipe(Effect.scoped),
	)

	it.effect(
		"reserves generations per authenticated identity and makes Open and Dispose idempotent",
		() =>
			Effect.gen(function* () {
				const { supervisor, store } = yield* setup()
				const opened = yield* Effect.forEach(
					Array.range(0, 19),
					() => supervisor.open({ key, requestId: "first" }),
					{ concurrency: "unbounded" },
				)
				const first = opened[0]!
				assert.isTrue(
					Array.every(
						opened,
						(record) => record.handle.token === first.handle.token,
					),
				)
				assert.equal(first.handle.generation, 1)
				assert.equal(first.leaseMillis, 15_000)
				const one = yield* supervisor.dispose(first.handle)
				const two = yield* supervisor.dispose(first.handle)
				assert.deepEqual(one, two)
				const second = yield* supervisor.open({
					key,
					requestId: "second",
					expectedGeneration: 1,
					limits: { control: 4, data: 32, log: 1 },
				})
				assert.equal(second.handle.generation, 2)
				assert.deepEqual(second.limits, { control: 4, data: 16, log: 1 })
				const duplicate = yield* Effect.exit(
					supervisor.open({ key, requestId: "first" }),
				)
				reason(duplicate, "StaleSession")
				const other = yield* supervisor.open({
					key: { ...key, identity: "certificate-b" },
					requestId: "first",
				})
				assert.equal(other.handle.generation, 1)
				const records = yield* store.list
				assert.lengthOf(records, 2)
				{
					const exit = yield* Effect.exit(supervisor.renew(first.handle))
					reason(exit, "StaleSession")
				}
				{
					const exit = yield* Effect.exit(
						supervisor.load(first.handle, { specifier: "fixture" }),
					)
					reason(exit, "StaleSession")
				}
			}).pipe(Effect.scoped),
	)
	it.effect(
		"shares concurrent Load and persists child identity before the reply",
		() =>
			Effect.gen(function* () {
				const gate = yield* Deferred.make<void>()
				const { supervisor, spawned, count } = yield* setup({ gate })
				const record = yield* supervisor.open({ key, requestId: "first" })
				const first = yield* Effect.forkScoped(
					supervisor.load(record.handle, { specifier: "fixture" }),
				)
				yield* Queue.take(spawned)
				const second = yield* Effect.forkScoped(
					supervisor.load(record.handle, { specifier: "fixture" }),
				)
				const status = yield* supervisor.status(record.handle)
				assert.equal(status.phase, "Loading")
				assert.deepEqual(Option.getOrUndefined(childOf(status)), {
					pid: 1,
					start: { born: "start-1", nonce: "nonce-1" },
				})
				{
					const exit = yield* Effect.exit(
						supervisor.load(record.handle, { specifier: "different" }),
					)
					reason(exit, "SessionConflict")
				}
				yield* Deferred.succeed(gate, undefined)
				const results = yield* Effect.all([
					Fiber.join(first),
					Fiber.join(second),
				])
				assert.deepEqual(results, [code, code])
				const starts = yield* Ref.get(count)
				assert.equal(starts, 1)
				const stopped = yield* supervisor.dispose(record.handle)
				assert.equal(stopped.kind, "Exited")
			}).pipe(Effect.scoped),
	)
	it.effect(
		"renews with monotonic durations, rejects late renewal, and kills after the grace period",
		() =>
			Effect.gen(function* () {
				const { supervisor, spawned } = yield* setup({ graceful: false })
				const record = yield* supervisor.open({ key, requestId: "first" })
				yield* supervisor.load(record.handle, { specifier: "fixture" })
				const unit = yield* Queue.take(spawned)
				yield* TestClock.adjust("10 seconds")
				yield* supervisor.renew(record.handle)
				yield* TestClock.adjust("14 seconds")
				assert.isFalse(Deferred.isDoneUnsafe(unit.interrupted))
				yield* TestClock.adjust("1 second")
				yield* Deferred.await(unit.interrupted)
				{
					const exit = yield* Effect.exit(supervisor.renew(record.handle))
					reason(exit, "LeaseExpired")
				}
				assert.isFalse(Deferred.isDoneUnsafe(unit.killed))
				yield* TestClock.adjust("5 seconds")
				const stopped = yield* supervisor.dispose(record.handle)
				assert.equal(stopped.kind, "Killed")
				assert.isTrue(Deferred.isDoneUnsafe(unit.killed))
			}).pipe(Effect.scoped),
	)
	it.effect(
		"waits for old exit confirmation without blocking another logical instance",
		() =>
			Effect.gen(function* () {
				const { supervisor, spawned } = yield* setup({ graceful: false })
				const first = yield* supervisor.open({ key, requestId: "first" })
				yield* supervisor.load(first.handle, { specifier: "fixture" })
				const unit = yield* Queue.take(spawned)
				const replacing = yield* Effect.forkScoped(
					supervisor.open({
						key,
						requestId: "replacement",
						expectedGeneration: 1,
					}),
				)
				yield* Deferred.await(unit.interrupted)
				assert.equal(replacing.pollUnsafe(), undefined)
				const other = yield* supervisor.open({
					key: { ...key, instance: "other" },
					requestId: "other",
				})
				assert.equal(other.handle.generation, 1)
				yield* Deferred.succeed(unit.exit, exited)
				const next = yield* Fiber.join(replacing)
				assert.equal(next.handle.generation, 2)
			}).pipe(Effect.scoped),
	)
	it.effect(
		"expires and terminates a child even when Load has not returned",
		() =>
			Effect.gen(function* () {
				const gate = yield* Deferred.make<void>()
				const { supervisor, spawned } = yield* setup({ gate })
				const record = yield* supervisor.open({ key, requestId: "first" })
				const loading = yield* Effect.forkScoped(
					supervisor.load(record.handle, { specifier: "fixture" }),
				)
				const unit = yield* Queue.take(spawned)
				yield* TestClock.adjust("15 seconds")
				yield* Deferred.await(unit.interrupted)
				const result = yield* Fiber.await(loading)
				assert.isTrue(Exit.isFailure(result))
				const stopped = yield* supervisor.dispose(record.handle)
				assert.equal(stopped.kind, "Exited")
			}).pipe(Effect.scoped),
	)
	it.effect(
		"recovers stored process identities before exposing admission and never resumes an old lease",
		() =>
			Effect.gen(function* () {
				const store = yield* Stores.memory
				yield* store.save(orphan)
				const seen = yield* Deferred.make<ProcessIdentity>()
				const release = yield* Deferred.make<void>()
				const { driver, count } = yield* fake({
					recover: (child) =>
						Deferred.succeed(seen, child).pipe(
							Effect.andThen(Deferred.await(release)),
							Effect.as(termination),
						),
				})
				const constructing = yield* Supervisor.make().pipe(
					Effect.provideService(Store, store),
					Effect.provideService(Execution, driver),
					Effect.forkScoped,
				)
				const identity = yield* Deferred.await(seen)
				assert.deepEqual(identity, orphan.child)
				assert.equal(constructing.pollUnsafe(), undefined)
				yield* Deferred.succeed(release, undefined)
				const supervisor = yield* Fiber.join(constructing)
				const prior = yield* supervisor.open({ key, requestId: "old-open" })
				assert.equal(prior.phase, "Stopped")
				const next = yield* supervisor.open({
					key,
					requestId: "new-open",
					expectedGeneration: 7,
				})
				assert.equal(next.handle.generation, 8)
				const starts = yield* Ref.get(count)
				assert.equal(starts, 0)
			}).pipe(Effect.scoped),
	)
	it.effect("refuses startup when orphan exit cannot be confirmed", () =>
		Effect.gen(function* () {
			const store = yield* Stores.memory
			yield* store.save(orphan)
			const { driver } = yield* fake({
				recover: () =>
					Effect.fail(
						ExecutionError.make({
							detail: "Recovery sentinel",
							cause: Cause.empty,
						}),
					),
			})
			const exit = yield* Supervisor.make().pipe(
				Effect.provideService(Store, store),
				Effect.provideService(Execution, driver),
				Effect.exit,
			)
			reason(exit, "TerminationUnconfirmed")
			const records = yield* store.list
			assert.equal(records[0]!.phase, "Loaded")
		}).pipe(Effect.scoped),
	)
	it.effect(
		"reports unconfirmed termination after T plus margin and retains the transport cause",
		() =>
			Effect.gen(function* () {
				const transport = ExecutionError.make({
					detail: "Connection lost",
					cause: Cause.empty,
				})
				const waiting = yield* awaitTermination(
					orphan.handle,
					Effect.fail(transport),
					15_000,
					2_000,
				).pipe(Effect.forkScoped)
				yield* TestClock.adjust("16 seconds")
				assert.equal(waiting.pollUnsafe(), undefined)
				yield* TestClock.adjust("1 second")
				const result = yield* Fiber.await(waiting)
				assert.isTrue(Exit.isFailure(result))
				if (Exit.isFailure(result)) {
					assert.isTrue(
						Array.some(
							result.cause.reasons,
							(reason) => reason._tag === "Fail" && reason.error === transport,
						),
					)
					assert.isTrue(
						Array.some(
							result.cause.reasons,
							(reason) =>
								reason._tag === "Fail" &&
								Schema.is(RemoteTerminationUnconfirmed)(reason.error),
						),
					)
				}
			}).pipe(Effect.scoped),
	)
	it.effect("stops loaded units before closing their execution scopes", () =>
		Effect.gen(function* () {
			const execution = yield* fake()
			const store = yield* Stores.memory
			yield* Effect.scoped(
				Effect.gen(function* () {
					const supervisor = yield* Supervisor.make().pipe(
						Effect.provideService(Store, store),
						Effect.provideService(Execution, execution.driver),
					)
					const record = yield* supervisor.open({ key, requestId: "first" })
					yield* supervisor.load(record.handle, { specifier: "fixture" })
				}),
			)
			const unit = yield* Queue.take(execution.spawned)
			assert.isTrue(Deferred.isDoneUnsafe(unit.interrupted))
			const closed = yield* Ref.get(execution.closed)
			assert.equal(closed, 1)
			const records = yield* store.list
			assert.equal(records[0]!.phase, "Stopped")
			assert.equal(
				"termination" in records[0]! ? records[0].termination.kind : undefined,
				"Exited",
			)
		}).pipe(Effect.scoped),
	)
	it.effect(
		"never admits another generation when kill did not confirm exit",
		() =>
			Effect.gen(function* () {
				const store = yield* Stores.memory
				const execution = yield* fake({ graceful: false, killExit: false })
				const cleanup = yield* Effect.exit(
					Effect.scoped(
						Effect.gen(function* () {
							const supervisor = yield* Supervisor.make().pipe(
								Effect.provideService(Store, store),
								Effect.provideService(Execution, execution.driver),
							)
							const record = yield* supervisor.open({ key, requestId: "first" })
							yield* supervisor.load(record.handle, { specifier: "fixture" })
							const unit = yield* Queue.take(execution.spawned)
							const stopping = yield* Effect.forkScoped(
								supervisor.dispose(record.handle),
							)
							yield* Deferred.await(unit.interrupted)
							yield* TestClock.adjust("5 seconds")
							yield* Deferred.await(unit.killed)
							assert.equal(stopping.pollUnsafe(), undefined)
							yield* TestClock.adjust("5 seconds")
							const result = yield* Fiber.await(stopping)
							reason(result, "TerminationUnconfirmed")
							const next = yield* Effect.exit(
								supervisor.open({
									key,
									requestId: "next",
									expectedGeneration: 1,
								}),
							)
							reason(next, "TerminationUnconfirmed")
							const status = yield* supervisor.status(record.handle)
							assert.equal(status.phase, "Stopping")
							assert.notProperty(status, "termination")
						}),
					),
				)
				assert.isTrue(Exit.isFailure(cleanup))
				const records = yield* store.list
				assert.lengthOf(records, 1)
			}).pipe(Effect.scoped),
	)
	it.effect(
		"does not reuse a generation after storage commits but reports failure",
		() =>
			Effect.gen(function* () {
				const store = yield* Stores.memory
				const execution = yield* fake()
				const failedStore = Store.of({
					list: store.list,
					save: (record) =>
						store.save(record).pipe(
							Effect.andThen(
								Effect.fail(
									StateStorageError.make({
										detail: "Commit acknowledgement lost",
										cause: Cause.empty,
									}),
								),
							),
						),
				})
				const first = yield* Effect.exit(
					Effect.scoped(
						Effect.gen(function* () {
							const supervisor = yield* Supervisor.make().pipe(
								Effect.provideService(Store, failedStore),
								Effect.provideService(Execution, execution.driver),
							)
							yield* supervisor.open({ key, requestId: "first" })
						}),
					),
				)
				assert.isTrue(Exit.isFailure(first))
				const supervisor = yield* Supervisor.make().pipe(
					Effect.provideService(Store, store),
					Effect.provideService(Execution, execution.driver),
				)
				const next = yield* supervisor.open({
					key,
					requestId: "next",
					expectedGeneration: 1,
				})
				assert.equal(next.handle.generation, 2)
				const count = yield* Ref.get(execution.count)
				assert.equal(count, 0)
			}).pipe(Effect.scoped),
	)
	it.effect(
		"records spontaneous process exit without signaling an already exited unit",
		() =>
			Effect.gen(function* () {
				const { supervisor, spawned } = yield* setup()
				const record = yield* supervisor.open({ key, requestId: "first" })
				yield* supervisor.load(record.handle, { specifier: "fixture" })
				const unit = yield* Queue.take(spawned)
				yield* Deferred.succeed(unit.exit, { code: 23, signal: null })
				yield* TestClock.adjust("0 millis")
				const result = yield* supervisor.dispose(record.handle)
				assert.equal(result.kind, "Exited")
				assert.equal(result.exit.code, 23)
				assert.isFalse(Deferred.isDoneUnsafe(unit.interrupted))
				assert.isFalse(Deferred.isDoneUnsafe(unit.killed))
			}).pipe(Effect.scoped),
	)
	it.effect(
		"completes Load with both causes when recording the launch failure also fails",
		() =>
			Effect.gen(function* () {
				const store = yield* Stores.memory
				const execution = yield* fake()
				const failing = Store.of({
					list: store.list,
					save: (record) =>
						(record.phase === "Stopping" || record.phase === "Stopped") &&
						record.reason._tag === "LoadFailed"
							? Effect.fail(
									StateStorageError.make({
										detail: "Failure journal sentinel",
										cause: Cause.empty,
									}),
								)
							: store.save(record),
				})
				const driver = Execution.of({
					...execution.driver,
					spawn: (handle, request, limits, register) =>
						execution.driver.spawn(handle, request, limits, register).pipe(
							Effect.andThen(
								Effect.fail(
									ExecutionError.make({
										detail: "Launch sentinel",
										cause: Cause.empty,
									}),
								),
							),
						),
				})
				const scopeExit = yield* Effect.exit(
					Effect.scoped(
						Effect.gen(function* () {
							const supervisor = yield* Supervisor.make().pipe(
								Effect.provideService(Store, failing),
								Effect.provideService(Execution, driver),
							)
							const record = yield* supervisor.open({ key, requestId: "first" })
							const result = yield* Effect.exit(
								supervisor.load(record.handle, { specifier: "fixture" }),
							)
							assert.isTrue(Exit.isFailure(result))
							if (Exit.isFailure(result)) {
								assert.include(Cause.pretty(result.cause), "Launch sentinel")
								assert.include(
									Cause.pretty(result.cause),
									"Failure journal sentinel",
								)
							}
						}),
					),
				)
				assert.isTrue(Exit.isFailure(scopeExit))
				const closed = yield* Ref.get(execution.closed)
				assert.equal(closed, 1)
			}).pipe(Effect.scoped),
	)
	it.effect(
		"retains graceful-shutdown failure after a confirmed forced exit",
		() =>
			Effect.gen(function* () {
				const store = yield* Stores.memory
				const execution = yield* fake({ graceful: false })
				const sentinel = ExecutionError.make({
					detail: "Shutdown sentinel",
					cause: Cause.empty,
				})
				const driver = Execution.of({
					...execution.driver,
					spawn: (handle, request, limits, register) =>
						execution.driver.spawn(handle, request, limits, (unit) =>
							register({
								...unit,
								interrupt: unit.interrupt.pipe(
									Effect.andThen(Effect.fail(sentinel)),
								),
							}),
						),
				})
				const scopeExit = yield* Effect.exit(
					Effect.scoped(
						Effect.gen(function* () {
							const supervisor = yield* Supervisor.make().pipe(
								Effect.provideService(Store, store),
								Effect.provideService(Execution, driver),
							)
							const record = yield* supervisor.open({ key, requestId: "first" })
							yield* supervisor.load(record.handle, { specifier: "fixture" })
							const result = yield* supervisor.dispose(record.handle)
							assert.equal(result.kind, "Killed")
							assert.isTrue(
								Array.some(
									result.cause.reasons,
									(reason) =>
										reason._tag === "Fail" && reason.error === sentinel,
								),
							)
						}),
					),
				)
				assert.isTrue(Exit.isFailure(scopeExit))
				if (Exit.isFailure(scopeExit))
					assert.include(Cause.pretty(scopeExit.cause), "Shutdown sentinel")
			}).pipe(Effect.scoped),
	)
	it.effect(
		"bounds termination confirmation even when the transport never reports failure",
		() =>
			Effect.gen(function* () {
				const waiting = yield* awaitTermination(
					orphan.handle,
					Effect.never,
					15_000,
					2_000,
				).pipe(Effect.forkScoped)
				yield* TestClock.adjust("16 seconds")
				assert.equal(waiting.pollUnsafe(), undefined)
				yield* TestClock.adjust("1 second")
				const result = yield* Fiber.await(waiting)
				assert.isTrue(Exit.isFailure(result))
				if (Exit.isFailure(result))
					assert.isTrue(
						Array.some(
							result.cause.reasons,
							(reason) =>
								reason._tag === "Fail" &&
								Schema.is(RemoteTerminationUnconfirmed)(reason.error),
						),
					)
			}).pipe(Effect.scoped),
	)
})
