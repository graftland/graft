import { assert, describe, it } from "@effect/vitest"
import { Array as Arr, Context, Effect, Layer, Option, Stream } from "effect"
import { Graft, Plugin } from "../src/index.ts"
import { makeJournal, reach, run } from "./utils.ts"

class Greeter extends Context.Service<
	Greeter,
	{ readonly greet: Effect.Effect<string> }
>()("@nmnmcc/graft/test/runtime.test/Greeter") {}

const Punctuation = Context.Reference<string>(
	"@nmnmcc/graft/test/runtime.test/Punctuation",
	{
		defaultValue: () => ".",
	},
)

describe("runtime", () => {
	it.effect(
		"replaces running plugins and forwards later loads to the replacement",
		() =>
			Effect.gen(function* () {
				const journal = yield* makeJournal
				const version = (n: number) =>
					Plugin.make({
						name: `v${n}`,
						apply: () =>
							Effect.acquireRelease(journal.record(`v${n} up`), () =>
								journal.record(`v${n} down`),
							),
					})
				const v1 = version(1)
				const v2 = version(2)
				const fork = yield* Graft.plugin(v1)
				yield* fork.await
				yield* Graft.replace([[v1, v2]])
				yield* reach(fork, "Loading")
				yield* reach(fork, "Active")
				const later = yield* Graft.plugin(v1)
				yield* later.await
				yield* journal.expect(["v1 up", "v1 down", "v2 up", "v2 up"])
			}).pipe(run),
	)

	it.effect(
		"lets intercepted references reach services called from below",
		() =>
			Effect.gen(function* () {
				const journal = yield* makeJournal
				const greeter = Plugin.service(
					Greeter,
					Effect.succeed({
						greet: Effect.map(Punctuation, (mark) => `hello${mark}`),
					}),
					{ name: "greeter" },
				)
				const caller = Plugin.make({
					name: "caller",
					inject: [Greeter],
					apply: () =>
						Effect.gen(function* () {
							const greeter = yield* Greeter
							const greeting = yield* greeter.greet
							yield* journal.record(greeting)
						}),
				})
				yield* Effect.flatMap(Graft.plugin(greeter), (fork) => fork.await)
				yield* Effect.flatMap(Graft.plugin(caller), (fork) => fork.await)
				const loud = yield* Graft.plugin(caller, undefined, {
					intercept: [Graft.intercept(Punctuation, (mark) => `${mark}!!`)],
				})
				yield* loud.await
				yield* journal.expect(["hello.", "hello.!!"])
			}).pipe(run),
	)

	it.effect("reports the fork tree", () =>
		Effect.gen(function* () {
			const child = Plugin.make({ name: "child", apply: () => Effect.void })
			const parent = Plugin.make({
				name: "parent",
				apply: () => Effect.flatMap(Graft.plugin(child), (fork) => fork.await),
			})
			yield* Effect.flatMap(Graft.plugin(parent), (fork) => fork.await)
			const tree = yield* Stream.runHead(Graft.forks)
			const shape = Option.map(
				tree,
				Arr.map((node) => [
					node.name,
					node.state._tag,
					Arr.map(node.children, (child) => child.name),
				]),
			)
			assert.deepStrictEqual(
				shape,
				Option.some([["parent", "Active", ["child"]]]),
			)
		}).pipe(run),
	)

	it.effect("annotates logs with the fork that wrote them", () =>
		Effect.gen(function* () {
			const chatty = Plugin.make({
				name: "chatty",
				apply: () => Effect.log("hi"),
			})
			const fork = yield* Graft.plugin(chatty)
			yield* fork.await
			const entry = yield* Stream.runHead(Graft.logs)
			assert.deepStrictEqual(
				Option.map(entry, (entry) => [
					entry.message,
					entry.annotations["graft.plugin"],
					entry.annotations["graft.fork"],
				]),
				Option.some([["hi"], "chatty", fork.id]),
			)
		}).pipe(run),
	)

	it.effect(
		"satisfies inject from the environment the graft was built in",
		() =>
			Effect.gen(function* () {
				const journal = yield* makeJournal
				const plugin = Plugin.make({
					name: "ambient",
					inject: [Greeter],
					apply: () =>
						Effect.flatMap(Greeter, (greeter) =>
							Effect.flatMap(greeter.greet, journal.record),
						),
				})
				const fork = yield* Graft.plugin(plugin)
				yield* reach(fork, "Active")
				yield* journal.expect(["ambient hello"])
			}).pipe(
				Effect.scoped,
				Effect.provide(
					Graft.layer.pipe(
						Layer.provide(
							Layer.succeed(Greeter, {
								greet: Effect.succeed("ambient hello"),
							}),
						),
					),
				),
			),
	)

	it.effect(
		"leaves mutually dependent plugins pending instead of deadlocking",
		() =>
			Effect.gen(function* () {
				class Left extends Context.Service<Left, {}>()(
					"@nmnmcc/graft/test/runtime.test/Left",
				) {}
				class Right extends Context.Service<Right, {}>()(
					"@nmnmcc/graft/test/runtime.test/Right",
				) {}
				const left = Plugin.make({
					name: "left",
					inject: [Right],
					apply: () => Graft.provide(Left, {}),
				})
				const right = Plugin.make({
					name: "right",
					inject: [Left],
					apply: () => Graft.provide(Right, {}),
				})
				const forks = yield* Effect.all([
					Graft.plugin(left),
					Graft.plugin(right),
				])
				yield* Effect.forEach(forks, (fork) => reach(fork, "Pending"), {
					discard: true,
				})
				yield* Effect.forEach(forks, (fork) => fork.dispose, { discard: true })
			}).pipe(run),
	)

	it.effect(
		"survives concurrent loading and unloading of providers and consumers",
		() =>
			Effect.gen(function* () {
				const provider = Plugin.service(
					Greeter,
					Effect.succeed({ greet: Effect.succeed("hi") }),
					{ name: "provider" },
				)
				const consumer = Plugin.make({
					name: "consumer",
					inject: [Greeter],
					apply: () => Effect.asVoid(Greeter),
				})
				const consumers = yield* Effect.forEach(Arr.range(1, 20), () =>
					Graft.plugin(consumer),
				)
				yield* Effect.forEach(
					Arr.range(1, 30),
					() =>
						Effect.flatMap(Graft.plugin(provider), (fork) =>
							Effect.andThen(fork.await, fork.dispose),
						),
					{ concurrency: 1 },
				)
				const final = yield* Graft.plugin(provider)
				yield* final.await
				yield* Effect.forEach(consumers, (fork) => reach(fork, "Active"), {
					discard: true,
					concurrency: "unbounded",
				})
				yield* final.dispose
				yield* Effect.forEach(consumers, (fork) => reach(fork, "Pending"), {
					discard: true,
					concurrency: "unbounded",
				})
			}).pipe(run),
	)
})

describe("types", () => {
	it("rejects requirements that inject does not declare", () => {
		Plugin.make({
			name: "declared",
			inject: [Greeter],
			apply: () => Effect.asVoid(Greeter),
		})
		Plugin.make({
			name: "undeclared",
			// @ts-expect-error Greeter is required but not injected
			// @effect-diagnostics-next-line missingEffectContext:off -- this line asserts the type error below
			apply: () => Effect.asVoid(Greeter),
		})
		Plugin.make({
			name: "optional",
			inject: [Plugin.optional(Greeter)],
			// @ts-expect-error an optional dependency cannot satisfy a requirement
			// @effect-diagnostics-next-line missingEffectContext:off -- this line asserts the type error below
			apply: () => Effect.asVoid(Greeter),
		})
		Plugin.make({
			name: "extra",
			inject: [Greeter, Punctuation],
			apply: () => Effect.void,
		})
	})
})
