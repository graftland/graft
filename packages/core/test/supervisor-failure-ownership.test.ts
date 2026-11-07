import {
	Array,
	Cause,
	Effect,
	Exit,
	Fiber,
	HashMap,
	Option,
	PubSub,
	Ref,
	References,
	Schema,
	Stream,
	String,
	TxRef,
} from "effect"
import { assert, it } from "@effect/vitest"

import { Graft, Plugin } from "../src/index.ts"
import { supervise } from "../src/internal/activation.ts"
import * as ForkStatus from "../src/internal/forkState.ts"
import type { GraphNode, Spec } from "../src/internal/runtime.ts"
import { RuntimeContext } from "../src/internal/runtimeContext"
import { run } from "./utils.ts"

it.effect(
	"records every completed apply defect when supervision is interrupted",
	() =>
		Effect.gen(function* () {
			const { runtime } = yield* RuntimeContext
			const failed = yield* Ref.make<ReadonlyArray<string>>([])
			for (const ticks of Array.range(0, 60)) {
				const marker = `completed apply defect (${ticks})`
				const plugin = Plugin.make({
					name: "failure ownership",
					apply: () =>
						Effect.die(marker).pipe(
							Effect.onExit((exit) =>
								Exit.isFailure(exit) && Cause.hasDies(exit.cause)
									? Ref.update(failed, Array.append(marker))
									: Effect.void,
							),
						),
				})
				const spec = yield* TxRef.make<Spec>({
					plugin,
					requested: plugin,
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
						resolutions: HashMap.empty(),
					}),
				}
				const status = yield* ForkStatus.make(false, undefined, initial)
				const supervisor = yield* supervise(
					runtime,
					-1,
					spec,
					processing,
					node,
					status,
				).pipe(
					Effect.provideService(References.MaxOpsBeforeYield, 16),
					Effect.forkScoped,
				)
				for (let tick = 0; tick < ticks; tick++) yield* Effect.yieldNow
				yield* Fiber.interrupt(supervisor)
			}
			yield* Effect.log("Review completed apply failures")
			const subscription = yield* PubSub.subscribe(runtime.logs)
			const logs = yield* PubSub.takeAll(subscription)
			const completed = yield* Ref.get(failed)
			assert.isAbove(completed.length, 0)
			for (const marker of completed)
				assert.isTrue(
					Array.some(
						logs,
						({ cause, message }) =>
							String.includes(marker)(Cause.pretty(cause)) ||
							(Array.isArray(message) &&
								Array.some(
									message,
									(item) =>
										Cause.isCause(item) &&
										String.includes(marker)(Cause.pretty(item)),
								)),
					),
					`Lost ${marker}`,
				)
		}).pipe(run),
)

it.effect(
	"handles a synchronous decoder defect during an in-place update",
	() =>
		Effect.gen(function* () {
			const base = Plugin.make({
				name: "throwing update decoder",
				config: Schema.String,
				apply: () => Effect.succeed(() => Effect.succeed(true)),
			})
			const fork = yield* Graft.plugin(
				{
					...base,
					decode: (input: string): Effect.Effect<string> => {
						if (input === "bad")
							throw new Error("update decoder construction failed")
						return Effect.succeed(input)
					},
				},
				"initial",
			)
			yield* fork.await
			yield* fork.update("bad")
			yield* Effect.exit(fork.await)
			const snapshot = yield* Stream.runHead(fork.state)
			yield* fork.dispose
			const state = Option.getOrThrow(snapshot)
			assert.strictEqual(state._tag, "Failed")
			if (state._tag === "Failed")
				assert.include(
					Cause.pretty(state.cause),
					"update decoder construction failed",
				)
		}).pipe(run),
)

it.effect("captures a synchronous decoder defect inside the activation", () =>
	Effect.gen(function* () {
		const base = Plugin.make({
			name: "throwing decoder",
			apply: () => Effect.void,
		})
		const fork = yield* Graft.plugin({
			...base,
			decode: (_input: void): Effect.Effect<void> => {
				throw new Error("decoder construction failed")
			},
		})
		yield* Effect.exit(fork.await)
		const snapshot = yield* Stream.runHead(fork.state)
		yield* fork.dispose
		const state = Option.getOrThrow(snapshot)
		assert.strictEqual(state._tag, "Failed")
		if (state._tag === "Failed")
			assert.include(Cause.pretty(state.cause), "decoder construction failed")
	}).pipe(run),
)
