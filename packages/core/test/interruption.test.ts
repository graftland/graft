import {
	Array,
	Context,
	Effect,
	Exit,
	Fiber,
	HashMap,
	HashSet,
	Layer,
	Option,
	References,
	Scope,
	TxRef,
	TxSubscriptionRef,
} from "effect"
import { assert, it } from "@effect/vitest"

import * as Graft from "../src/Graft.ts"
import { realmKey, type Runtime } from "../src/internal/runtime.ts"
import { RuntimeContext } from "../src/internal/runtimeContext.ts"
import { registrySnapshot, run } from "./b1b-utils.ts"

class Service extends Context.Service<Service, string>()(
	"@graftland/graft/test/interruption.test/Service",
) {}

/** Only the persistent publication is left once a cancelled mount is released. */
const settled = (runtime: Runtime, expected: number) =>
	Effect.tx(
		Effect.gen(function* () {
			const mounts = yield* TxSubscriptionRef.get(runtime.mounts)
			if (HashMap.size(mounts) !== expected) return yield* Effect.txRetry
		}),
	)

it.effect(
	"balances acquisition leases under interruption at varied scheduler boundaries",
	() =>
		Effect.gen(function* () {
			const { runtime } = yield* RuntimeContext
			const publication = yield* Graft.publish(Service, "ready")
			yield* publication.await
			const registry = yield* registrySnapshot(runtime)
			const provision = Option.getOrThrow(
				HashMap.get(registry, realmKey("", Service.key)),
			)
			for (const ticks of Array.range(0, 100)) {
				const owner = yield* Scope.make()
				const mounting = yield* Graft.mount(Layer.effectDiscard(Effect.never), {
					name: "consumer",
					requires: [Service],
				}).pipe(
					Scope.provide(owner),
					Effect.provideService(References.MaxOpsBeforeYield, 4),
					Effect.forkScoped,
				)
				for (const _ of Array.range(0, ticks)) yield* Effect.yieldNow
				yield* Fiber.interrupt(mounting)
				yield* Scope.close(owner, Exit.void)
				yield* settled(runtime, 1)
				const count = yield* TxRef.get(provision.consumers)
				assert.strictEqual(
					HashSet.size(count),
					0,
					`Lease leaked after ${ticks} yields`,
				)
			}
		}).pipe(run),
)

it.effect(
	"removes a mount entry when its registering caller is interrupted",
	() =>
		Effect.gen(function* () {
			const { runtime } = yield* RuntimeContext
			const owner = yield* Scope.make()
			const registering = yield* Graft.mount(Layer.effectDiscard(Effect.void), {
				name: "interrupted registration",
			}).pipe(
				Scope.provide(owner),
				Effect.provideService(References.MaxOpsBeforeYield, 4),
				Effect.forkScoped,
			)
			yield* Effect.tx(
				Effect.gen(function* () {
					const mounts = yield* TxSubscriptionRef.get(runtime.mounts)
					if (HashMap.size(mounts) === 0) return yield* Effect.txRetry
				}),
			)
			yield* Fiber.interrupt(registering)
			yield* Scope.close(owner, Exit.void)
			yield* settled(runtime, 0)
		}).pipe(run),
)
