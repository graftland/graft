import { assert, describe, it } from "@effect/vitest"
import { Context, Effect, Option, Queue, Stream } from "effect"
import { Graft, Plugin } from "../src/index.ts"
import { run } from "./utils.ts"

const Setting = Context.Reference<string>(
	"@graftland/graft/test/reference-resolution.test/Setting",
	{ defaultValue: () => "default" },
)

describe("reference resolution", () => {
	it.effect("starts an injected reference with its default value", () =>
		Effect.gen(function* () {
			const seen = yield* Queue.unbounded<string>()
			const fork = yield* Graft.plugin(
				Plugin.make({
					name: "reference",
					inject: [Setting],
					apply: () =>
						Effect.flatMap(Setting, (value) =>
							Queue.offer(seen, value).pipe(Effect.asVoid),
						),
				}),
			)
			yield* fork.await
			const state = yield* fork.state.pipe(Stream.runHead)
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
				const fork = yield* Graft.plugin(
					Plugin.make({
						name: "reference",
						inject: [Setting],
						apply: () =>
							Effect.flatMap(Setting, (value) =>
								Queue.offer(seen, value).pipe(Effect.asVoid),
							),
					}),
					undefined,
					{
						intercept: [
							Graft.intercept(Setting, (value) => `${value} intercepted`),
						],
					},
				)
				yield* fork.await
				const initial = yield* Queue.take(seen)
				assert.strictEqual(initial, "default intercepted")
				const provider = yield* Graft.plugin(
					Plugin.service(Setting, Effect.succeed("dynamic"), {
						name: "provider",
					}),
				)
				yield* provider.await
				const dynamic = yield* Queue.take(seen)
				assert.strictEqual(dynamic, "dynamic")
				yield* provider.dispose
				const fallback = yield* Queue.take(seen)
				assert.strictEqual(fallback, "default intercepted")
			}).pipe(run),
	)

	it.effect(
		"applies child intercepts after stripping the parent's provision",
		() =>
			Effect.gen(function* () {
				const seen = yield* Queue.unbounded<string>()
				const provider = yield* Graft.plugin(
					Plugin.service(Setting, Effect.succeed("private"), {
						name: "provider",
					}),
				)
				yield* provider.await
				const parent = yield* Graft.plugin(
					Plugin.make({
						name: "parent",
						inject: [Setting],
						apply: () =>
							Effect.gen(function* () {
								const child = yield* Graft.plugin(
									Plugin.make({
										name: "child",
										inject: [Setting],
										apply: () =>
											Effect.flatMap(Setting, (value) =>
												Queue.offer(seen, value).pipe(Effect.asVoid),
											),
									}),
									undefined,
									{
										isolate: [Setting],
										intercept: [
											Graft.intercept(Setting, (value) => `${value} child`),
										],
									},
								)
								yield* child.await
							}),
					}),
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
				const provider = yield* Graft.plugin(
					Plugin.service(Setting, Effect.succeed("dynamic"), {
						name: "provider",
					}),
				)
				yield* provider.await
				const parent = yield* Graft.plugin(
					Plugin.make({
						name: "intercepted parent",
						inject: [Setting],
						apply: () =>
							Effect.gen(function* () {
								const child = yield* Graft.plugin(
									Plugin.make({
										name: "isolated child",
										inject: [Plugin.optional(Setting)],
										apply: () =>
											Effect.flatMap(Setting, (value) =>
												Queue.offer(seen, value).pipe(Effect.asVoid),
											),
									}),
									undefined,
									{
										isolate: [Setting],
										intercept: [
											Graft.intercept(Setting, (value) => value + " child"),
										],
									},
								)
								yield* child.await
							}),
					}),
					undefined,
					{
						intercept: [Graft.intercept(Setting, (value) => value + " parent")],
					},
				)
				yield* parent.await
				const actual = yield* Queue.take(seen)
				assert.strictEqual(actual, "default parent child")
			}).pipe(run),
	)
})
