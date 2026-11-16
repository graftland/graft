import { Array, Context, Effect, Layer, Option, Stream } from "effect"
import { assert, describe, it } from "@effect/vitest"

import * as Graft from "../src/Graft.ts"
import { makeJournal, reach, run } from "./b1c-utils.ts"

class Greeter extends Context.Service<
	Greeter,
	{ readonly greet: Effect.Effect<string> }
>()("@graftland/graft/test/runtime.test/Greeter") {}

const Punctuation = Context.Reference<string>(
	"@graftland/graft/test/runtime.test/Punctuation",
	{
		defaultValue: () => ".",
	},
)

describe("runtime", () => {
	it.effect(
		"lets intercepted references reach services called from below",
		() =>
			Effect.gen(function* () {
				const journal = yield* makeJournal
				const greeter = Layer.succeed(Greeter, {
					greet: Effect.map(Punctuation, (mark) => `hello${mark}`),
				})
				const caller = Layer.effectDiscard(
					Effect.gen(function* () {
						const greeter = yield* Greeter
						const greeting = yield* greeter.greet
						yield* journal.record(greeting)
					}),
				)
				yield* Effect.flatMap(
					Graft.mount(greeter, { name: "greeter" }),
					(mount) => mount.await,
				)
				yield* Effect.flatMap(
					Graft.mount(caller, { name: "caller", requires: [Greeter] }),
					(mount) => mount.await,
				)
				const loud = yield* Graft.mount(caller, {
					name: "caller",
					requires: [Greeter],
					intercept: [Graft.intercept(Punctuation, (mark) => `${mark}!!`)],
				})
				yield* loud.await
				yield* journal.expect(["hello.", "hello.!!"])
			}).pipe(run),
	)

	it.effect("reports the mount tree", () =>
		Effect.gen(function* () {
			const child = Layer.effectDiscard(Effect.void)
			const parent = Layer.effectDiscard(
				Effect.gen(function* () {
					const mount = yield* Graft.mount(child, { name: "child" })
					yield* mount.await
				}),
			)
			yield* Effect.flatMap(
				Graft.mount(parent, { name: "parent" }),
				(mount) => mount.await,
			)
			const tree = yield* Stream.runHead(Graft.mounts)
			const shape = Option.map(tree, (nodes) =>
				Array.map(nodes, (node) => [
					node.name,
					node.state._tag,
					Array.map(node.children, (child) => child.name),
				]),
			)
			assert.deepStrictEqual(
				shape,
				Option.some([["parent", "Active", ["child"]]]),
			)
		}).pipe(run),
	)

	it.effect("annotates logs with the mount that wrote them", () =>
		Effect.gen(function* () {
			const chatty = Layer.effectDiscard(Effect.log("hi"))
			const mount = yield* Graft.mount(chatty, { name: "chatty" })
			yield* mount.await
			const entry = yield* Stream.runHead(Graft.logs)
			assert.deepStrictEqual(
				Option.map(entry, (entry) => [
					entry.message,
					entry.annotations["graft.name"],
					entry.annotations["graft.mount"],
				]),
				Option.some([["hi"], "chatty", mount.id]),
			)
		}).pipe(run),
	)

	it.effect(
		"satisfies requires from the environment the graph was built in",
		() =>
			Effect.gen(function* () {
				const journal = yield* makeJournal
				const ambient = Layer.effectDiscard(
					Effect.flatMap(Greeter, (greeter) =>
						Effect.flatMap(greeter.greet, journal.record),
					),
				)
				const mount = yield* Graft.mount(ambient, {
					name: "ambient",
					requires: [Greeter],
				})
				yield* reach(mount, "Active")
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
		"leaves mutually dependent mounts pending instead of deadlocking",
		() =>
			Effect.gen(function* () {
				class Left extends Context.Service<Left, {}>()(
					"@graftland/graft/test/runtime.test/Left",
				) {}
				class Right extends Context.Service<Right, {}>()(
					"@graftland/graft/test/runtime.test/Right",
				) {}
				const left = yield* Graft.mount(
					Layer.effect(Left, Effect.as(Right, {})),
					{ name: "left", requires: [Right] },
				)
				const right = yield* Graft.mount(
					Layer.effect(Right, Effect.as(Left, {})),
					{ name: "right", requires: [Left] },
				)
				yield* reach(left, "Pending")
				yield* reach(right, "Pending")
				yield* left.unmount
				yield* right.unmount
			}).pipe(run),
	)

	it.effect(
		"survives concurrent loading and unloading of providers and consumers",
		() =>
			Effect.gen(function* () {
				const provider = Layer.succeed(Greeter, {
					greet: Effect.succeed("hi"),
				})
				const consumer = Layer.effectDiscard(Effect.asVoid(Greeter))
				const consumers = yield* Effect.forEach(Array.range(1, 20), () =>
					Graft.mount(consumer, { name: "consumer", requires: [Greeter] }),
				)
				yield* Effect.forEach(
					Array.range(1, 30),
					() =>
						Effect.flatMap(
							Graft.mount(provider, { name: "provider" }),
							(mount) => Effect.andThen(mount.await, mount.unmount),
						),
					{ concurrency: 1 },
				)
				const final = yield* Graft.mount(provider, { name: "provider" })
				yield* final.await
				yield* Effect.forEach(consumers, (mount) => reach(mount, "Active"), {
					discard: true,
					concurrency: "unbounded",
				})
				yield* final.unmount
				yield* Effect.forEach(consumers, (mount) => reach(mount, "Pending"), {
					discard: true,
					concurrency: "unbounded",
				})
			}).pipe(run),
	)
})

describe("types", () => {
	it("rejects requirements that requires does not declare", () => {
		const needsGreeter = Layer.effectDiscard(Effect.asVoid(Greeter))
		const accepted = Effect.all([
			Graft.mount(needsGreeter, { requires: [Greeter] }),
			Graft.mount(Layer.effectDiscard(Effect.void), {
				requires: [Greeter, Punctuation],
			}),
		])
		// @ts-expect-error Greeter is required but not declared
		// @effect-diagnostics-next-line missingLayerContext:off -- this line asserts the type error below
		const undeclared = Graft.mount(needsGreeter)
		void [accepted, undeclared]
	})
})
