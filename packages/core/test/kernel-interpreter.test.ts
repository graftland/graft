import {
	Array as Arr,
	Cause,
	Clock,
	Deferred,
	Effect,
	Equal,
	Exit,
	Fiber,
	HashMap,
	Option,
	Queue,
	Scope,
	Stream,
} from "effect"
import { Digest } from "effect/crypto"
import { TestClock } from "effect/testing"
import { assert, it } from "@effect/vitest"

import * as Core from "../src/internal/decisionCore.ts"
import * as Interpreter from "../src/internal/kernel.ts"
import { UnitControl } from "../src/internal/unitControl.ts"
import { initial, request } from "./change-model/scenarios.ts"
import {
	described,
	exit,
	id,
	inspect,
	resolved,
	target,
} from "./preparation-fixture"

const publicInput: Core.Input = {
	operations: [{ _tag: "Deploy", instance: "instance-0", target: target() }],
	strategy: "Overlap",
}
const withDescription = (s: Core.State): Core.State => {
	const p = inspect(s, {
		instance: "instance-0",
		target: target(),
		strategy: "Overlap",
	})
	return exit(described(p.state, id(p)), id(p)).state
}
const control = (commands: Queue.Queue<Core.Command>) =>
	UnitControl.of({
		events: Stream.empty,
		send: (command) =>
			Queue.offer(commands, command).pipe(
				Effect.as({ _tag: "Succeeded" } satisfies Core.Report),
			),
	})
const take = (
	commands: Queue.Queue<Core.Command>,
	kind: Core.CommandKind,
): Effect.Effect<Core.Command> =>
	Queue.take(commands).pipe(
		Effect.filterOrElse(
			(c) => c.kind === kind,
			() => take(commands, kind),
		),
	)
const make = Effect.fnUntraced(function* (state: Core.State) {
	const kernel = yield* Interpreter.make(state)
	yield* Effect.addFinalizer(() => TestClock.adjust(100000))
	return kernel
})
const terminal = (
	kernel: Interpreter.Controller,
	id: string,
): ReturnType<Interpreter.Controller["await"]> => kernel.await(id)

it.effect(
	"records command intent before dispatch and projects every notification from core state (I1, I2)",
	() =>
		Effect.gen(function* () {
			const commands = yield* Queue.unbounded<Core.Command>()
			const core = initial()
			const kernel = yield* make(core).pipe(
				Effect.provideService(UnitControl, control(commands)),
				Effect.provide(Digest.layerWebCrypto),
			)
			const observations = yield* Effect.forkScoped(
				Stream.runCollect(Stream.take(kernel.changes, 2)),
			)
			const reply = yield* kernel.apply({
				_tag: "Submit",
				request: request(core),
				now: 0,
			})
			assert.deepStrictEqual(reply, { _tag: "Admitted", change: "change-1" })
			const spawn = yield* take(commands, "Spawn")
			const state = yield* kernel.snapshot
			assert.isTrue(HashMap.has(state.units, spawn.unit))
			assert.isTrue(HashMap.has(state.commands, spawn.id))
			const seen = yield* Fiber.join(observations)
			assert.strictEqual(Option.getOrThrow(Arr.head(seen)).sequence, 1)
			assert.isTrue(
				Arr.every(seen, (s) => s.id === "change-1" && s.sequence > 0),
			)
			const published = yield* kernel.snapshot
			assert.isTrue(
				Arr.every(seen, (status) =>
					Arr.some(
						Arr.fromIterable(HashMap.values(published.commands)),
						(command) =>
							Option.exists(command.status, (value) =>
								Equal.equals(value, status),
							),
					),
				),
			)
			const closing = yield* Effect.forkScoped(kernel.shutdown)
			yield* TestClock.adjust(1000)
			yield* Fiber.join(closing)
		}),
	10000,
)

it.effect(
	"retains the complete original executor failure without choosing its outcome (I1, I5)",
	() =>
		Effect.gen(function* () {
			const core = initial()
			const failed = Cause.combine(
				Cause.die("Control failed"),
				Cause.die("Control defect"),
			)
			const backend = UnitControl.of({
				events: Stream.empty,
				send: () => Effect.failCause(failed),
			})
			const kernel = yield* make(core).pipe(
				Effect.provideService(UnitControl, backend),
				Effect.provide(Digest.layerWebCrypto),
			)
			yield* kernel.apply({ _tag: "Submit", request: request(core), now: 0 })
			const ending = yield* terminal(kernel, "change-1")
			assert.strictEqual(ending.outcome, "Aborted")
			assert.strictEqual(ending.cause.reasons.length, 2)
		}),
	10000,
)

it.effect(
	"cancelled callers do not cancel admitted commands or their evidence observers (I2, I5)",
	() =>
		Effect.gen(function* () {
			const core = initial()
			const commands = yield* Queue.unbounded<Core.Command>()
			const started = yield* Deferred.make<void>()
			const finish = yield* Deferred.make<Core.Report>()
			const backend = UnitControl.of({
				events: Stream.empty,
				send: (c) =>
					c.kind === "Spawn"
						? Deferred.succeed(started, undefined).pipe(
								Effect.andThen(Deferred.await(finish)),
							)
						: control(commands).send(c),
			})
			const kernel = yield* make(core).pipe(
				Effect.provideService(UnitControl, backend),
				Effect.provide(Digest.layerWebCrypto),
			)
			yield* kernel.apply({ _tag: "Submit", request: request(core), now: 0 })
			yield* Deferred.await(started)
			const waiter = yield* Effect.forkScoped(terminal(kernel, "change-1"))
			yield* Fiber.interrupt(waiter)
			const pending = yield* kernel.get("change-1")
			assert.isTrue(Option.isNone(Option.getOrThrow(pending).conclusion))
			yield* Deferred.succeed(finish, {
				_tag: "Failed",
				cause: Cause.fail("Prevented"),
				creation: "NotStarted",
			})
			assert.strictEqual(
				(yield* terminal(kernel, "change-1")).outcome,
				"Aborted",
			)
		}),
	10000,
)

it.effect(
	"ignores stale timers and duplicate reports while retaining one immutable conclusion (I1, I10)",
	() =>
		Effect.gen(function* () {
			const core = initial()
			const commands = yield* Queue.unbounded<Core.Command>()
			const kernel = yield* make(core).pipe(
				Effect.provideService(UnitControl, control(commands)),
				Effect.provide(Digest.layerWebCrypto),
			)
			yield* kernel.apply({ _tag: "Submit", request: request(core), now: 0 })
			const spawn = yield* take(commands, "Spawn")
			yield* kernel.apply({
				_tag: "Cancel",
				change: "change-1",
				cause: Cause.fail("Cancelled"),
				now: 0,
			})
			yield* kernel.apply({
				_tag: "Exited",
				unit: spawn.unit,
				incarnation: spawn.token.incarnation,
				observer: spawn.id,
				cleanup: { _tag: "Unknown" },
				cause: Cause.empty,
				now: 0,
			})
			const original = yield* terminal(kernel, "change-1")
			yield* kernel.apply({
				_tag: "Reported",
				command: spawn.id,
				token: spawn.token,
				result: { _tag: "Succeeded" },
				now: 0,
			})
			yield* TestClock.adjust(1000)
			const repeated = yield* terminal(kernel, "change-1")
			assert.strictEqual(repeated, original)
		}),
	10000,
)

it.effect(
	"a closing owner fences submission and does not orphan an unconfirmed command (I2, I5, I7)",
	() =>
		Effect.gen(function* () {
			const core = initial()
			const started = yield* Deferred.make<void>()
			const failure = yield* Deferred.make<void>()
			const backend = UnitControl.of({
				events: Stream.empty,
				send: (c) =>
					c.kind === "Spawn"
						? Deferred.succeed(started, undefined).pipe(
								Effect.andThen(Deferred.await(failure)),
								Effect.as({ _tag: "Succeeded" } satisfies Core.Report),
							)
						: Effect.succeed({ _tag: "Succeeded" } satisfies Core.Report),
			})
			const owner = yield* Scope.make()
			const kernel = yield* Interpreter.make(core).pipe(
				Effect.provideService(UnitControl, backend),
				Effect.provide(Digest.layerWebCrypto),
				Scope.provide(owner),
			)
			yield* kernel.apply({ _tag: "Submit", request: request(core), now: 0 })
			yield* Deferred.await(started)
			const closing = yield* Effect.forkScoped(Scope.close(owner, Exit.void))
			yield* TestClock.adjust(1000)
			yield* Fiber.join(closing)
			const observed = yield* kernel.get("change-1")
			const current = Option.getOrThrow(observed)
			assert.strictEqual(Option.getOrThrow(current.conclusion).outcome, "Stuck")
			assert.isAbove(current.unconfirmedUnits.pipe(Arr.fromIterable).length, 0)
			const reply = yield* kernel.apply({
				_tag: "Submit",
				request: request(core),
				now: 1000,
			})
			assert.strictEqual(reply._tag, "Rejected")
		}),
	10000,
)

it.effect(
	"retains handle completion after unkeyed history is evicted (I10)",
	() =>
		Effect.gen(function* () {
			const core = withDescription({ ...initial(), historyLimit: 1 })
			const backend = UnitControl.of({
				events: Stream.empty,
				send: () =>
					Effect.succeed<Core.Report>({
						_tag: "Failed",
						cause: Cause.fail("Resolution denied"),
						creation: "NotStarted",
					}),
			})
			const kernel = yield* make(core).pipe(
				Effect.provideService(UnitControl, backend),
				Effect.provide(Digest.layerWebCrypto),
			)
			const first = yield* kernel.submit(publicInput)
			const handle = Option.getOrThrow(first.completion)
			const original = yield* handle.await
			const second = yield* kernel.submit(publicInput)
			yield* Option.getOrThrow(second.completion).await
			const queried = yield* kernel.get(handle.id)
			assert.isTrue(Option.isNone(queried))
			const repeated = yield* handle.await
			assert.strictEqual(repeated, original)
		}),
)

it.effect(
	"reports a crashed timer executor and retains unresolved creation as Stuck (I1, I2, I5)",
	() =>
		Effect.gen(function* () {
			const started = yield* Deferred.make<void>()
			const crash = yield* Deferred.make<void>()
			const clock = yield* Clock.Clock
			const fault = Cause.die("Timer executor failed")
			const broken: Clock.Clock = {
				currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe(),
				currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
				monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
				currentTimeMillis: clock.currentTimeMillis,
				currentTimeNanos: clock.currentTimeNanos,
				monotonicTimeNanos: clock.monotonicTimeNanos,
				sleep: () =>
					Deferred.await(crash).pipe(Effect.andThen(Effect.failCause(fault))),
			}
			const backend = UnitControl.of({
				events: Stream.empty,
				send: (command) =>
					command.kind === "Spawn"
						? Deferred.succeed(started, undefined).pipe(
								Effect.andThen(Effect.never),
							)
						: Effect.succeed<Core.Report>(
								command.kind === "Resolve"
									? { _tag: "Resolved", value: resolved }
									: { _tag: "Succeeded" },
							),
			})
			const kernel = yield* Interpreter.make(withDescription(initial())).pipe(
				Effect.provideService(UnitControl, backend),
				Effect.provide(Digest.layerWebCrypto),
				Effect.provideService(Clock.Clock, broken),
			)
			yield* kernel.submit(publicInput)
			yield* Deferred.await(started)
			yield* Deferred.succeed(crash, undefined)
			const conclusion = yield* terminal(kernel, "change-1")
			assert.equal(conclusion.outcome, "Stuck")
			assert.include(Cause.pretty(conclusion.cause), "Timer executor failed")
			const observed = yield* kernel.get("change-1")
			assert.isAbove(
				Option.getOrThrow(observed).unconfirmedUnits.pipe(Arr.fromIterable)
					.length,
				0,
			)
		}),
	10000,
)
