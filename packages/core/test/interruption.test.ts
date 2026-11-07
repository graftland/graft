import {
	Array,
	Context,
	Effect,
	Exit,
	Fiber,
	HashMap,
	HashSet,
	Option,
	References,
	Scope,
	TxRef,
} from "effect"
import { assert, it } from "@effect/vitest"

import { Graft, Plugin } from "../src/index.ts"
import { supervise } from "../src/internal/activation.ts"
import * as ForkStatus from "../src/internal/forkState.ts"
import { realmKey, type GraphNode, type Spec } from "../src/internal/runtime.ts"
import { RuntimeContext } from "../src/internal/runtimeContext"
import * as Snapshots from "../src/internal/snapshot.ts"
import { registrySnapshot, run } from "./utils.ts"

class Service extends Context.Service<Service, string>()(
	"@graftland/graft/test/interruption.test/Service",
) {}

it.effect(
	"balances acquisition leases under interruption at varied scheduler boundaries",
	() =>
		Effect.gen(function* () {
			const { runtime } = yield* RuntimeContext
			yield* Graft.provide(Service, "ready")
			const registry = yield* registrySnapshot(runtime)
			const provision = Option.getOrThrow(
				HashMap.get(registry, realmKey("", Service.key)),
			)
			const plugin = Plugin.make({
				name: "consumer",
				inject: [Service],
				apply: () => Effect.never,
			})
			for (const ticks of Array.range(0, 100)) {
				const spec = yield* TxRef.make<Spec>({
					plugin,
					input: undefined,
					revision: 0,
				})
				const initial = yield* TxRef.get(spec)
				const processing = yield* TxRef.make(initial)
				const node: GraphNode = {
					id: -1,
					parent: undefined,
					state: TxRef.makeUnsafe<GraphNode["state"]["value"]>({
						live: true,
						resolution: undefined,
					}),
				}
				const status = yield* ForkStatus.make(undefined, initial)
				const supervisor = yield* supervise(
					runtime,
					-1,
					spec,
					processing,
					node,
					status,
				).pipe(
					Effect.provideService(References.MaxOpsBeforeYield, 4),
					Effect.forkScoped,
				)
				for (const _ of Array.range(0, ticks)) yield* Effect.yieldNow
				yield* Fiber.interrupt(supervisor)
				const count = yield* TxRef.get(provision.consumers)
				const graph = yield* TxRef.get(node.state)
				assert.strictEqual(
					graph.resolution,
					undefined,
					`Activation leaked after ${ticks} yields`,
				)
				assert.strictEqual(
					HashSet.size(count),
					0,
					`Lease leaked after ${ticks} yields`,
				)
			}
		}).pipe(run),
)

it.effect(
	"removes a fork entry when its registering caller is interrupted",
	() =>
		Effect.gen(function* () {
			const { runtime } = yield* RuntimeContext
			const owner = yield* Scope.make()
			const plugin = Plugin.make({
				name: "interrupted registration",
				apply: () => Effect.void,
			})
			const registering = yield* Graft.plugin(plugin).pipe(
				Effect.provideService(Scope.Scope, owner),
				Effect.provideService(References.MaxOpsBeforeYield, 4),
				Effect.forkScoped,
			)
			yield* Effect.tx(
				Effect.gen(function* () {
					const forks = yield* Snapshots.get(runtime.forks)
					if (HashMap.size(forks) === 0) return yield* Effect.txRetry
				}),
			)
			yield* Fiber.interrupt(registering)
			yield* Scope.close(owner, Exit.void)
			const remaining = yield* Snapshots.get(runtime.forks)
			assert.strictEqual(HashMap.size(remaining), 0)
		}).pipe(run),
)
