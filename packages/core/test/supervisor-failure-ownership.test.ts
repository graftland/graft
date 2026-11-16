import {
	Array,
	Cause,
	Effect,
	Exit,
	Fiber,
	Layer,
	PubSub,
	Ref,
	References,
	String,
	TxRef,
} from "effect"
import { assert, it } from "@effect/vitest"

import * as Graft from "../src/Graft.ts"
import { supervise } from "../src/internal/activation.ts"
import * as MountStatus from "../src/internal/mountStatus.ts"
import type { GraphNode, Spec } from "../src/internal/runtime.ts"
import { RuntimeContext } from "../src/internal/runtimeContext"
import { current, run } from "./b1c-utils.ts"

it.effect(
	"records every completed apply defect when supervision is interrupted",
	() =>
		Effect.gen(function* () {
			const { runtime } = yield* RuntimeContext
			const failed = yield* Ref.make<ReadonlyArray<string>>([])
			for (const ticks of Array.range(0, 60)) {
				const marker = `completed apply defect (${ticks})`
				const definition = {
					name: "failure ownership",
					requires: [],
					retry: undefined,
					apply: () =>
						Effect.die(marker).pipe(
							Effect.onExit((exit) =>
								Exit.isFailure(exit) && Cause.hasDies(exit.cause)
									? Ref.update(failed, Array.append(marker))
									: Effect.void,
							),
						),
				}
				const spec = yield* TxRef.make<Spec>({
					definition,
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
				const status = yield* MountStatus.make(undefined, initial)
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

it.effect("captures a synchronous defect inside the activation", () =>
	Effect.gen(function* () {
		const mount = yield* Graft.mount(
			Layer.effectDiscard(
				Effect.sync(() => {
					throw new Error("activation construction defect")
				}),
			),
			{ name: "synchronous defect" },
		)
		yield* Effect.exit(mount.await)
		const state = yield* current(mount)
		yield* mount.unmount
		assert.strictEqual(state._tag, "Failed")
		if (state._tag === "Failed")
			assert.include(
				Cause.pretty(state.cause),
				"activation construction defect",
			)
	}).pipe(run),
)
