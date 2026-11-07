import {
	Array,
	Context,
	Deferred,
	Effect,
	HashMap,
	HashSet,
	Option,
	Schema,
	TxRef,
} from "effect"
import { TestClock } from "effect/testing"

import { Change, Graft, Plugin, Transition } from "../../src/index.ts"
import * as ChangeTable from "../../src/internal/changeTable.ts"
import { RuntimeContext } from "../../src/internal/runtimeContext.ts"
import type { Unapproved } from "../../src/Trust.ts"
import { type Action, type Model, type Plan } from "./model.ts"
import { instance as modelInstance } from "./scenarios.ts"

class UnsupportedAction extends Schema.TaggedError<
	UnsupportedAction,
	{ readonly brand: unique symbol }
>()("UnsupportedModelAction", { action: Schema.String }) {}
class Value extends Context.Service<
	Value,
	{
		readonly get: Effect.Effect<
			string,
			| Transition.AdmissionRejected
			| Transition.DriverError
			| Transition.Unavailable
			| Unapproved
		>
	}
>()("@graftland/graft/test/change-model/adapter/Value") {}
interface Control {
	readonly started: Deferred.Deferred<void>
	readonly readyEntered: Deferred.Deferred<void>
	readonly ready: Deferred.Deferred<void>
	readonly stopping: Deferred.Deferred<void>
	readonly exited: Deferred.Deferred<Change.Termination>
	readonly cleanup: Deferred.Deferred<void>
}
const budget: Change.Budget = {
	total: 10000,
	startup: 100,
	probe: 100,
	drain: 100,
	stop: 100,
	terminate: 100,
}
const candidate = (identity: string): Change.Candidate => ({
	driver: "model-fixture",
	identity,
	deployment: identity,
})
const member = (plan: Plan) =>
	Option.getOrThrow(
		Array.head(Array.fromIterable(HashMap.values(plan.members))),
	)

/** Controls real driver effects; it never edits coordinator routes, reservations or leases. */
export const make = Effect.fnUntraced(function* (initial: Model) {
	const { runtime } = yield* RuntimeContext
	const units = yield* TxRef.make(HashMap.empty<string, Control>())
	const allocated = yield* TxRef.make(HashMap.empty<Change.Id, string>())
	const changes = yield* TxRef.make(
		HashMap.empty<
			string,
			{ readonly handle: Change.Handle; readonly plan: Plan }
		>(),
	)
	const values = yield* TxRef.make(
		HashMap.empty<string, Context.Service.Shape<typeof Value>>(),
	)
	for (const name of HashMap.keys(initial.terms)) {
		const captured = yield* Deferred.make<Context.Service.Shape<typeof Value>>()
		const driver: Transition.Driver = {
			name: "model-fixture",
			overlap: () => true,
			allocate: (desired, term, acknowledgement) =>
				Effect.gen(function* () {
					const control: Control = {
						started: yield* Deferred.make<void>(),
						readyEntered: yield* Deferred.make<void>(),
						ready: yield* Deferred.make<void>(),
						stopping: yield* Deferred.make<void>(),
						exited: yield* Deferred.make<Change.Termination>(),
						cleanup: yield* Deferred.make<void>(),
					}
					if (term === 1) yield* Deferred.succeed(control.ready, undefined)
					yield* TxRef.update(
						units,
						HashMap.set(`${name}#${term - 1}`, control),
					)
					if (Option.isSome(acknowledgement.change))
						yield* TxRef.update(
							allocated,
							HashMap.set(acknowledgement.change.value, `${name}#${term - 1}`),
						)
					yield* Effect.addFinalizer(() => Deferred.await(control.cleanup))
					return {
						acknowledgement,
						start: Deferred.succeed(control.started, undefined).pipe(
							Effect.asVoid,
						),
						describe: Effect.succeed({ overlap: true, provides: [] }),
						serve: Effect.void,
						ready: Deferred.succeed(control.readyEntered, undefined).pipe(
							Effect.andThen(Deferred.await(control.ready)),
							Effect.as(
								Context.make(Value, { get: Effect.succeed(desired.identity) }),
							),
						),
						probe: () => Effect.void,
						stop: Deferred.succeed(control.stopping, undefined).pipe(
							Effect.asVoid,
						),
						terminate: Effect.void,
						exited: Deferred.await(control.exited),
						failure: Effect.never,
					}
				}),
		}
		const fork = yield* Graft.plugin(
			Plugin.make({
				name: `model/${name}`,
				apply: () =>
					Effect.gen(function* () {
						yield* Transition.registerDriver(driver, {
							instance: name,
							initial: candidate("original"),
							budget,
							required: [],
							facades: [
								Transition.facade(Value, (invoke) => ({
									get: invoke((value) => value.get),
								})),
							],
						})
						const consumer = yield* Graft.plugin(
							Plugin.make({
								name: `model/${name}/consumer`,
								inject: [Value],
								apply: () =>
									Effect.flatMap(Value, (value) =>
										Deferred.succeed(captured, value).pipe(Effect.asVoid),
									),
							}),
						)
						yield* consumer.await
					}),
			}),
			undefined,
			{ isolate: [Value] },
		)
		yield* fork.await
		const value = yield* Deferred.await(captured)
		yield* TxRef.update(values, HashMap.set(name, value))
	}
	// The fixture supplies process exit and finalizer completion before disposing its units.
	yield* Effect.addFinalizer(() =>
		Effect.gen(function* () {
			const controls = yield* TxRef.get(units)
			yield* Effect.forEach(
				controls,
				([generation, control]) =>
					Deferred.succeed(control.exited, {
						unit: generation,
						state: "Exited",
					}).pipe(Effect.andThen(Deferred.succeed(control.cleanup, undefined))),
				{ discard: true },
			)
		}),
	)
	const unit = (generation: string) =>
		Effect.tx(
			TxRef.get(units).pipe(
				Effect.flatMap((units) =>
					Option.match(HashMap.get(units, generation), {
						onNone: () => Effect.txRetry,
						onSome: Effect.succeed,
					}),
				),
			),
		)
	const admitted = (id: string) =>
		TxRef.get(changes).pipe(
			Effect.map((changes) => HashMap.getUnsafe(changes, id)),
		)
	const targetUnit = Effect.fnUntraced(function* (id: string) {
		const change = yield* admitted(id)
		const generation = yield* Effect.tx(
			TxRef.get(allocated).pipe(
				Effect.flatMap((allocated) =>
					Option.match(HashMap.get(allocated, change.handle.id), {
						onNone: () => Effect.txRetry,
						onSome: Effect.succeed,
					}),
				),
			),
		)
		return yield* unit(generation)
	})
	const apply = Effect.fnUntraced(function* (action: Action) {
		switch (action._tag) {
			case "Submit": {
				const plan = action.plan
				if (
					HashMap.size(plan.members) !== 1 ||
					HashSet.size(plan.participants) !== 0 ||
					HashMap.size(member(plan).dependencies) !== 0
				)
					return yield* UnsupportedAction.make({
						action: "Member closure or participants require a later protocol",
					})
				const selected = member(plan)
				const expected = HashMap.getUnsafe(
					plan.reads,
					modelInstance(selected.instance),
				).version
				const handle = yield* Change.submit({
					instance: selected.instance,
					candidate: candidate(selected.target),
					strategy: plan.strategy,
					expected,
					budget,
				})
				yield* TxRef.update(changes, HashMap.set(plan.id, { handle, plan }))
				return
			}
			case "Prepare":
				return yield* Deferred.await((yield* targetUnit(action.change)).started)
			case "Install":
				return yield* Deferred.await(
					(yield* targetUnit(action.change)).readyEntered,
				)
			// This fixture's readiness result echoes the real allocation token. Remote route acknowledgements remain phase 2.
			case "Acknowledge":
				return yield* Deferred.succeed(
					(yield* unit(action.token.generation)).ready,
					undefined,
				).pipe(Effect.asVoid)
			case "Commit": {
				const change = yield* admitted(action.change)
				const name = member(change.plan).instance
				return yield* Effect.tx(
					Effect.gen(function* () {
						const instances = yield* TxRef.get(runtime.instances)
						const managed = HashMap.getUnsafe(instances, name)
						const route = yield* TxRef.get(managed.route)
						if (
							Option.isNone(route) ||
							route.value.desired.identity !== member(change.plan).target
						)
							return yield* Effect.txRetry
						const cell = yield* ChangeTable.object(runtime.changes, {
							_tag: "Instance",
							instance: name,
						})
						const version = (yield* TxRef.get(cell)).version
						if (
							version !==
							HashMap.getUnsafe(change.plan.reads, modelInstance(name))
								.version +
								1
						)
							return yield* Effect.txRetry
					}),
				)
			}
			case "Evidence": {
				const control = yield* unit(action.generation)
				yield* Deferred.succeed(control.exited, {
					unit: action.generation,
					state: action.evidence,
					...(action.cause === undefined ? {} : { cause: action.cause }),
				})
				return
			}
			case "Retire":
				return yield* Deferred.succeed(
					(yield* unit(action.generation)).cleanup,
					undefined,
				).pipe(Effect.asVoid)
			case "Finish":
				return yield* (yield* admitted(action.change)).handle.await.pipe(
					Effect.asVoid,
				)
			case "Cancel":
				return yield* (yield* admitted(action.change)).handle.cancel
			case "Deadline":
				return yield* TestClock.adjust(10000)
			case "ReleaseReservations": {
				const change = yield* admitted(action.change)
				return yield* Effect.tx(
					Effect.gen(function* () {
						const records = yield* TxRef.get(runtime.changes.records)
						const record = HashMap.getUnsafe(records, change.handle.id)
						const conditions = yield* TxRef.get(record.conditions)
						for (const condition of conditions) {
							const current = yield* TxRef.get(condition.cell)
							if (
								Option.contains(current.writer, change.handle.id) ||
								HashSet.has(current.readers, change.handle.id)
							)
								return yield* Effect.txRetry
						}
					}),
				)
			}
			default:
				return yield* UnsupportedAction.make({ action: action._tag })
		}
	})
	return {
		run: (actions: ReadonlyArray<Action>) =>
			Effect.forEach(actions, apply, { discard: true }),
		outcome: (id: string) =>
			Effect.flatMap(admitted(id), (change) => change.handle.await),
		read: (name: string) =>
			TxRef.get(values).pipe(
				Effect.flatMap((values) => HashMap.getUnsafe(values, name).get),
			),
		capacity: TxRef.get(runtime.capacity),
	}
})
