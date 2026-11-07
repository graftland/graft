import {
	Deferred,
	Effect,
	Fiber,
	HashMap,
	MutableRef,
	Option,
	Scheduler,
	TxRef,
} from "effect"
import { assert, it } from "@effect/vitest"

import { Change } from "../src/index.ts"
import * as Admission from "../src/internal/admission.ts"
import { RuntimeContext } from "../src/internal/runtimeContext.ts"
import { budget, candidate, register, Value } from "./change-driver.ts"
import { run } from "./utils.ts"

it.effect("cancelling a queued call at dispatch releases its call credit", () =>
	Effect.gen(function* () {
		const base = yield* Scheduler.Scheduler
		const inspect = MutableRef.make<() => boolean>(() => false)
		const waitingId = MutableRef.make<number | undefined>(undefined)
		const hit = MutableRef.make(false)
		const scheduler: Scheduler.Scheduler = {
			executionMode: base.executionMode,
			makeDispatcher: () => base.makeDispatcher(),
			shouldYield(fiber) {
				if (
					!hit.current &&
					fiber.id === waitingId.current &&
					inspect.current()
				) {
					MutableRef.set(hit, true)
					fiber.interruptUnsafe()
					return true
				}
				return base.shouldYield(fiber)
			},
		}
		yield* run(
			Effect.gen(function* () {
				const release = yield* Deferred.make<void>()
				const h = yield* register("a", {
					facade: true,
					ready: Deferred.await(release),
				})
				const { runtime } = yield* RuntimeContext
				const instances = yield* TxRef.get(runtime.instances)
				const managed = HashMap.getUnsafe(instances, "a")
				const handle = yield* Change.submit({
					instance: "a",
					candidate: candidate("next"),
					strategy: "Restart",
					budget,
				})
				yield* Deferred.await(h.entered)
				const call = yield* Admission.invoke(managed)(
					Value,
					(service) => service.read,
				).pipe(Effect.forkScoped({ startImmediately: true }))
				MutableRef.set(waitingId, call.id)
				MutableRef.set(
					inspect,
					() =>
						Option.isSome(managed.route.value) &&
						managed.route.value.value.calls.value === 1,
				)
				yield* Deferred.succeed(release, undefined)
				yield* Fiber.await(call)
				yield* handle.await
				const selected = yield* TxRef.get(managed.route)
				const route = Option.getOrThrow(selected)
				const calls = yield* TxRef.get(route.calls)
				assert.isTrue(hit.current)
				assert.strictEqual(calls, 0)
			}),
		).pipe(Effect.provideService(Scheduler.Scheduler, scheduler))
	}),
)
