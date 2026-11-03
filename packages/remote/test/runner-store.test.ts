import { assert, describe, it } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { Cause, Effect, Exit, FileSystem, Layer } from "effect"
import { Digest } from "effect/crypto"
import * as Stores from "../src/internal/runner/Store"
import { defaults, type Record } from "../src/internal/runner/model"

const record: Record = {
	version: 1,
	handle: {
		key: { identity: "certificate/../../identity", instance: "../instance" },
		token: "session",
		generation: 1,
	},
	requestId: "request",
	leaseMillis: 15_000,
	limits: defaults,
	phase: "Loaded",
	child: { pid: 42, start: "process-start" },
	load: { specifier: "fixture" },
	code: { name: "fixture", version: "1.0.0", digest: "digest" },
}
const runtime = Layer.merge(NodeServices.layer, Digest.layerWebCrypto)
describe("runner state directory", () => {
	it.effect(
		"persists generations and process identities across store reconstruction",
		() =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const directory = yield* fs.makeTempDirectoryScoped()
				const first = yield* Stores.directory(directory)
				yield* first.save(record)
				const second = yield* Stores.directory(directory)
				const loaded = yield* second.list
				assert.deepEqual(loaded, [record])
				yield* second.save({
					...record,
					phase: "Stopped",
					reason: "Recovery",
					termination: {
						kind: "Killed",
						exit: { code: null, signal: "SIGKILL" },
						cause: Cause.empty,
					},
				})
				const third = yield* Stores.directory(directory)
				const stopped = yield* third.list
				assert.lengthOf(stopped, 1)
				assert.equal(stopped[0]!.phase, "Stopped")
				assert.equal(stopped[0]!.handle.generation, 1)
				const files = yield* fs.readDirectory(directory)
				assert.lengthOf(files, 1)
				assert.match(files[0]!, /^[a-f0-9]{64}\.json$/)
			}).pipe(Effect.scoped, Effect.provide(runtime)),
		60_000,
	)
	it.effect(
		"fails closed on corrupt state instead of resetting the generation counter",
		() =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const directory = yield* fs.makeTempDirectoryScoped()
				const store = yield* Stores.directory(directory)
				yield* fs.writeFileString(directory + "/broken.json", "{")
				const result = yield* Effect.exit(store.list)
				assert.isTrue(Exit.isFailure(result))
				if (Exit.isFailure(result))
					assert.include(
						Cause.pretty(result.cause),
						"Runner state storage failed",
					)
			}).pipe(Effect.scoped, Effect.provide(runtime)),
		60_000,
	)
})
