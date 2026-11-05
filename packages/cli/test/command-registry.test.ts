import { Effect, Result } from "effect"
import { Command } from "effect/cli"
import { assert, it } from "@effect/vitest"

import * as Registry from "../src/internal/commandRegistry"

it.effect(
	"rejects reserved names, duplicate aliases and registrations after discovery",
	() =>
		Effect.gen(function* () {
			const registry = yield* Registry.make([Command.make("start")])
			const first = registry.service("first")
			const reserved = yield* first
				.register(Command.make("start"))
				.pipe(Effect.result)
			assert.isTrue(Result.isFailure(reserved))
			yield* first.register(Command.make("hello").pipe(Command.withAlias("hi")))
			const duplicate = yield* registry
				.service("second")
				.register(Command.make("hi"))
				.pipe(Effect.result)
			assert.isTrue(Result.isFailure(duplicate))
			const commands = yield* registry.freeze
			assert.equal(commands.length, 1)
			const late = yield* registry
				.service("late")
				.register(Command.make("later"))
				.pipe(Effect.result)
			assert.isTrue(Result.isFailure(late))
		}).pipe(Effect.scoped),
)

it.effect("owns registrations in the activation scope", () =>
	Effect.gen(function* () {
		const registry = yield* Registry.make([])
		yield* Effect.scoped(
			registry.service("owner").register(Command.make("hello")),
		)
		const commands = yield* registry.freeze
		assert.deepEqual(commands, [])
	}).pipe(Effect.scoped),
)
