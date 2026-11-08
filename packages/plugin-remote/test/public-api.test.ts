import { Array, Effect, FileSystem, String } from "effect"
import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"

const root = new URL("../src/", import.meta.url)

describe("public contracts", () => {
	it.live("depend only on Effect and sibling contract types", () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			for (const name of ["Transport"]) {
				const source = yield* fs.readFileString(
					new URL(`${name}.ts`, root).pathname,
				)
				const imports = Array.fromIterable(
					String.matchAll(/from "([^"]+)"/g)(source),
				)
				assert.isTrue(
					Array.every(
						imports,
						(match) => match[1] === "effect" || match[1] === "./Errors",
					),
				)
				assert.isFalse(String.includes("internal/")(source))
			}
		}).pipe(Effect.provide(NodeServices.layer)),
	)
})
