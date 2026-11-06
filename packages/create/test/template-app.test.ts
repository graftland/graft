import { Array, Effect, Fiber, FileSystem, Option, Path, Stream } from "effect"
import { TestClock } from "effect/testing"
import { NodeServices } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"

import { Graft, Plugin } from "@graftland/graft"

import { create } from "../src/index.ts"

/**
 * Generates the app under .cache, where its imports resolve to this workspace,
 * so the test runs the files a user gets, with the package name filled in.
 */
const generate = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const directory = path.join(
		path.dirname(path.dirname(new URL(import.meta.url).pathname)),
		".cache",
		"template-app",
	)
	yield* fs.remove(directory, { recursive: true, force: true })
	yield* create({ directory })
	return directory
})

const load = (file: string) =>
	Effect.promise(() => import(file)).pipe(
		Effect.flatMap((module) =>
			Option.match(Plugin.fromModule(module), {
				onNone: () => Effect.die(`${file} exports no plugin`),
				// A loaded module carries no types; the template's plugins only fail to decode config.
				onSome: (plugin) =>
					Effect.succeed(plugin as Plugin.Plugin<unknown, unknown, never>),
			}),
		),
	)

/** Log messages as text; `Graft.logs` replays recent lines. */
const messages = Graft.logs.pipe(
	Stream.map((entry) =>
		Array.join(
			Array.map([entry.message].flat(), (part) => `${part}`),
			" ",
		),
	),
)

it.effect("the app template's ticker greets through the greeter", () =>
	Effect.gen(function* () {
		const directory = yield* generate
		const greeter = yield* load(`${directory}/src/greeter.ts`)
		const ticker = yield* load(`${directory}/src/ticker.ts`)
		assert.strictEqual(greeter.name, "template-app/greeter")
		const greeting = yield* Graft.plugin(greeter, { greeting: "Hello" })
		const greets = yield* Graft.plugin(ticker, { name: "Graft" })
		yield* greets.await
		const greetings = yield* Effect.forkChild(
			messages.pipe(
				Stream.filter((line) => line === "Hello, Graft!"),
				Stream.take(2),
				Stream.runCollect,
			),
		)
		// The ticker may not have scheduled its next greeting yet; step the clock.
		yield* Effect.repeat(
			Effect.andThen(Effect.yieldNow, TestClock.adjust("3 seconds")),
			{ times: 3 },
		)
		const lines = yield* Fiber.join(greetings)
		assert.deepStrictEqual(lines, ["Hello, Graft!", "Hello, Graft!"])
		yield* greeting.dispose
		const pending = yield* greets.state.pipe(
			Stream.filter((state) => state._tag === "Pending"),
			Stream.runHead,
		)
		assert.isTrue(Option.isSome(pending))
	}).pipe(Effect.scoped, Effect.provide([Graft.layer, NodeServices.layer])),
)
