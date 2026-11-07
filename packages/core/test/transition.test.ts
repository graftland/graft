import {
	Array,
	Cause,
	Clock,
	Context,
	Deferred,
	Duration,
	Effect,
	Equal,
	Exit,
	Fiber,
	HashMap,
	MutableRef,
	Option,
	Order,
	Ref,
	Scheduler,
	Scope,
	Stream,
	String,
	TxRef,
} from "effect"
import { TestClock } from "effect/testing"
import { assert, it } from "@effect/vitest"

import { Graft, Plugin, Transition, Trust } from "../src/index"
import { RuntimeContext } from "../src/internal/runtimeContext"
import * as Snapshots from "../src/internal/snapshot.ts"
import { run } from "./utils"

class Value extends Context.Service<
	Value,
	{
		readonly read: Effect.Effect<
			string,
			| Transition.DriverError
			| Transition.Unavailable
			| Transition.AdmissionRejected
			| import("../src/Trust").Unapproved
		>
	}
>()("@graftland/graft/test/transition.test/Value") {}
const candidate = (identity: string): Transition.Candidate => ({
	driver: "test",
	identity,
	deployment: undefined,
})
const problem = Transition.DriverError.make({
	cause: Cause.combine(Cause.fail("broken"), Cause.die("defect")),
})
const policy: Transition.Policy = {
	total: 10_000,
	startup: 100,
	probe: 100,
	trial: 0,
	drain: 100,
	stop: 100,
	terminate: 100,
	probes: ["health"],
}
interface Control {
	readonly id: number
	readonly exited: Deferred.Deferred<Transition.Termination>
	readonly failed: Deferred.Deferred<never, Transition.DriverError>
	readonly entered: Deferred.Deferred<void>
	readonly read: Deferred.Deferred<string>
	readonly stopped: Deferred.Deferred<void>
	readonly terminating: Deferred.Deferred<void>
}
interface Script {
	readonly allocate?: Effect.Effect<void, Transition.DriverError, Scope.Scope>
	readonly serve?: Effect.Effect<void, Transition.DriverError>
	readonly missingServices?: boolean
	readonly exitAtReadiness?: boolean
	readonly start?: Effect.Effect<
		void,
		Transition.DriverError,
		import("effect").Scope.Scope
	>
	readonly describe?: Effect.Effect<
		Transition.Description,
		Transition.DriverError
	>
	readonly ready?: Effect.Effect<void, Transition.DriverError>
	readonly probe?: Effect.Effect<void, Transition.DriverError>
	readonly stop?: Effect.Effect<void, Transition.DriverError>
	readonly noExit?: boolean
	readonly holdRead?: boolean
}
const setup = Effect.fnUntraced(function* (
	script: (id: number) => Script = () => ({}),
	maxInFlight = 256,
) {
	const controls = yield* Ref.make<ReadonlyArray<Control>>([])
	const allocations = yield* Ref.make(0)
	const driver: Transition.Driver = {
		name: "test",
		allocate: (artifact, id) =>
			Effect.gen(function* () {
				yield* Ref.update(allocations, (n) => n + 1)
				const options = script(id)
				yield* options.allocate ?? Effect.void
				const control: Control = {
					id,
					exited: yield* Deferred.make<Transition.Termination>(),
					failed: yield* Deferred.make<never, Transition.DriverError>(),
					entered: yield* Deferred.make<void>(),
					read: yield* Deferred.make<string>(),
					stopped: yield* Deferred.make<void>(),
					terminating: yield* Deferred.make<void>(),
				}
				yield* Ref.update(controls, Array.append(control))
				return {
					start: options.start ?? Effect.void,
					describe:
						options.describe ??
						Effect.succeed({
							overlap: true,
							provides: [{ name: "read", version: 1 }],
						}),
					serve: options.serve ?? Effect.void,
					ready: (options.exitAtReadiness === true
						? Deferred.succeed(control.exited, {
								unit: `unit-${id}`,
								state: "Exited",
							}).pipe(Effect.andThen(Effect.never))
						: (options.ready ?? Effect.void)
					).pipe(
						Effect.as(
							options.missingServices === true
								? Context.empty()
								: Context.make(Value, {
										read: Deferred.succeed(control.entered, undefined).pipe(
											Effect.andThen(
												options.holdRead === true
													? Deferred.await(control.read)
													: Effect.succeed(artifact.identity),
											),
										),
									}),
						),
					),
					probe: () => options.probe ?? Effect.void,
					stop: Deferred.succeed(control.stopped, undefined).pipe(
						Effect.andThen(options.stop ?? Effect.void),
					),
					terminate: Deferred.succeed(control.terminating, undefined).pipe(
						Effect.andThen(
							options.noExit === true
								? Effect.void
								: Deferred.succeed(control.exited, {
										unit: `unit-${id}`,
										state: "Exited",
									}).pipe(Effect.asVoid),
						),
					),
					exited: Deferred.await(control.exited),
					failure: Deferred.await(control.failed),
				}
			}),
	}
	const definition = Plugin.make({
		name: "managed",
		apply: () =>
			Transition.registerDriver(driver, {
				instance: "integration",
				initial: candidate("old"),
				required: [{ name: "read", version: 1 }],
				policy,
				maxInFlight,
				facades: [
					Transition.facade(Value, (invoke) => ({
						read: invoke((service) => service.read),
					})),
				],
			}),
	})
	const fork = yield* Graft.plugin(definition)
	yield* fork.await
	const service = yield* Deferred.make<Context.Service.Shape<typeof Value>>()
	const activations = yield* Ref.make(0)
	const consumer = yield* Graft.plugin(
		Plugin.make({
			name: "consumer",
			inject: [Value],
			apply: () =>
				Effect.gen(function* () {
					yield* Ref.update(activations, (n) => n + 1)
					const value = yield* Value
					yield* Deferred.succeed(service, value)
				}),
		}),
	)
	yield* consumer.await
	const value = yield* Deferred.await(service)
	const control = (id: number) =>
		Ref.get(controls).pipe(
			Effect.map((all) =>
				Option.getOrThrow(Array.findFirst(all, (item) => item.id === id)),
			),
		)
	return {
		fork,
		definition,
		value,
		activations,
		controls,
		control,
		allocations,
		request: (overrides?: Partial<Transition.Policy>) =>
			Graft.transition({
				target: fork.id,
				candidate: candidate("new"),
				policy: overrides,
			}),
	}
})

it.effect(
	"keeps the fork-owned facade and consumer alive across accepted generations",
	() =>
		Effect.gen(function* () {
			const h = yield* setup()
			const constructedBeforeCutover = h.value.read
			const observed1 = yield* constructedBeforeCutover
			assert.equal(observed1, "old")
			const outcome = yield* h.request()
			assert.equal(outcome._tag, "Accepted")
			const observed2 = yield* constructedBeforeCutover
			assert.equal(observed2, "new")
			const observed3 = yield* Ref.get(h.activations)
			assert.equal(observed3, 1)
			const generations = yield* Stream.runHead(h.fork.generations)
			assert.deepEqual(
				Array.map(Option.getOrThrow(generations), (g) => g.state),
				["Terminated", "Serving"],
			)
			assert.isTrue(
				Array.some(outcome.evidence, (e) => e.termination?.unit === "unit-1"),
			)
		}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)

it.effect("admits one transition and never queues a second request", () =>
	Effect.gen(function* () {
		const gate = yield* Deferred.make<void>()
		const entered = yield* Deferred.make<void>()
		const h = yield* setup((id) =>
			id === 2
				? {
						ready: Deferred.succeed(entered, undefined).pipe(
							Effect.andThen(Deferred.await(gate)),
						),
					}
				: {},
		)
		const first = yield* Effect.forkScoped(h.request())
		yield* Deferred.await(entered)
		const busy = yield* h.request()
		assert.deepEqual(busy, {
			_tag: "Aborted",
			reason: "Busy",
			phase: "Admission",
			evidence: [],
		})
		const observed4 = yield* Ref.get(h.allocations)
		assert.equal(observed4, 2)
		yield* Deferred.succeed(gate, undefined)
		const observed5 = yield* Fiber.join(first)
		assert.equal(observed5._tag, "Accepted")
	}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)

it.effect(
	"keeps each admitted call on its attempt and drains before terminating",
	() =>
		Effect.gen(function* () {
			const h = yield* setup((id) => ({ holdRead: id === 1 }))
			const old = yield* h.control(1)
			const running = yield* Effect.forkScoped(h.value.read)
			yield* Deferred.await(old.entered)
			const transition = yield* Effect.forkScoped(h.request())
			yield* h.fork.generations.pipe(
				Stream.filter((all) =>
					Array.some(all, (g) => g.attempt === 1 && g.state === "Draining"),
				),
				Stream.runHead,
			)
			const observed6 = yield* h.value.read
			assert.equal(observed6, "new")
			const observed7 = yield* Deferred.isDone(old.exited)
			assert.isFalse(observed7)
			yield* Deferred.succeed(old.read, "completed on old")
			const observed8 = yield* Fiber.join(running)
			assert.equal(observed8, "completed on old")
			const observed9 = yield* Fiber.join(transition)
			assert.equal(observed9._tag, "Accepted")
		}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)

for (const failure of [
	"start",
	"ready",
	"probe",
	"contract",
	"overlap",
] as const) {
	it.effect(`aborts before cutover when candidate ${failure} fails`, () =>
		Effect.gen(function* () {
			const h = yield* setup((id) =>
				id !== 2
					? {}
					: failure === "contract"
						? { describe: Effect.succeed({ overlap: true, provides: [] }) }
						: failure === "overlap"
							? { describe: Effect.succeed({ overlap: false, provides: [] }) }
							: { [failure]: Effect.fail(problem) },
			)
			const outcome = yield* h.request()
			assert.equal(outcome._tag, "Aborted")
			const observed10 = yield* h.value.read
			assert.equal(observed10, "old")
			const next = yield* h.control(2)
			const observed11 = yield* Deferred.isDone(next.exited)
			assert.isTrue(observed11)
		}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
	)
}

for (const recoveryFails of [false, true]) {
	it.effect(
		recoveryFails
			? "reports RecoveryFailed when a fresh old attempt fails"
			: "recovers in a fresh attempt only after candidate termination",
		() =>
			Effect.gen(function* () {
				const h = yield* setup((id) =>
					id === 3 && recoveryFails ? { ready: Effect.fail(problem) } : {},
				)
				const running = yield* Effect.forkScoped(h.request({ trial: 50 }))
				yield* h.fork.generations.pipe(
					Stream.filter((all) =>
						Array.some(all, (g) => g.attempt === 2 && g.state === "Serving"),
					),
					Stream.runHead,
				)
				const next = yield* h.control(2)
				yield* Deferred.fail(next.failed, problem)
				const outcome = yield* Fiber.join(running)
				assert.equal(
					outcome._tag,
					recoveryFails ? "RecoveryFailed" : "Recovered",
				)
				const observed12 = yield* Deferred.isDone(next.exited)
				assert.isTrue(observed12)
				const observed13 = yield* Ref.get(h.allocations)
				assert.equal(observed13, 3)
				if (recoveryFails) {
					const unavailable = yield* Effect.flip(h.value.read)
					assert.equal(unavailable._tag, "Unavailable")
				} else {
					const restored = yield* h.value.read
					assert.equal(restored, "old")
				}
			}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
	)
}

it.effect(
	"returns Stuck on transport loss without exit evidence and blocks later transitions",
	() =>
		Effect.gen(function* () {
			const entered = yield* Deferred.make<void>()
			const h = yield* setup((id) =>
				id === 2
					? {
							ready: Deferred.succeed(entered, undefined).pipe(
								Effect.andThen(Effect.fail(problem)),
							),
							noExit: true,
						}
					: {},
			)
			const running = yield* Effect.forkScoped(h.request())
			yield* Deferred.await(entered)
			const pending = yield* h.control(2)
			yield* Deferred.await(pending.terminating)
			yield* TestClock.adjust(100)
			const outcome = yield* Fiber.join(running)
			assert.equal(outcome._tag, "Stuck")
			const later = yield* h.request()
			assert.equal(later._tag, "Aborted")
			if (later._tag === "Aborted") assert.equal(later.reason, "Stuck")
			const observed16 = yield* Ref.get(h.allocations)
			assert.equal(observed16, 2)
			const next = yield* h.control(2)
			yield* Deferred.succeed(next.exited, { unit: "unit-2", state: "Exited" })
		}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)

it.effect("bounds readiness and preserves the old route", () =>
	Effect.gen(function* () {
		const h = yield* setup((id) => (id === 2 ? { ready: Effect.never } : {}))
		const running = yield* Effect.forkScoped(h.request())
		yield* TestClock.adjust(100)
		const outcome = yield* Fiber.join(running)
		assert.equal(outcome._tag, "Aborted")
		if (outcome._tag === "Aborted") assert.equal(outcome.reason, "TimedOut")
		const observed17 = yield* h.value.read
		assert.equal(observed17, "old")
	}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)

it.effect("the coordinator owns recovery after its caller is cancelled", () =>
	Effect.gen(function* () {
		const h = yield* setup()
		const caller = yield* Effect.forkScoped(h.request({ trial: 50 }))
		yield* h.fork.generations.pipe(
			Stream.filter((all) =>
				Array.some(all, (g) => g.attempt === 2 && g.state === "Serving"),
			),
			Stream.runHead,
		)
		yield* Fiber.interrupt(caller)
		const next = yield* h.control(2)
		yield* Deferred.fail(next.failed, problem)
		yield* h.fork.generations.pipe(
			Stream.filter((all) =>
				Array.some(all, (g) => g.attempt === 3 && g.state === "Serving"),
			),
			Stream.runHead,
		)
		const observed18 = yield* h.value.read
		assert.equal(observed18, "old")
	}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)

it.effect("rejects bypasses before updating specs or aliases", () =>
	Effect.gen(function* () {
		const h = yield* setup()
		const observed19 = yield* Effect.flip(h.fork.restart)
		assert.equal(observed19._tag, "ManagedFork")
		assert.equal(
			(yield* Effect.flip(h.fork.update(undefined)))._tag,
			"ManagedFork",
		)
		const other = Plugin.make({ name: "other", apply: () => Effect.void })
		const replaced = yield* Effect.flip(Graft.replace([[h.definition, other]]))
		assert.equal(replaced.reason, "ManagedFork")
		const observed20 = yield* Graft.resolve(h.definition)
		assert.equal(observed20, h.definition)
		const observed21 = yield* Ref.get(h.allocations)
		assert.equal(observed21, 1)
	}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)

it.effect(
	"returns explicit unsupported and invalid-policy outcomes without allocating",
	() =>
		Effect.gen(function* () {
			const unsupported = yield* Graft.transition({
				target: 100,
				candidate: candidate("new"),
			})
			assert.equal(unsupported._tag, "Aborted")
			const h = yield* setup()
			const invalid = yield* h.request({ drain: Infinity })
			assert.equal(invalid._tag, "Aborted")
			if (invalid._tag === "Aborted")
				assert.equal(invalid.reason, "InvalidPolicy")
			const observed22 = yield* Ref.get(h.allocations)
			assert.equal(observed22, 1)
		}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)

const waitFor = (
	h: Effect.Success<ReturnType<typeof setup>>,
	attempt: number,
	state: Transition.Generation["state"],
) =>
	h.fork.generations.pipe(
		Stream.filter((all) =>
			Array.some(all, (g) => g.attempt === attempt && g.state === state),
		),
		Stream.runHead,
	)

it.effect(
	"bounds drain and stopping, then uses exit evidence to finish calls",
	() =>
		Effect.gen(function* () {
			const h = yield* setup((id) =>
				id === 1 ? { holdRead: true, stop: Effect.never } : {},
			)
			const old = yield* h.control(1)
			const call = yield* Effect.forkScoped(h.value.read)
			yield* Deferred.await(old.entered)
			const running = yield* Effect.forkScoped(h.request())
			yield* waitFor(h, 1, "Draining")
			yield* TestClock.adjust(200)
			const outcome = yield* Fiber.join(running)
			assert.equal(outcome._tag, "Accepted")
			const ended = yield* Fiber.await(call)
			assert.isTrue(Exit.isFailure(ended))
			assert.isTrue(
				Array.some(
					outcome.evidence,
					(e) => e.phase === "Draining" && e.cause !== undefined,
				),
			)
			assert.isTrue(
				Array.some(
					outcome.evidence,
					(e) => e.phase === "Stopping" && e.cause !== undefined,
				),
			)
			assert.isTrue(
				Array.some(outcome.evidence, (e) => e.termination?.unit === "unit-1"),
			)
		}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)

it.effect("keeps the coordinator busy across the entire trial window", () =>
	Effect.gen(function* () {
		const h = yield* setup()
		const running = yield* Effect.forkScoped(h.request({ trial: 50 }))
		yield* waitFor(h, 2, "Serving")
		const busy = yield* h.request()
		assert.equal(busy._tag, "Aborted")
		if (busy._tag === "Aborted") assert.equal(busy.reason, "Busy")
		yield* TestClock.adjust(50)
		const accepted = yield* Fiber.join(running)
		assert.equal(accepted._tag, "Accepted")
	}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)

it.effect(
	"does not let a stale failure or late readiness change the route",
	() =>
		Effect.gen(function* () {
			const gate = yield* Deferred.make<void>()
			const entered = yield* Deferred.make<void>()
			const h = yield* setup((id) =>
				id === 2
					? {
							ready: Deferred.succeed(entered, undefined).pipe(
								Effect.andThen(Effect.uninterruptible(Deferred.await(gate))),
							),
						}
					: {},
			)
			const running = yield* Effect.forkScoped(h.request())
			yield* Deferred.await(entered)
			yield* TestClock.adjust(100)
			const aborted = yield* Fiber.join(running)
			assert.equal(aborted._tag, "Aborted")
			const later = yield* h.request()
			assert.equal(later._tag, "Accepted")
			const stale = yield* h.control(2)
			yield* Deferred.fail(stale.failed, problem)
			yield* Deferred.succeed(gate, undefined)
			const current = yield* h.value.read
			assert.equal(current, "new")
			const all = yield* Stream.runHead(h.fork.generations)
			assert.deepEqual(
				Array.map(Option.getOrThrow(all), (g) => g.state),
				["Terminated", "Terminated", "Serving"],
			)
		}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)

it.effect(
	"cancelling a call releases its admission without restarting the consumer",
	() =>
		Effect.gen(function* () {
			const h = yield* setup((id) => ({ holdRead: id === 1 }))
			const old = yield* h.control(1)
			const call = yield* Effect.forkScoped(h.value.read)
			yield* Deferred.await(old.entered)
			yield* Fiber.interrupt(call)
			const result = yield* h.request()
			assert.equal(result._tag, "Accepted")
			const consumers = yield* Ref.get(h.activations)
			assert.equal(consumers, 1)
		}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)

it.effect("preserves complete lifecycle failure causes in the outcome", () =>
	Effect.gen(function* () {
		const cause = Cause.combine(
			Cause.fail(problem),
			Cause.die("lifecycle defect"),
		)
		const h = yield* setup((id) =>
			id === 2 ? { probe: Effect.failCause(cause) } : {},
		)
		const outcome = yield* h.request()
		assert.equal(outcome._tag, "Aborted")
		const observed = Option.getOrThrow(
			Array.findFirst(
				outcome.evidence,
				(e) => e.phase === "Probing" && e.cause !== undefined,
			),
		)
		assert.isDefined(observed.cause)
		const reasons = observed.cause?.reasons
		assert.deepEqual(
			Array.map(reasons ?? [], (reason) =>
				reason._tag === "Fail"
					? reason.error
					: reason._tag === "Die"
						? reason.defect
						: reason.fiberId,
			),
			[problem, "lifecycle defect"],
		)
	}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)

it.effect("does not recover before a failed candidate has exit evidence", () =>
	Effect.gen(function* () {
		const h = yield* setup((id) => ({ noExit: id === 2 }))
		const running = yield* Effect.forkScoped(h.request({ trial: 50 }))
		yield* waitFor(h, 2, "Serving")
		const next = yield* h.control(2)
		yield* Deferred.fail(next.failed, problem)
		yield* Deferred.await(next.terminating)
		yield* TestClock.adjust(100)
		const outcome = yield* Fiber.join(running)
		assert.equal(outcome._tag, "Stuck")
		const allocated = yield* Ref.get(h.allocations)
		assert.equal(allocated, 2)
		yield* Deferred.succeed(next.exited, { unit: "unit-2", state: "Exited" })
	}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)

it.effect("rejects replacement of an ancestor before changing any alias", () =>
	Effect.gen(function* () {
		const ready =
			yield* Deferred.make<Effect.Success<ReturnType<typeof setup>>>()
		const parent = Plugin.make({
			name: "parent",
			apply: () =>
				setup().pipe(
					Effect.flatMap((h) => Deferred.succeed(ready, h)),
					Effect.asVoid,
				),
		})
		const fork = yield* Graft.plugin(parent)
		yield* fork.await
		const h = yield* Deferred.await(ready)
		const restarted = yield* Effect.flip(fork.restart)
		assert.equal(restarted.fork, h.fork.id)
		const changed = yield* Effect.flip(
			Graft.replace([
				[
					parent,
					Plugin.make({ name: "replacement", apply: () => Effect.void }),
				],
			]),
		)
		assert.equal(changed.reason, "ManagedFork")
		const resolved = yield* Graft.resolve(parent)
		assert.equal(resolved, parent)
	}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)

it.effect("guards external writes before running them", () =>
	Effect.gen(function* () {
		const h = yield* setup()
		const writes = yield* Ref.make(0)
		const failure = yield* Effect.flip(
			Transition.withUnmanaged(
				Ref.update(writes, (n) => n + 1),
				h.fork.id,
			),
		)
		assert.equal(failure._tag, "ManagedFork")
		const count = yield* Ref.get(writes)
		assert.equal(count, 0)
	}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)

it.effect("terminates the current unit when the owning fork is disposed", () =>
	Effect.gen(function* () {
		const h = yield* setup()
		const current = yield* h.control(1)
		yield* h.fork.dispose
		const exited = yield* Deferred.isDone(current.exited)
		assert.isTrue(exited)
		const unavailable = yield* Effect.flip(h.value.read)
		assert.equal(unavailable._tag, "Unavailable")
	}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)

it.effect(
	"recovers when the candidate fails while the old unit is stopping",
	() =>
		Effect.gen(function* () {
			const release = yield* Deferred.make<void>()
			const h = yield* setup((id) =>
				id === 1 ? { stop: Deferred.await(release) } : {},
			)
			const old = yield* h.control(1)
			const running = yield* Effect.forkScoped(h.request())
			yield* Deferred.await(old.stopped)
			const next = yield* h.control(2)
			yield* Deferred.fail(next.failed, problem)
			yield* Deferred.succeed(release, undefined)
			const result = yield* Fiber.join(running)
			assert.equal(result._tag, "Recovered")
			const current = yield* h.value.read
			assert.equal(current, "old")
		}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)

for (const stage of [
	"allocate",
	"start",
	"describe",
	"serve",
	"ready",
	"probe",
] as const) {
	it.effect(`bounds candidate ${stage} without disturbing the old route`, () =>
		Effect.gen(function* () {
			const entered = yield* Deferred.make<void>()
			const blocked = Deferred.succeed(entered, undefined).pipe(
				Effect.andThen(Effect.never),
			)
			const h = yield* setup((id) => (id === 2 ? { [stage]: blocked } : {}))
			const running = yield* Effect.forkScoped(h.request())
			yield* Deferred.await(entered)
			yield* TestClock.adjust(100)
			const outcome = yield* Fiber.join(running)
			assert.equal(outcome._tag, "Aborted")
			if (outcome._tag === "Aborted") assert.equal(outcome.reason, "TimedOut")
			const value = yield* h.value.read
			assert.equal(value, "old")
		}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
	)
}

it.effect("rejects readiness without the facade's required service", () =>
	Effect.gen(function* () {
		const h = yield* setup((id) => ({ missingServices: id === 2 }))
		const outcome = yield* h.request()
		assert.equal(outcome._tag, "Aborted")
		if (outcome._tag === "Aborted")
			assert.equal(outcome.reason, "IncompatibleContract")
		const current = yield* h.value.read
		assert.equal(current, "old")
	}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)

it.effect(
	"reports Stuck when the old unit cannot be confirmed terminated",
	() =>
		Effect.gen(function* () {
			const h = yield* setup((id) => ({ noExit: id === 1 }))
			const old = yield* h.control(1)
			const running = yield* Effect.forkScoped(h.request())
			yield* Deferred.await(old.terminating)
			yield* TestClock.adjust(100)
			const outcome = yield* Fiber.join(running)
			assert.equal(outcome._tag, "Stuck")
			const unavailable = yield* Effect.flip(h.value.read)
			assert.equal(unavailable._tag, "Unavailable")
			yield* Deferred.succeed(old.exited, { unit: "unit-1", state: "Exited" })
		}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)

it.effect(
	"rejects driver registration while an external write holds admission",
	() =>
		Effect.gen(function* () {
			const entered = yield* Deferred.make<void>()
			const release = yield* Deferred.make<void>()
			const writing = yield* Effect.forkScoped(
				Transition.withUnmanaged(
					Deferred.succeed(entered, undefined).pipe(
						Effect.andThen(Deferred.await(release)),
					),
				),
			)
			yield* Deferred.await(entered)
			const rejected = yield* Effect.exit(setup())
			assert.isTrue(Exit.isFailure(rejected))
			yield* Deferred.succeed(release, undefined)
			yield* Fiber.join(writing)
		}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)

it.effect(
	"aborts on observed candidate exit even when the failure channel stays silent",
	() =>
		Effect.gen(function* () {
			const h = yield* setup((id) => ({ exitAtReadiness: id === 2 }))
			const result = yield* h.request()
			assert.equal(result._tag, "Aborted")
			const current = yield* h.value.read
			assert.equal(current, "old")
		}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)

it.effect(
	"recovers instead of claiming an abort preserved a failed old attempt",
	() =>
		Effect.gen(function* () {
			const entered = yield* Deferred.make<void>()
			const release = yield* Deferred.make<void>()
			const h = yield* setup((id) =>
				id === 2
					? {
							ready: Deferred.succeed(entered, undefined).pipe(
								Effect.andThen(Deferred.await(release)),
								Effect.andThen(Effect.fail(problem)),
							),
						}
					: {},
			)
			const old = yield* h.control(1)
			const running = yield* Effect.forkScoped(h.request())
			yield* Deferred.await(entered)
			yield* Deferred.fail(old.failed, problem)
			yield* Deferred.succeed(release, undefined)
			const result = yield* Fiber.join(running)
			assert.equal(result._tag, "Recovered")
			const current = yield* h.value.read
			assert.equal(current, "old")
			const count = yield* Ref.get(h.allocations)
			assert.equal(count, 3)
		}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)

for (const field of [
	"total",
	"startup",
	"probe",
	"trial",
	"drain",
	"stop",
	"terminate",
] as const) {
	it.effect(`rejects an infinite ${field} Duration before allocation`, () =>
		Effect.gen(function* () {
			const h = yield* setup()
			const result = yield* h.request({ [field]: Duration.infinity })
			assert.deepEqual(
				result,
				Transition.Outcome.Aborted({
					phase: "Admission",
					reason: "InvalidPolicy",
					evidence: [],
				}),
			)
			const allocations = yield* Ref.get(h.allocations)
			assert.equal(allocations, 1)
		}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
	)
}
it.effect("accepts Duration inputs and constructs tagged outcomes", () =>
	Effect.gen(function* () {
		const h = yield* setup()
		const result = yield* h.request({
			total: { seconds: 20 },
			startup: Duration.millis(100),
			probe: "100 millis",
			trial: Duration.zero,
			drain: [0, 100_000_000],
			stop: 100_000_000n,
			terminate: { milliseconds: 100 },
		})
		assert.equal(result._tag, "Accepted")
		assert.isTrue(
			Equal.equals(
				result,
				Transition.Outcome.Accepted({
					phase: result.phase,
					evidence: result.evidence,
				}),
			),
		)
	}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)
it.effect("rejects a total that cannot reserve cleanup and recovery", () =>
	Effect.gen(function* () {
		const h = yield* setup()
		const result = yield* h.request({ total: 1400 })
		assert.deepEqual(
			result,
			Transition.Outcome.Aborted({
				phase: "Admission",
				reason: "InvalidPolicy",
				evidence: [],
			}),
		)
	}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)
it.effect(
	"caps successive preparation waits by the total minus its safety reserve",
	() =>
		Effect.gen(function* () {
			const h = yield* setup((id) =>
				id === 2
					? {
							start: Effect.sleep(40),
							describe: Effect.sleep(40).pipe(
								Effect.as({
									overlap: true,
									provides: [{ name: "read", version: 1 }],
								}),
							),
						}
					: {},
			)
			const start = yield* Clock.currentTimeMillis
			const running = yield* Effect.forkScoped(h.request({ total: 1450 }))
			yield* waitFor(h, 2, "Starting")
			yield* TestClock.adjust(50)
			const result = yield* Fiber.join(running)
			assert.equal(result._tag, "Aborted")
			if (result._tag === "Aborted") {
				assert.equal(result.phase, "Describing")
				assert.equal(result.reason, "TimedOut")
			}
			const end = yield* Clock.currentTimeMillis
			assert.equal(end - start, 50)
			assert.isTrue(
				Array.some(
					result.evidence,
					(item) => item.attempt === 2 && item.termination !== undefined,
				),
			)
		}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)
it.effect(
	"reserves recovery when trial consumes the entire preparation allowance",
	() =>
		Effect.gen(function* () {
			const h = yield* setup((id) =>
				id === 3
					? {
							start: Effect.sleep(80),
							ready: Effect.sleep(80),
							probe: Effect.sleep(80),
						}
					: {},
			)
			const running = yield* Effect.forkScoped(
				h.request({ total: 1450, trial: "1 second" }),
			)
			yield* waitFor(h, 2, "Serving")
			yield* TestClock.adjust(350)
			const result = yield* Fiber.join(running)
			assert.equal(result._tag, "Recovered")
			if (result._tag === "Recovered") assert.equal(result.reason, "TimedOut")
			const value = yield* h.value.read
			assert.equal(value, "old")
			yield* waitFor(h, 3, "Serving")
		}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)
it.effect(
	"rejects excess calls without consuming admission and releases capacity after cancellation",
	() =>
		Effect.gen(function* () {
			const h = yield* setup(() => ({ holdRead: true }), 1)
			const old = yield* h.control(1)
			const call = yield* Effect.forkScoped(h.value.read)
			yield* Deferred.await(old.entered)
			const excess = yield* Effect.flip(h.value.read)
			assert.equal(excess._tag, "AdmissionRejected")
			yield* Fiber.interrupt(call)
			yield* Deferred.succeed(old.read, "finished")
			const value = yield* h.value.read
			assert.equal(value, "finished")
		}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)

it.effect("rejects a NaN trial rather than normalizing it to zero", () =>
	Effect.gen(function* () {
		const h = yield* setup()
		const result = yield* h.request({ trial: Number.NaN })
		assert.deepEqual(
			result,
			Transition.Outcome.Aborted({
				phase: "Admission",
				reason: "InvalidPolicy",
				evidence: [],
			}),
		)
	}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)

it.effect(
	"addresses a managed instance by name and rejects duplicate registrations before allocation",
	() =>
		Effect.gen(function* () {
			const h = yield* setup()
			const result = yield* Graft.transition({
				target: "integration",
				candidate: candidate("named"),
			})
			assert.equal(result._tag, "Accepted")
			const before = yield* Ref.get(h.allocations)
			const duplicate = yield* Graft.plugin(h.definition)
			const failed = yield* Effect.exit(duplicate.await)
			assert.isTrue(Exit.isFailure(failed))
			if (Exit.isFailure(failed))
				assert.include(
					Cause.pretty(failed.cause),
					"Managed instance already registered",
				)
			const after = yield* Ref.get(h.allocations)
			assert.equal(after, before)
		}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)

for (const instance of [undefined, "", "different"]) {
	it.effect(
		`rejects ${instance === undefined ? "unnamed" : instance === "" ? "empty" : "conflicting"} instance identity before allocation`,
		() =>
			Effect.gen(function* () {
				const allocations = yield* Ref.make(0)
				const definition = Plugin.make({
					name: "invalid-instance",
					apply: () =>
						Transition.registerDriver(
							{
								name: "test",
								allocate: () =>
									Ref.update(allocations, (n) => n + 1).pipe(
										Effect.andThen(Effect.never),
									),
							},
							{
								instance,
								initial: candidate("old"),
								required: [],
								facades: [],
							},
						),
				})
				const fork = yield* Graft.plugin(definition, undefined, {
					intercept:
						instance === "different"
							? [
									Graft.intercept(Transition.CurrentInstance, () =>
										Option.some("entry"),
									),
								]
							: [],
				})
				const exit = yield* Effect.exit(fork.await)
				assert.isTrue(Exit.isFailure(exit))
				if (Exit.isFailure(exit))
					assert.include(
						Cause.pretty(exit.cause),
						"explicit, matching instance name",
					)
				const count = yield* Ref.get(allocations)
				assert.equal(count, 0)
			}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
	)
}

it.effect(
	"rejects admission while disposal is waiting for an exit without leaving Busy",
	() =>
		Effect.gen(function* () {
			const h = yield* setup(() => ({ noExit: true }))
			const old = yield* h.control(1)
			const disposing = yield* Effect.forkScoped(h.fork.dispose)
			yield* Deferred.await(old.terminating)
			const request = yield* Effect.forkScoped(h.request())
			yield* Effect.yieldNow
			yield* Deferred.succeed(old.exited, { unit: "old", state: "Exited" })
			yield* Fiber.join(disposing)
			const answer = yield* Effect.timeoutOption(Fiber.join(request), 1).pipe(
				Effect.forkScoped,
			)
			yield* TestClock.adjust(1)
			const outcome = yield* Fiber.join(answer)
			assert.isTrue(Option.isSome(outcome))
			if (Option.isSome(outcome)) {
				assert.equal(outcome.value._tag, "Aborted")
				if (outcome.value._tag === "Aborted")
					assert.equal(outcome.value.reason, "Closing")
			}
			const next = yield* Graft.transition({
				target: "missing",
				candidate: candidate("new"),
			})
			assert.equal(next._tag, "Aborted")
			if (next._tag === "Aborted")
				assert.equal(next.reason, "UnsupportedTarget")
		}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)

it.effect(
	"disposal during startup preserves evidence and does not poison another instance",
	() =>
		Effect.gen(function* () {
			const entered = yield* Deferred.make<void>()
			const h = yield* setup((id) =>
				id === 2
					? {
							start: Deferred.succeed(entered, undefined).pipe(
								Effect.andThen(Effect.never),
							),
						}
					: {},
			)
			const running = yield* Effect.forkScoped(h.request())
			yield* Deferred.await(entered)
			yield* h.fork.dispose
			const outcome = yield* Fiber.join(running)
			assert.equal(outcome._tag, "Aborted")
			if (outcome._tag === "Aborted") assert.equal(outcome.reason, "Closing")
			assert.equal(outcome.phase, "Starting")
			assert.isTrue(
				Array.some(
					outcome.evidence,
					(item) => item.attempt === 2 && item.phase === "Starting",
				),
			)
			assert.isFalse(Array.some(outcome.evidence, (item) => item.attempt === 0))
			assert.equal(
				Array.filter(outcome.evidence, (item) => item.termination !== undefined)
					.length,
				2,
			)
			const other = yield* setup()
			assert.equal((yield* other.request())._tag, "Accepted")
		}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)

it.effect(
	"disposal combines host finalizer causes after confirmed execution exit",
	() =>
		Effect.gen(function* () {
			const h = yield* setup(() => ({
				start: Effect.addFinalizer(() =>
					Effect.failCause(
						Cause.combine(
							Cause.die("host release defect"),
							Cause.die("host release failure"),
						),
					),
				),
			}))
			const exit = yield* Effect.exit(h.fork.dispose)
			assert.isTrue(Exit.isFailure(exit))
			if (Exit.isFailure(exit)) {
				const message = Cause.pretty(exit.cause)
				assert.include(message, "host release defect")
				assert.include(message, "host release failure")
			}
			const head = yield* Stream.runHead(h.fork.generations)
			const observed = Option.getOrThrow(head)
			assert.equal(observed[0]?.state, "Terminated")
		}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)

it.effect(
	"generation snapshots bound retired summaries and release deployment payloads",
	() =>
		Effect.gen(function* () {
			const h = yield* setup()
			for (let index = 0; index < 40; index++) {
				const outcome = yield* Graft.transition({
					target: h.fork.id,
					candidate: {
						...candidate("next-" + index),
						deployment: { payload: "retired input " + index },
					},
				})
				assert.equal(outcome._tag, "Accepted")
			}
			const head = yield* Stream.runHead(h.fork.generations)
			const observed = Option.getOrThrow(head)
			assert.isAtMost(observed.length, 33)
			assert.isFalse(
				Array.some(observed, (item) => "deployment" in item.candidate),
			)
			assert.equal(
				Array.filter(observed, (item) => item.state === "Serving").length,
				1,
			)
		}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)

it.effect(
	"coordinator defects preserve their phase and cause without poisoning admission",
	() =>
		Effect.gen(function* () {
			const h = yield* setup((id) =>
				id === 2
					? {
							describe: Effect.succeed({
								overlap: true,
								get provides(): ReadonlyArray<Plugin.OperationIdentity> {
									throw new Error("Description inspection defect")
								},
							}),
						}
					: {},
			)
			const outcome = yield* h.request()
			assert.equal(outcome._tag, "RecoveryFailed")
			if (outcome._tag === "RecoveryFailed")
				assert.equal(outcome.reason, "CoordinatorDefect")
			assert.equal(outcome.phase, "Describing")
			assert.isTrue(
				Array.some(
					outcome.evidence,
					(item) =>
						item.attempt === 2 &&
						item.cause !== undefined &&
						String.includes("Description inspection defect")(
							Cause.pretty(item.cause),
						),
				),
			)
			assert.equal(
				Array.filter(outcome.evidence, (item) => item.termination !== undefined)
					.length,
				2,
			)
			yield* h.fork.dispose
			const other = yield* setup()
			const next = yield* other.request()
			assert.equal(next._tag, "Accepted")
		}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)

it.effect(
	"folds cleanup causes from every attempt when disposal cancels preparation",
	() =>
		Effect.gen(function* () {
			const entered = yield* Deferred.make<void>()
			const h = yield* setup((id) => ({
				start: Effect.addFinalizer(() => Effect.die(`Host cleanup ${id}`)).pipe(
					Effect.andThen(
						id === 2
							? Deferred.succeed(entered, undefined).pipe(
									Effect.andThen(Effect.never),
								)
							: Effect.void,
					),
				),
			}))
			const pending = yield* Effect.forkScoped(h.request())
			yield* Deferred.await(entered)
			const disposed = yield* Effect.exit(h.fork.dispose)
			assert.isTrue(Exit.isFailure(disposed))
			if (Exit.isFailure(disposed)) {
				assert.include(Cause.pretty(disposed.cause), "Host cleanup 1")
				assert.include(Cause.pretty(disposed.cause), "Host cleanup 2")
			}
			const outcome = yield* Fiber.join(pending)
			assert.equal(outcome._tag, "Aborted")
			for (const attempt of [1, 2]) {
				assert.isTrue(
					Array.some(
						outcome.evidence,
						(item) =>
							item.attempt === attempt && item.termination !== undefined,
					),
				)
				assert.isTrue(
					Array.some(
						outcome.evidence,
						(item) =>
							item.cause !== undefined &&
							String.includes(`Host cleanup ${attempt}`)(
								Cause.pretty(item.cause),
							),
					),
				)
			}
		}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)

it.effect(
	"publishes full deployment events independently of bounded generation summaries",
	() =>
		Effect.gen(function* () {
			const h = yield* setup()
			const listening = yield* Deferred.make<void>()
			const events = yield* Effect.forkScoped(
				h.fork.generationEvents.pipe(
					Stream.tap(() => Deferred.succeed(listening, undefined)),
					Stream.take(3),
					Stream.runCollect,
				),
			)
			yield* Effect.yieldNow
			const payload = { contract: "external", input: { value: "new" } }
			const next = { ...candidate("new"), deployment: payload }
			const outcome = yield* Graft.transition({
				target: h.fork.id,
				candidate: next,
			})
			assert.equal(outcome._tag, "Accepted")
			yield* Deferred.await(listening)
			const observed = yield* Fiber.join(events)
			assert.equal(observed[0]?.candidate, next)
			assert.deepEqual(
				Array.map(observed, (item) => item.state),
				["Starting", "Serving", "Draining"],
			)
			const summary = yield* Stream.runHead(h.fork.generations)
			assert.isFalse(
				Array.some(
					Option.getOrThrow(summary),
					(item) => "deployment" in item.candidate,
				),
			)
		}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)

it.effect(
	"completes an admitted reply when its owner closes before the coordinator starts",
	() =>
		Effect.gen(function* () {
			const h = yield* setup()
			const context = yield* Effect.serviceOption(RuntimeContext)
			const { runtime } = Option.getOrThrow(context)
			const forks = yield* Snapshots.get(runtime.forks)
			const entry = Option.getOrThrow(HashMap.get(forks, h.fork.id))
			const closing = yield* Effect.forkScoped(
				Effect.tx(
					Effect.gen(function* () {
						if (!(yield* TxRef.get(runtime.transitionBusy)))
							return yield* Effect.txRetry
					}),
				).pipe(Effect.andThen(Scope.close(entry.scope, Exit.void))),
				{ startImmediately: true },
			)
			const outcome = yield* h.request()
			yield* Fiber.join(closing)
			assert.equal(outcome._tag, "Aborted")
			if (outcome._tag === "Aborted") assert.equal(outcome.reason, "Closing")
			assert.equal(outcome.phase, "Admission")
			const allocated = yield* Ref.get(h.allocations)
			assert.equal(allocated, 1)
			assert.isTrue(
				Array.some(
					outcome.evidence,
					(item) => item.attempt === 1 && item.termination?.state === "Exited",
				),
			)
			yield* h.fork.dispose
			const other = yield* setup()
			const next = yield* other.request()
			assert.equal(next._tag, "Accepted")
		}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)

it.effect(
	"keeps a coordinator defect distinct when disposal joins its cleanup",
	() =>
		Effect.gen(function* () {
			const h = yield* setup((id) => ({
				noExit: true,
				...(id === 2
					? {
							describe: Effect.succeed({
								overlap: true,
								get provides(): ReadonlyArray<Plugin.OperationIdentity> {
									throw new Error("Coordinator inspection failed")
								},
							}),
						}
					: {}),
			}))
			const context = yield* Effect.serviceOption(RuntimeContext)
			const { runtime } = Option.getOrThrow(context)
			const forks = yield* Snapshots.get(runtime.forks)
			const entry = Option.getOrThrow(HashMap.get(forks, h.fork.id))
			const registered = yield* TxRef.get(entry.status.managed)
			const managed = Option.getOrThrow(registered)
			const running = yield* Effect.forkScoped(h.request())
			const previous = yield* h.control(1)
			yield* Deferred.await(previous.terminating)
			const disposing = yield* Effect.forkScoped(h.fork.dispose)
			yield* Effect.tx(
				Effect.gen(function* () {
					const state = yield* TxRef.get(managed.lifecycle)
					if (state._tag !== "Closing") return yield* Effect.txRetry
				}),
			)
			yield* Deferred.succeed(previous.exited, { unit: "old", state: "Exited" })
			const next = yield* h.control(2)
			yield* Deferred.succeed(next.exited, {
				unit: "candidate",
				state: "Exited",
			})
			yield* Fiber.join(disposing)
			const outcome = yield* Fiber.join(running)
			assert.equal(outcome._tag, "RecoveryFailed")
			if (outcome._tag === "RecoveryFailed")
				assert.equal(outcome.reason, "CoordinatorDefect")
			assert.equal(outcome.phase, "Describing")
		}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)

it.effect(
	"disposal resumes host release interrupted exactly after execution exit was cached",
	() =>
		Effect.gen(function* () {
			const boundary = yield* Deferred.make<void>()
			const scopes = yield* Ref.make<ReadonlyArray<Scope.Scope>>([])
			const finalized = yield* Ref.make<ReadonlyArray<number>>([])
			const inspect = MutableRef.make<() => boolean>(() => false)
			const hit = MutableRef.make(false)
			const base = yield* Scheduler.Scheduler
			const scheduler: Scheduler.Scheduler = {
				executionMode: base.executionMode,
				makeDispatcher: () => base.makeDispatcher(),
				shouldYield(fiber) {
					// This synchronous scheduler hook interrupts at the first instruction after exit is cached.
					if (!hit.current && inspect.current()) {
						MutableRef.set(hit, true)
						Deferred.doneUnsafe(boundary, Exit.void)
						fiber.interruptUnsafe()
						return true
					}
					return base.shouldYield(fiber)
				},
			}
			const disposed = yield* Effect.gen(function* () {
				const h = yield* setup((id) => ({
					start: Effect.gen(function* () {
						const scope = yield* Effect.scope
						yield* Ref.update(scopes, Array.append(scope))
						yield* Effect.addFinalizer(() =>
							Ref.update(finalized, Array.append(id)).pipe(
								Effect.andThen(Effect.die(`Host finalizer ${id} failed`)),
							),
						)
					}),
				}))
				const context = yield* Effect.serviceOption(RuntimeContext)
				const { runtime } = Option.getOrThrow(context)
				const forks = yield* Snapshots.get(runtime.forks)
				const entry = Option.getOrThrow(HashMap.get(forks, h.fork.id))
				const registered = yield* TxRef.get(entry.status.managed)
				const managed = Option.getOrThrow(registered)
				const attempts = yield* Ref.get(managed.attempts)
				const previous = Option.getOrThrow(Array.head(attempts))
				MutableRef.set(inspect, () =>
					Option.isSome(Ref.getUnsafe(previous.terminated)),
				)
				const transitioning = yield* Effect.forkScoped(h.request())
				yield* Deferred.await(boundary)
				const disposed = yield* Effect.exit(h.fork.dispose)
				const outcome = yield* Fiber.join(transitioning)
				assert.notEqual(outcome._tag, "Stuck")
				return disposed
			}).pipe(
				Effect.scoped,
				Effect.provide(Graft.layer),
				Effect.provideService(Scheduler.Scheduler, scheduler),
			)
			assert.isTrue(hit.current)
			const owned = yield* Ref.get(scopes)
			assert.equal(owned.length, 2)
			assert.deepEqual(
				Array.map(owned, (scope) => scope.state._tag),
				["Closed", "Closed"],
			)
			const released = yield* Ref.get(finalized)
			assert.deepEqual(Array.sort(released, Order.Number), [1, 2])
			assert.isTrue(Exit.isFailure(disposed))
			if (Exit.isFailure(disposed)) {
				assert.include(Cause.pretty(disposed.cause), "Host finalizer 1 failed")
				assert.include(Cause.pretty(disposed.cause), "Host finalizer 2 failed")
			}
		}),
)

it.effect(
	"a repeated termination awaits the running host release and retains its failure",
	() =>
		Effect.gen(function* () {
			const entered = yield* Deferred.make<void>()
			const release = yield* Deferred.make<void>()
			const finalizers = yield* Ref.make<ReadonlyArray<number>>([])
			const h = yield* setup((id) => ({
				start: Effect.addFinalizer(() =>
					Effect.gen(function* () {
						yield* Ref.update(finalizers, Array.append(id))
						if (id === 1) {
							yield* Deferred.succeed(entered, undefined)
							yield* Deferred.await(release)
						}
						return yield* Effect.die(`Finalizer ${id} failed`)
					}),
				),
			}))
			const transitioning = yield* Effect.forkScoped(h.request())
			yield* Deferred.await(entered)
			const disposing = yield* Effect.forkScoped(Effect.exit(h.fork.dispose))
			// Cancellation reaches the coordinator while host cleanup remains blocked.
			const context = yield* Effect.serviceOption(RuntimeContext)
			const { runtime } = Option.getOrThrow(context)
			const forks = yield* Snapshots.get(runtime.forks)
			const entry = Option.getOrThrow(HashMap.get(forks, h.fork.id))
			const registered = yield* TxRef.get(entry.status.managed)
			const managed = Option.getOrThrow(registered)
			yield* Effect.tx(
				Effect.gen(function* () {
					const state = yield* TxRef.get(managed.lifecycle)
					if (state._tag !== "Closing") return yield* Effect.txRetry
				}),
			)
			yield* TestClock.adjust(1)
			assert.isUndefined(transitioning.pollUnsafe())
			assert.isUndefined(disposing.pollUnsafe())
			yield* Deferred.succeed(release, undefined)
			const outcome = yield* Fiber.join(transitioning)
			assert.equal(outcome._tag, "Aborted")
			const disposed = yield* Fiber.join(disposing)
			assert.isTrue(Exit.isFailure(disposed))
			if (Exit.isFailure(disposed)) {
				assert.include(Cause.pretty(disposed.cause), "Finalizer 1 failed")
				assert.include(Cause.pretty(disposed.cause), "Finalizer 2 failed")
			}
			const calls = yield* Ref.get(finalizers)
			assert.deepEqual(Array.sort(calls, Order.Number), [1, 2])
		}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)

it.effect(
	"checks approval when a reused facade effect executes, before admitting the call",
	() =>
		Effect.gen(function* () {
			const comparison = yield* TxRef.make<Trust.Comparison>({
				current: { revision: 1 },
				approved: Option.some({ revision: 1 }),
				missing: "MissingApproval",
			})
			yield* Trust.register({
				compare: () => TxRef.get(comparison),
				publish: () => Effect.void,
			})
			const state = yield* setup()
			const observed1 = yield* state.value.read
			assert.equal(observed1, "old")
			yield* TxRef.update(comparison, (value) => ({
				...value,
				current: { revision: 2 },
			}))

			const exit = yield* state.value.read.pipe(Effect.exit)
			assert.isTrue(Exit.isFailure(exit))
			if (Exit.isFailure(exit))
				assert.include(Cause.pretty(exit.cause), "ChangedStatement")
		}).pipe(run),
)

it.effect(
	"closes allocation resources on failure before a unit can start",
	() =>
		Effect.gen(function* () {
			const live = yield* Ref.make(0)
			const allocation = Effect.acquireRelease(
				Ref.update(live, (n) => n + 1),
				() => Ref.update(live, (n) => n - 1),
			).pipe(Effect.andThen(problem))
			const state = yield* setup((id) =>
				id === 1 ? {} : { allocate: allocation },
			)
			const outcome = yield* state.request()
			assert.equal(outcome._tag, "Aborted")
			const observed2 = yield* Ref.get(live)
			assert.equal(observed2, 0)
			const observed3 = yield* state.value.read
			assert.equal(observed3, "old")
		}).pipe(run),
)

it.effect(
	"rejects installing an admission authority after a managed entry starts",
	() =>
		Effect.gen(function* () {
			yield* setup()
			const error = yield* Trust.register({
				compare: () =>
					Effect.succeed({
						current: null,
						approved: Option.some(null),
						missing: "MissingApproval",
					}),
				publish: () => Effect.void,
			}).pipe(Effect.flip)
			assert.equal(error._tag, "AdmissionRegistrationError")
		}).pipe(run),
)

it.effect("retains failed-allocation finalizer causes for disposal", () =>
	Effect.gen(function* () {
		const allocation = Effect.addFinalizer(() =>
			Effect.die("Allocation lease cleanup failed"),
		).pipe(Effect.andThen(problem))
		const state = yield* setup((id) =>
			id === 1 ? {} : { allocate: allocation },
		)
		const outcome = yield* state.request()
		assert.equal(outcome._tag, "Aborted")
		assert.isTrue(
			Array.some(
				outcome.evidence,
				(evidence) =>
					evidence.cause !== undefined &&
					String.includes("Allocation lease cleanup failed")(
						Cause.pretty(evidence.cause),
					),
			),
		)
		const disposal = yield* state.fork.dispose.pipe(Effect.exit)
		assert.isTrue(Exit.isFailure(disposal))
		if (Exit.isFailure(disposal))
			assert.include(
				Cause.pretty(disposal.cause),
				"Allocation lease cleanup failed",
			)
	}).pipe(run),
)

it.effect("bounds failed-allocation cleanup without abandoning its owner", () =>
	Effect.gen(function* () {
		const closing = yield* Deferred.make<void>()
		const release = yield* Deferred.make<void>()
		const allocation = Effect.addFinalizer(() =>
			Deferred.succeed(closing, undefined).pipe(
				Effect.andThen(Deferred.await(release)),
			),
		).pipe(Effect.andThen(problem))
		const state = yield* setup((id) =>
			id === 1 ? {} : { allocate: allocation },
		)
		const pending = yield* state.request().pipe(Effect.forkScoped)
		yield* Deferred.await(closing)
		yield* TestClock.adjust(policy.terminate)
		const outcome = yield* Fiber.join(pending)
		assert.equal(outcome._tag, "Aborted")
		yield* Deferred.succeed(release, undefined)
		const disposal = yield* state.fork.dispose.pipe(Effect.exit)
		assert.isTrue(Exit.isFailure(disposal))
	}).pipe(run),
)
