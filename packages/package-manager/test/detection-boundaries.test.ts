import { Cause, Effect, Exit, Option } from "effect"
import { assert, describe, it } from "@effect/vitest"

import { detectAgent } from "../src/index.ts"
import { run, setup } from "./fixtures.ts"

describe("detection boundaries", () => {
	it.effect(
		"uses an explicit agent before packageManager and packageManager before conflicting locks",
		() =>
			Effect.gen(function* () {
				const { directory, write } = yield* setup
				yield* write("package.json", '{"packageManager":"yarn@1.22.22"}')
				yield* write("pnpm-lock.yaml", "lockfileVersion: 9")
				yield* write("yarn.lock", "__metadata:\n  version: 8")
				const observed1 = yield* detectAgent({ directory, agent: "npm" })
				assert.strictEqual(observed1, "npm")
				const observed2 = yield* detectAgent({
					directory,
					userAgent: "pnpm/9.15.9",
				})

				assert.strictEqual(observed2, "yarn-classic")
				yield* write("package.json", "{}")
				const observed3 = yield* Effect.exit(detectAgent({ directory }))
				assert(Exit.isFailure(observed3))
			}).pipe(run),
	)

	it.effect("treats npm shrinkwrap and package-lock as one manager", () =>
		Effect.gen(function* () {
			const { directory, write } = yield* setup
			yield* write("package.json", "{}")
			yield* write("package-lock.json", "{}")
			yield* write("npm-shrinkwrap.json", "{}")
			const observed4 = yield* detectAgent({
				directory,
				userAgent: "yarn/4.9.0",
			})
			assert.strictEqual(observed4, "npm")
		}).pipe(run),
	)

	it.effect(
		"rejects a packageManager declaration with a trailing newline",
		() =>
			Effect.gen(function* () {
				const { directory, write } = yield* setup
				yield* write("package.json", '{"packageManager":"pnpm@9.15.9\\n"}')
				const observed5 = yield* Effect.exit(detectAgent({ directory }))
				assert(Exit.isFailure(observed5))
			}).pipe(run),
	)

	it.effect(
		"rejects reserved dependency names and trailing newlines before spawning",
		() =>
			Effect.gen(function* () {
				const { write, read, manager } = yield* setup
				yield* write("package.json", "{}")
				const pm = yield* manager(() => Effect.die("must not spawn"))
				for (const name of [
					"node_modules",
					"favicon.ico",
					"dependency\n",
					"../escape",
				]) {
					const exit = yield* Effect.exit(
						pm.install({ valid: "2", [name]: "1" }),
					)
					assert(Exit.isFailure(exit))
					assert.strictEqual(
						Option.getOrThrow(Cause.findErrorOption(exit.cause))._tag,
						"SchemaError",
					)
					const observed6 = yield* read("package.json")

					assert.strictEqual(observed6, "{}")
				}
			}).pipe(run),
	)
	it.effect(
		"rejects invalid names already in the manifest instead of omitting them from state",
		() =>
			Effect.gen(function* () {
				const { write, manager } = yield* setup
				yield* write(
					"package.json",
					'{"dependencies":{"valid":"1","../invalid":"2"}}',
				)
				const exit = yield* Effect.exit(
					manager(() => Effect.die("must not spawn")),
				)
				assert(Exit.isFailure(exit))
				assert.strictEqual(
					Option.getOrThrow(Cause.findErrorOption(exit.cause))._tag,
					"SchemaError",
				)
			}).pipe(run),
	)
})
