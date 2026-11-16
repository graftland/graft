import { Context, Effect, Layer, Option, Queue, Stream } from "effect"
import { assert, describe, it } from "@effect/vitest"

import * as Graft from "../src/Graft.ts"
import { run } from "./b1b-utils.ts"

const Setting = Context.Reference<string>(
	"@graftland/graft/test/reference-resolution.test/Setting",
	{ defaultValue: () => "default" },
)

const reader = (seen: Queue.Queue<string>) =>
	Layer.effectDiscard(
		Effect.flatMap(Setting, (value) =>
			Queue.offer(seen, value).pipe(Effect.asVoid),
		),
	)

describe("reference resolution", () => {
	it.effect("starts an injected reference with its default value", () =>
		Effect.gen(function* () {
			const seen = yield* Queue.unbounded<string>()
			const mount = yield* Graft.mount(reader(seen), {
				name: "reference",
				requires: [Setting],
			})
			yield* mount.await
			const state = yield* mount.state.pipe(Stream.runHead)
			assert.strictEqual(Option.getOrThrow(state)._tag, "Active")
			const value = yield* Queue.take(seen)
			assert.strictEqual(value, "default")
		}).pipe(run),
	)

	it.effect(
		"prefers provisions to intercepted reference fallback and restores that fallback",
		() =>
			Effect.gen(function* () {
				const seen = yield* Queue.unbounded<string>()
				const mount = yield* Graft.mount(reader(seen), {
					name: "reference",
					requires: [Setting],
					intercept: [
						Graft.intercept(Setting, (value) => `${value} intercepted`),
					],
				})
				yield* mount.await
				const initial = yield* Queue.take(seen)
				assert.strictEqual(initial, "default intercepted")
				const provider = yield* Graft.publish(Setting, "dynamic")
				const dynamic = yield* Queue.take(seen)
				assert.strictEqual(dynamic, "dynamic")
				yield* provider.unmount
				const fallback = yield* Queue.take(seen)
				assert.strictEqual(fallback, "default intercepted")
			}).pipe(run),
	)

	it.effect(
		"applies child intercepts after stripping the parent's provision",
		() =>
			Effect.gen(function* () {
				const seen = yield* Queue.unbounded<string>()
				yield* Graft.publish(Setting, "private")
				const parent = yield* Graft.mount(
					Layer.effectDiscard(
						Effect.gen(function* () {
							const child = yield* Graft.mount(reader(seen), {
								name: "child",
								requires: [Setting],
								isolate: [Setting],
								intercept: [
									Graft.intercept(Setting, (value) => `${value} child`),
								],
							})
							yield* child.await
						}),
					),
					{ name: "parent", requires: [Setting] },
				)
				yield* parent.await
				const value = yield* Queue.take(seen)
				assert.strictEqual(value, "default child")
			}).pipe(run),
	)

	it.effect(
		"preserves inherited intercepts when a provision shadows the parent's reference",
		() =>
			Effect.gen(function* () {
				const seen = yield* Queue.unbounded<string>()
				yield* Graft.publish(Setting, "dynamic")
				const parent = yield* Graft.mount(
					Layer.effectDiscard(
						Effect.gen(function* () {
							const child = yield* Graft.mount(reader(seen), {
								name: "isolated child",
								requires: [Graft.optional(Setting)],
								isolate: [Setting],
								intercept: [
									Graft.intercept(Setting, (value) => value + " child"),
								],
							})
							yield* child.await
						}),
					),
					{
						name: "intercepted parent",
						requires: [Setting],
						intercept: [Graft.intercept(Setting, (value) => value + " parent")],
					},
				)
				yield* parent.await
				const actual = yield* Queue.take(seen)
				assert.strictEqual(actual, "default parent child")
			}).pipe(run),
	)
})
