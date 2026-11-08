import {
	Array,
	Cause,
	Context,
	Effect,
	Exit,
	Fiber,
	FiberSet,
	HashMap,
	Option,
	Scope,
	TxRef,
} from "effect"

import * as Finalization from "../Finalization"
import { ProbeError } from "../Fork"

export interface Probe {
	readonly run: Effect.Effect<void, ProbeError>
}
export type Registry = TxRef.TxRef<HashMap.HashMap<string, Probe>>
export const make = TxRef.make(HashMap.empty<string, Probe>())
export const names = (registry: Registry) =>
	TxRef.get(registry).pipe(
		Effect.map((entries) => Array.fromIterable(HashMap.keys(entries))),
	)
export const run = Effect.fnUntraced(function* (
	registry: Registry,
	name: string,
) {
	const entries = yield* TxRef.get(registry)
	const entry = HashMap.get(entries, name)
	if (Option.isNone(entry))
		return yield* ProbeError.make({ probe: name, reason: "Missing" })
	return yield* entry.value.run
})
export const register = Effect.fnUntraced(function* <A, E, R>(
	registry: Registry,
	name: string,
	effect: Effect.Effect<A, E, R>,
) {
	const context = yield* Effect.context<R>()
	const fibers = yield* FiberSet.make<void, ProbeError>()
	const checked = Finalization.scoped(
		Effect.flatMap(Effect.scope, (scope) =>
			effect.pipe(
				Effect.provideContext(Context.add(context, Scope.Scope, scope)),
			),
		),
	).pipe(
		Effect.asVoid,
		Effect.catchCause((cause) =>
			ProbeError.make({ probe: name, reason: "Failed", cause }),
		),
	)
	const cancel = Effect.fnUntraced(function* (
		fiber: Fiber.Fiber<void, ProbeError>,
	) {
		const interruptor = yield* Effect.withFiber((self) =>
			Effect.succeed(self.id),
		)
		yield* Fiber.interrupt(fiber)
		const result = yield* Fiber.await(fiber)
		if (Exit.isSuccess(result)) return
		const reasons = Array.flatMap(
			result.cause.reasons,
			(reason): ReadonlyArray<Cause.Reason<unknown>> =>
				reason._tag === "Fail" && reason.error.cause !== undefined
					? reason.error.cause.reasons
					: [reason],
		)
		const unexpected = Array.filter(
			reasons,
			(reason) => reason._tag !== "Interrupt" || reason.fiberId !== interruptor,
		)
		if (unexpected.length > 0)
			return yield* Effect.die(
				ProbeError.make({
					probe: name,
					reason: "Failed",
					cause: Cause.fromReasons(unexpected),
				}),
			)
	})
	yield* Effect.addFinalizer(() =>
		Effect.gen(function* () {
			const results = yield* Effect.forEach(
				Array.fromIterable(fibers),
				(fiber) => Effect.exit(cancel(fiber)),
			)
			const cause = Array.reduce(
				results,
				Cause.empty,
				(cause: Cause.Cause<never>, result) =>
					Exit.isFailure(result) ? Cause.combine(cause, result.cause) : cause,
			)
			if (cause.reasons.length > 0) return yield* Effect.failCause(cause)
		}),
	)
	const entry: Probe = {
		run: Effect.uninterruptibleMask((restore) =>
			Effect.gen(function* () {
				const fiber = yield* FiberSet.run(fibers, restore(checked))
				return yield* restore(Fiber.join(fiber)).pipe(
					Effect.onInterrupt(() => cancel(fiber)),
				)
			}),
		),
	}
	yield* Effect.acquireRelease(
		Effect.tx(
			Effect.gen(function* () {
				const entries = yield* TxRef.get(registry)
				if (HashMap.has(entries, name))
					return yield* ProbeError.make({ probe: name, reason: "Duplicate" })
				yield* TxRef.set(registry, HashMap.set(entries, name, entry))
			}),
		),
		() => TxRef.update(registry, HashMap.remove(name)),
	)
})
