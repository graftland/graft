import {
	Array,
	Context,
	Deferred,
	Effect,
	Fiber,
	HashMap,
	HashSet,
	Option,
	TxRef,
} from "effect"
import { TestClock } from "effect/testing"
import { assert, it } from "@effect/vitest"

import { Change, Graft, Plugin, Transition } from "../src/index.ts"
import { realmKey } from "../src/internal/runtime.ts"
import { RuntimeContext } from "../src/internal/runtimeContext.ts"
import { run } from "./utils.ts"

class Resource extends Context.Service<Resource, string>()(
	"@graftland/graft/test/change-leases.test/Resource",
) {}
const budget: Change.Budget = {
	total: 10000,
	startup: 100,
	probe: 100,
	drain: 100,
	stop: 100,
	terminate: 100,
}
const candidate = (identity: string): Change.Candidate => ({
	driver: "leases",
	identity,
	deployment: identity,
})
const register = Effect.fnUntraced(function* (
	instance: string,
	options: {
		readonly inject?: boolean
		readonly facade?: boolean
		readonly ready?: Effect.Effect<void>
		readonly cleanup?: Effect.Effect<void>
		readonly holdOldExit?: boolean
	} = {},
) {
	const oldExit = yield* Deferred.make<Change.Termination>()
	const ready = yield* Deferred.make<void>()
	const terminated = yield* Deferred.make<void>()
	const driver: Transition.Driver = {
		name: "leases",
		overlap: () => true,
		allocate: (target, term, acknowledgement) =>
			Effect.gen(function* () {
				const exited =
					term === 1 ? oldExit : yield* Deferred.make<Change.Termination>()
				if (term === 1)
					yield* Effect.addFinalizer(() => options.cleanup ?? Effect.void)
				return {
					acknowledgement,
					start: Effect.void,
					describe: Effect.succeed({ overlap: true, provides: [] }),
					serve: Effect.void,
					ready: (term === 1
						? Effect.void
						: Deferred.succeed(ready, undefined).pipe(
								Effect.andThen(options.ready ?? Effect.void),
							)
					).pipe(Effect.as(Context.make(Resource, target.identity))),
					probe: () => Effect.void,
					stop: Effect.void,
					terminate: Deferred.succeed(terminated, undefined).pipe(
						Effect.andThen(
							options.holdOldExit === true && term === 1
								? Effect.void
								: Deferred.succeed(exited, {
										unit: `${instance}-${term}`,
										state: "Exited",
									}).pipe(Effect.asVoid),
						),
					),

					exited: Deferred.await(exited),
					failure: Effect.never,
				}
			}),
	}
	const fork = yield* Graft.plugin(
		Plugin.make({
			name: `leases/${instance}`,
			inject: options.inject === true ? [Resource, Resource] : [],
			apply: () =>
				Transition.registerDriver(driver, {
					instance,
					initial: candidate(`${instance}-old`),
					budget,
					required: [],
					facades:
						options.facade === true
							? [Transition.facade(Resource, () => "stable")]
							: [],
				}),
		}),
	)
	yield* fork.await
	yield* Effect.addFinalizer(() =>
		Deferred.succeed(oldExit, { unit: `${instance}-final`, state: "Exited" }),
	)
	return { fork, oldExit, ready, terminated }
})

it.effect(
	"owns captured provider leases and slot retains in each real managed generation until its exit",
	() =>
		run(
			Effect.gen(function* () {
				yield* (yield* Graft.plugin(
					Plugin.make({
						name: "resource",
						apply: () => Graft.provide(Resource, "captured"),
					}),
				)).await
				const entered = yield* Deferred.make<void>()
				const release = yield* Deferred.make<void>()
				const ready = yield* Deferred.make<void>()
				const h = yield* register("a", {
					inject: true,
					ready: Deferred.await(ready),
					holdOldExit: true,
					cleanup: Deferred.succeed(entered, undefined).pipe(
						Effect.andThen(Deferred.await(release)),
					),
				})
				const { runtime } = yield* RuntimeContext
				const instances = yield* TxRef.get(runtime.instances)
				const managed = HashMap.getUnsafe(instances, "a")
				const routed = yield* TxRef.get(managed.route)
				const old = Option.getOrThrow(routed)
				const directory = yield* TxRef.get(runtime.slots)
				const slot = HashMap.getUnsafe(directory, realmKey("", Resource.key))
				const published = yield* TxRef.get(slot.provision)
				const provision = Option.getOrThrow(published)
				const before = yield* TxRef.get(slot.holders)
				const handle = yield* Change.submit({
					instance: "a",
					candidate: candidate("next"),
					strategy: "Overlap",
					budget,
				})
				yield* Deferred.await(h.ready)
				const attempts = yield* TxRef.get(managed.attempts)
				const next = Option.getOrThrow(
					Array.findFirst(attempts, (attempt) => attempt.id === 2),
				)
				const leases = yield* TxRef.get(provision.consumers)
				assert.isTrue(HashSet.has(leases, old.generation))
				assert.isTrue(HashSet.has(leases, next.generation))
				const both = yield* TxRef.get(slot.holders)
				assert.strictEqual(both, before + 1)
				yield* Deferred.succeed(ready, undefined)
				yield* Deferred.succeed(h.oldExit, { unit: "a-1", state: "Exited" })
				yield* Deferred.await(entered)
				const exited = yield* TxRef.get(provision.consumers)
				assert.isFalse(HashSet.has(exited, old.generation))
				assert.isTrue(HashSet.has(exited, next.generation))
				const after = yield* TxRef.get(slot.holders)
				assert.strictEqual(after, before)
				yield* Deferred.succeed(h.oldExit, { unit: "a-1", state: "Exited" })
				const repeated = yield* TxRef.get(slot.holders)
				assert.strictEqual(repeated, after)
				yield* Deferred.succeed(release, undefined)
				const outcome = yield* handle.await
				assert.strictEqual(outcome._tag, "Accepted")
				const observed = yield* Change.get(handle.id)
				assert.deepStrictEqual(Option.getOrThrow(observed).leaseHolders, [2])
			}),
		),
)

it.effect(
	"shares captured facade read premises and fences only their conflicting writer",
	() =>
		run(
			Effect.gen(function* () {
				yield* register("c", { facade: true })
				const ready = yield* Deferred.make<void>()
				const a = yield* register("a", {
					inject: true,
					ready: Deferred.await(ready),
				})
				const b = yield* register("b", {
					inject: true,
					ready: Deferred.await(ready),
				})
				const first = yield* Change.submit({
					instance: "a",
					candidate: candidate("a-next"),
					budget,
				})
				const second = yield* Change.submit({
					instance: "b",
					candidate: candidate("b-next"),
					budget,
				})
				yield* Deferred.await(a.ready)
				yield* Deferred.await(b.ready)
				const conflict = yield* Effect.flip(
					Change.submit({
						instance: "c",
						candidate: candidate("c-next"),
						budget,
					}),
				)
				assert.strictEqual(conflict.reason._tag, "Busy")
				yield* Deferred.succeed(ready, undefined)
				assert.strictEqual((yield* first.await)._tag, "Accepted")
				assert.strictEqual((yield* second.await)._tag, "Accepted")
				assert.strictEqual(
					(yield* Change.run({
						instance: "c",
						candidate: candidate("c-next"),
						budget,
					}))._tag,
					"Accepted",
				)
			}),
		),
)

it.effect(
	"keeps an unconfirmed disposed generation leased and fences its instance name until late exit",
	() =>
		run(
			Effect.gen(function* () {
				const released = yield* Deferred.make<void>()
				const provider = yield* Graft.plugin(
					Plugin.make({
						name: "retained-resource",
						apply: () =>
							Effect.addFinalizer(() =>
								Deferred.succeed(released, undefined),
							).pipe(Effect.andThen(Graft.provide(Resource, "captured"))),
					}),
				)
				yield* provider.await
				const h = yield* register("a", { inject: true, holdOldExit: true })
				const { runtime } = yield* RuntimeContext
				const registered = yield* TxRef.get(runtime.instances)
				const managed = HashMap.getUnsafe(registered, "a")
				const routed = yield* TxRef.get(managed.route)
				const old = Option.getOrThrow(routed)
				const disposal = yield* h.fork.dispose.pipe(
					Effect.exit,
					Effect.forkScoped,
				)
				yield* Deferred.await(h.terminated)
				yield* TestClock.adjust(budget.total)
				const disposed = yield* Fiber.join(disposal)
				assert.isTrue(disposed._tag === "Failure")
				const closingProvider = yield* provider.dispose.pipe(Effect.forkScoped)
				const done = yield* Deferred.isDone(released)
				assert.isFalse(done)
				const blocked = yield* Effect.flip(register("a"))
				assert.strictEqual(blocked._tag, "DriverError")
				yield* Deferred.succeed(h.oldExit, { unit: "a-1", state: "Exited" })
				yield* Fiber.join(closingProvider)
				const node = yield* TxRef.get(managed.entry.node.state)
				assert.isFalse(HashMap.has(node.resolutions, old.generation))
				yield* register("a")
				yield* Deferred.succeed(h.oldExit, { unit: "a-1", state: "Exited" })
				const instances = yield* TxRef.get(runtime.instances)
				assert.isTrue(HashMap.getUnsafe(instances, "a") !== managed)
			}),
		),
)
