import { assert, describe, it } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import {
	Array,
	Cause,
	Effect,
	Exit,
	FileSystem,
	Layer,
	Number,
	Schema,
} from "effect"
import { Digest } from "effect/crypto"
import * as Stores from "../src/internal/runner/Store"
import { defaults, Record } from "../src/internal/runner/model"

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
		"compacts terminal history while retaining unfinished records and durable high-water marks",
		() =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const directory = yield* fs.makeTempDirectoryScoped()
				const store = yield* Stores.directory(directory)
				yield* store.save(record)
				for (let generation = 2; generation <= 30; generation++) {
					yield* store.save({
						...record,
						handle: {
							...record.handle,
							token: "session-" + generation,
							generation,
						},
						requestId: "request-" + generation,
						phase: "Stopped",
						termination: {
							kind: "Exited",
							exit: { code: 0, signal: null },
							cause: Cause.empty,
						},
					})
					const filesDuringCompaction = yield* fs.readDirectory(directory)
					assert.lengthOf(filesDuringCompaction, 2)
				}
				const reopened = yield* Stores.directory(directory)
				const retained = yield* reopened.list
				assert.deepEqual(
					Array.sort(
						Array.map(retained, (record) => record.handle.generation),
						Number.Order,
					),
					[1, 30],
				)
				yield* reopened.save({
					...record,
					phase: "Stopped",
					termination: {
						kind: "Killed",
						exit: { code: null, signal: "SIGKILL" },
						cause: Cause.empty,
					},
				})
				const final = yield* reopened.list
				assert.lengthOf(final, 1)
				assert.equal(final[0]!.handle.generation, 30)
				const finalFiles = yield* fs.readDirectory(directory)
				assert.lengthOf(finalFiles, 1)
			}).pipe(Effect.scoped, Effect.provide(runtime)),
		60_000,
	)
	it.effect(
		"finishes interrupted compaction on reconstruction and serializes saves for different keys",
		() =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const directory = yield* fs.makeTempDirectoryScoped()
				const store = yield* Stores.directory(directory)
				const terminal: Record = {
					...record,
					phase: "Stopped",
					termination: {
						kind: "Exited",
						exit: { code: 0, signal: null },
						cause: Cause.empty,
					},
				}
				yield* store.save(terminal)
				const oldFile = (yield* fs.readDirectory(directory))[0]!
				const oldContents = yield* fs.readFileString(directory + "/" + oldFile)
				yield* store.save({
					...terminal,
					handle: { ...terminal.handle, token: "second", generation: 2 },
					requestId: "second",
				})
				// Simulate a crash after committing the high-water file but before deleting old history.
				yield* fs.writeFileString(directory + "/" + oldFile, oldContents)
				const reopened = yield* Stores.directory(directory)
				const recovered = yield* reopened.list
				assert.lengthOf(recovered, 1)
				const recoveredFiles = yield* fs.readDirectory(directory)
				assert.lengthOf(recoveredFiles, 1)
				yield* Effect.forEach(
					Array.range(1, 10),
					(index) =>
						reopened.save({
							...terminal,
							handle: {
								...terminal.handle,
								key: { ...terminal.handle.key, instance: "instance-" + index },
								token: "key-" + index,
							},
							requestId: "key-" + index,
						}),
					{ concurrency: "unbounded" },
				)
				const concurrentRecords = yield* reopened.list
				assert.lengthOf(concurrentRecords, 11)
				const concurrentFiles = yield* fs.readDirectory(directory)
				assert.lengthOf(concurrentFiles, 11)
			}).pipe(Effect.scoped, Effect.provide(runtime)),
		60_000,
	)
	it.effect(
		"validates historical records before compaction can hide their corruption",
		() =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const directory = yield* fs.makeTempDirectoryScoped()
				const store = yield* Stores.directory(directory)
				yield* store.save({
					...record,
					handle: { ...record.handle, generation: 2 },
				})
				// A syntactically valid terminal record without its result must fail closed.
				const malformed = yield* Schema.encodeEffect(
					Schema.fromJsonString(Schema.toCodecJson(Record)),
				)({
					...record,
					handle: { ...record.handle, token: "broken", generation: 1 },
					requestId: "broken",
					phase: "Stopped",
				})
				yield* fs.writeFileString(directory + "/broken.json", malformed)
				const rejected = yield* Effect.exit(store.list)
				assert.isTrue(Exit.isFailure(rejected))
				const filesAfterRejection = yield* fs.readDirectory(directory)
				assert.lengthOf(filesAfterRejection, 2)
			}).pipe(Effect.scoped, Effect.provide(runtime)),
		60_000,
	)

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
