import { assert, it } from "@effect/vitest"
import {
	Array as Arr,
	Context,
	Effect,
	Exit,
	Fiber,
	HashMap,
	Option,
	References,
	Scope,
	TxRef,
	TxSubscriptionRef,
} from "effect"
import { Graft, Plugin } from "../src/index.ts"
import { supervise } from "../src/internal/activation.ts"
import type { Spec } from "../src/internal/runtime.ts"
import { run } from "./utils.ts"

class Service extends Context.Service<Service, string>()(
	"@graftland/graft/test/interruption.test/Service",
) {}

it.effect(
	"balances acquisition leases under interruption at varied scheduler boundaries",
	() =>
		Effect.gen(function* () {
			const { runtime } = yield* Graft.Graft
			yield* Graft.provide(Service, "ready")
			const registry = yield* TxRef.get(runtime.registry)
			const provision = Option.getOrThrow(
				HashMap.get(registry, `\u0000${Service.key}`),
			)
			const plugin = Plugin.make({
				name: "consumer",
				inject: [Service],
				apply: () => Effect.never,
			})
			for (const ticks of Arr.range(0, 100)) {
				const spec = yield* TxRef.make<Spec>({
					plugin,
					input: undefined,
					revision: 0,
				})
				const supervisor = yield* supervise(runtime, -1, spec).pipe(
					Effect.provideService(References.MaxOpsBeforeYield, 16),
					Effect.forkScoped,
				)
				for (const _ of Arr.range(0, ticks)) yield* Effect.yieldNow
				yield* Fiber.interrupt(supervisor)
				const count = yield* TxRef.get(provision.leases)
				assert.strictEqual(count, 0, `Lease leaked after ${ticks} yields`)
			}
		}).pipe(run),
)

it.effect(
	"removes a fork entry when its registering caller is interrupted",
	() =>
		Effect.gen(function* () {
			const { runtime } = yield* Graft.Graft
			const owner = yield* Scope.make()
			const plugin = Plugin.make({
				name: "interrupted registration",
				apply: () => Effect.void,
			})
			const registering = yield* Graft.plugin(plugin).pipe(
				Effect.provideService(Scope.Scope, owner),
				Effect.provideService(References.MaxOpsBeforeYield, 16),
				Effect.forkScoped,
			)
			yield* Effect.tx(
				Effect.gen(function* () {
					const forks = yield* TxSubscriptionRef.get(runtime.forks)
					if (HashMap.size(forks) === 0) return yield* Effect.txRetry
				}),
			)
			yield* Fiber.interrupt(registering)
			yield* Scope.close(owner, Exit.void)
			const remaining = yield* TxSubscriptionRef.get(runtime.forks)
			assert.strictEqual(HashMap.size(remaining), 0)
		}).pipe(run),
)
