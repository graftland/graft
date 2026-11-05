import { Effect, Exit, Schema, String } from "effect"
import { assert, it } from "@effect/vitest"

import { detectAgent } from "../src/index.ts"
import { PackageManagerDeclaration } from "../src/PackageManagerDeclaration.ts"
import { run, setup } from "./fixtures.ts"

it.effect(
	"rejects malformed exact versions and unsupported Corepack hashes during detection",
	() =>
		Effect.gen(function* () {
			const { directory, write } = yield* setup
			for (const declaration of [
				"pnpm@9.15.9-",
				"pnpm@9.15.9+",
				"pnpm@9.15.9-rc..1",
				"pnpm@09.15.9",
				"pnpm@9.015.9",
				"pnpm@9.15.09",
				"pnpm@9.15.9-01",
				"pnpm@9.15.9-rc.01",
				"pnpm@9.15.9-rc_1",
				"pnpm@9.15.9-rc.1\n",
				"yarn@4.0.0+build.1",
				"npm@11.0.0+sha512.abc",
				`pnpm@9.15.9+sha512.${String.repeat(128)("A")}`,
				`pnpm@9.15.9+sha512.${String.repeat(128)("g")}`,
				`pnpm@9.15.9+sha512.${String.repeat(128)("a")}.extra`,
				"pnpm@9.15.9+sha999.abc",
				"pnpm@^9.15.9",
				"pnpm@latest",
				"pnpm@v9.15.9",
				"pnpm@https://example.com/pnpm.tgz",
				"pnpm@9007199254740992.0.0",
				`pnpm@9.15.9-${String.repeat(256)("a")}`,
			]) {
				const text = yield* Schema.encodeEffect(
					Schema.fromJsonString(
						Schema.Struct({ packageManager: Schema.String }),
					),
				)({ packageManager: declaration })
				yield* write("package.json", text)
				const exit = yield* Effect.exit(
					detectAgent({ directory, userAgent: "npm/11.0.0" }),
				)
				assert(Exit.isFailure(exit), declaration)
			}
		}).pipe(run),
)

it.effect(
	"round-trips exact versions and each supported hash while detecting the correct agent",
	() =>
		Effect.gen(function* () {
			const { directory, write } = yield* setup
			for (const [declaration, expected] of [
				["npm@11.0.0", "npm"],
				["pnpm@9.15.9-rc.1", "pnpm"],
				["yarn@1.22.22", "yarn-classic"],
				["yarn@4.0.0-rc.1", "yarn-berry"],
				[`yarn@1.22.22+sha224.${String.repeat(56)("a")}`, "yarn-classic"],
				[`pnpm@9.15.9+sha256.${String.repeat(64)("0")}`, "pnpm"],
				[`npm@11.0.0+sha384.${String.repeat(96)("1")}`, "npm"],
				[`yarn@4.0.0-rc.1+sha512.${String.repeat(128)("b")}`, "yarn-berry"],
			] as const) {
				const parsed = yield* Schema.decodeEffect(PackageManagerDeclaration)(
					declaration,
				)
				const encoded = yield* Schema.encodeEffect(PackageManagerDeclaration)(
					parsed,
				)
				assert.strictEqual(encoded, declaration)
				const manifest = yield* Schema.encodeEffect(
					Schema.fromJsonString(
						Schema.Struct({ packageManager: Schema.String }),
					),
				)({ packageManager: declaration })
				yield* write("package.json", manifest)
				const agent = yield* detectAgent({ directory })
				assert.strictEqual(agent, expected)
			}
		}).pipe(run),
)

it.effect(
	"reports which constraint an unsupported packageManager declaration fails",
	() =>
		Effect.gen(function* () {
			const { directory, write } = yield* setup
			for (const [declaration, reason] of [
				[
					`pnpm@9.15.9+sha512.${String.repeat(128)("A")}`,
					"lowercase hexadecimal",
				],
				["yarn@4.0.0+build.1", "lowercase hexadecimal"],
			] as const) {
				const text = yield* Schema.encodeEffect(
					Schema.fromJsonString(
						Schema.Struct({ packageManager: Schema.String }),
					),
				)({ packageManager: declaration })
				yield* write("package.json", text)
				const error = yield* Effect.flip(detectAgent({ directory }))
				assert.strictEqual(error._tag, "PackageManagerError")
				assert.include(error.message, declaration)
				assert.include(error.message, reason)
			}
		}).pipe(run),
)
