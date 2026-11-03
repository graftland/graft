import {
	Array,
	Effect,
	FileSystem,
	HashMap,
	HashSet,
	Path,
	Ref,
	Schema,
	Semaphore,
	String,
} from "effect"
import { Digest, SecureRandom } from "effect/crypto"
import { Key, Record, Store, failure } from "./model"
import * as Retention from "./Retention"

/** Injectable store used by deterministic supervisor tests. */
export const memory = Effect.gen(function* () {
	const records = yield* Ref.make(HashMap.empty<string, Record>())
	return Store.of({
		list: Ref.get(records).pipe(
			Effect.map((records) => Array.fromIterable(HashMap.values(records))),
		),
		save: (record) =>
			Ref.update(records, (all) =>
				HashMap.fromIterable(
					Array.map(
						Retention.retain(
							Array.fromIterable(
								HashMap.values(HashMap.set(all, record.handle.token, record)),
							),
						),
						(record) => [record.handle.token, record] as const,
					),
				),
			),
	})
})

/**
 * Atomically replaced records retain unfinished sessions and each key's high-water mark.
 * Older terminal request ids expire; Open fences their retries with expectedGeneration.
 * Requires exclusive directory ownership; it is not a multi-writer database.
 */
export const directory = (root: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const digest = yield* Digest.Digest
		const json = Schema.fromJsonString(Schema.toCodecJson(Record))
		const storage = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
			effect.pipe(
				Effect.catchCause((cause) =>
					Effect.fail(failure("Storage", "Runner state storage failed", cause)),
				),
			)
		yield* storage(fs.makeDirectory(root, { recursive: true }))
		const mutex = yield* Semaphore.make(1)
		const compact = Effect.scoped(
			Effect.gen(function* () {
				const files = yield* fs.readDirectory(root)
				const rows = yield* Effect.forEach(
					Array.filter(files, String.endsWith(".json")),
					(file) =>
						fs.readFileString(path.join(root, file)).pipe(
							Effect.flatMap(Schema.decodeEffect(json)),
							Effect.map((record) => ({ file, record })),
						),
				)
				const records = Array.map(rows, (row) => row.record)
				yield* Retention.validate(records)
				const retained = Retention.retain(records)
				const tokens = HashSet.fromIterable(
					Array.map(retained, (record) => record.handle.token),
				)
				const obsolete = Array.filter(
					rows,
					(row) => !HashSet.has(tokens, row.record.handle.token),
				)
				for (const row of obsolete) yield* fs.remove(path.join(root, row.file))
				if (obsolete.length > 0) {
					const directory = yield* fs.open(root, { flag: "r" })
					yield* directory.sync
				}
				return retained
			}),
		)
		return Store.of({
			list: storage(mutex.withPermit(compact)),
			save: (record) =>
				storage(
					mutex.withPermit(
						Effect.scoped(
							Effect.gen(function* () {
								const encoded = yield* Schema.encodeEffect(json)(record)
								const address = yield* Schema.encodeEffect(
									Schema.fromJsonString(
										Schema.Struct({ key: Key, generation: Schema.Int }),
									),
								)({
									key: record.handle.key,
									generation: record.handle.generation,
								})
								const name = yield* digest.digestHex(
									Digest.sha256,
									new TextEncoder().encode(address),
								)
								const nonce = yield* Effect.sync(() =>
									SecureRandom.uuidV4Unsafe(),
								)
								const temporary = path.join(root, `.${name}.${nonce}.tmp`)
								const destination = path.join(root, name + ".json")
								yield* Effect.acquireRelease(
									fs.open(temporary, { flag: "wx", mode: 0o600 }),
									() =>
										fs.remove(temporary, { force: true }).pipe(Effect.orDie),
								).pipe(
									Effect.flatMap((file) =>
										file
											.writeAll(new TextEncoder().encode(encoded))
											.pipe(Effect.andThen(file.sync)),
									),
								)
								// Keep rename and directory synchronization together if the caller is canceled.
								yield* Effect.uninterruptible(
									Effect.gen(function* () {
										yield* fs.rename(temporary, destination)
										const directory = yield* fs.open(root, { flag: "r" })
										yield* directory.sync
									}),
								)
								// The new high-water file is durable before any old record is removed.
								yield* compact
							}),
						),
					),
				),
		})
	})
