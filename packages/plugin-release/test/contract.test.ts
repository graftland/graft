import { Effect, FileSystem, Path } from "effect"
import { NodeServices } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"

import { resolveContract } from "../src/internal/contract"

it.effect(
	"resolves relative contract paths from the release source and normalizes execution URLs",
	() =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const path = yield* Path.Path
			const directory = yield* fs.makeTempDirectoryScoped()
			const contract = path.join(directory, "contract with spaces", "index.js")
			yield* fs.makeDirectory(path.dirname(contract))
			yield* fs.writeFileString(contract, "export default {}")
			const resolved = yield* resolveContract(
				path.join(directory, "graft.yml"),
				"./contract with spaces/index.js",
			)
			const canonical = yield* fs.realPath(contract)
			const expected = yield* path.toFileUrl(canonical)
			assert.equal(resolved, expected.href)
			const same = yield* resolveContract(
				path.join(directory, "unrelated.yml"),
				resolved,
			)
			assert.equal(same, resolved)
			for (const specifier of [
				"node:fs",
				"https://example.test/contract.js",
				resolved + "?revision=1",
			]) {
				const error = yield* Effect.flip(
					resolveContract(path.join(directory, "graft.yml"), specifier),
				)
				assert.equal(error._tag, "ReleaseError")
				if (error._tag === "ReleaseError") assert.equal(error.code, "Contract")
			}
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
)
