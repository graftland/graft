import {
	Array,
	Cause,
	Effect,
	FileSystem,
	HashMap,
	HashSet,
	Layer,
	Path,
	Ref,
	Schema,
	Semaphore,
	String,
	type PlatformError,
} from "effect"
import { Digest, SecureRandom } from "effect/crypto"

import { Key, SessionRecord, StateStorageError, Store } from "./model"
import * as Retention from "./Retention"

/** Injectable store used by deterministic supervisor tests. */
export const memory = Effect.gen(function* () {
	const records = yield* Ref.make(HashMap.empty<string, SessionRecord>())
	return Store.of({
		list: Ref.get(records).pipe(
			Effect.map((records) => Array.fromIterable(HashMap.values(records))),
		),
		save: (record) => Ref.update(records, (all) => Retention.save(all, record)),
	})
})

/**
 * Atomically replaced records retain unfinished sessions and each key's high-water mark.
 * Older terminal request ids expire; Open fences their retries with expectedGeneration.
 * Requires exclusive directory ownership; it is not a multi-writer database.
 */
export const directory = Effect.fnUntraced(function* (root: string) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const digest = yield* Digest.Digest
	const json = Schema.fromJsonString(Schema.toCodecJson(SessionRecord))
	const random = yield* SecureRandom.SecureRandom
	const storage = <A, R>(
		effect: Effect.Effect<
			A,
			PlatformError.PlatformError | Schema.SchemaError | StateStorageError,
			R
		>,
	) =>
		effect.pipe(
			Effect.mapError((error) =>
				error._tag === "StateStorageError"
					? error
					: StateStorageError.make({
							detail: "Runner state storage failed",
							cause: Cause.fail(error),
						}),
			),
		)
	yield* storage(
		fs.makeDirectory(root, { recursive: true }).pipe(Effect.uninterruptible),
	)
	const mutex = yield* Semaphore.make(1)
	const read = Effect.gen(function* () {
		const files = yield* fs.readDirectory(root)
		const rows = yield* Effect.forEach(
			Array.filter(files, String.endsWith(".json")),
			(file) =>
				fs.readFileString(path.join(root, file)).pipe(
					Effect.flatMap(Schema.decodeEffect(json)),
					Effect.map((record) => ({ file, record })),
				),
		)
		return rows
	})
	const compact = Effect.scoped(
		Effect.gen(function* () {
			const rows = yield* read
			const retained = Retention.retain(Array.map(rows, (row) => row.record))
			const tokens = HashSet.fromIterable(
				Array.map(retained, (record) => record.handle.token),
			)
			const obsolete = Array.filter(
				rows,
				(row) => !HashSet.has(tokens, row.record.handle.token),
			)
			yield* Effect.forEach(
				obsolete,
				(row) =>
					fs.remove(path.join(root, row.file)).pipe(Effect.uninterruptible),
				{ discard: true },
			)
			if (obsolete.length > 0) {
				const directory = yield* fs.open(root, { flag: "r" })
				yield* directory.sync.pipe(Effect.uninterruptible)
			}
		}),
	)
	yield* storage(compact)
	return Store.of({
		list: storage(
			mutex.withPermit(
				read.pipe(Effect.map((rows) => Array.map(rows, (row) => row.record))),
			),
		),
		save: Effect.fnUntraced(
			function* (record: SessionRecord) {
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
				const nonce = yield* random.uuidV4()
				const temporary = path.join(root, `.${name}.${nonce}.tmp`)
				const destination = path.join(root, name + ".json")
				yield* Effect.acquireRelease(
					fs.open(temporary, { flag: "wx", mode: 0o600 }),
					() => fs.remove(temporary, { force: true }).pipe(Effect.orDie),
				).pipe(
					Effect.flatMap((file) =>
						file
							.writeAll(new TextEncoder().encode(encoded))
							.pipe(
								Effect.uninterruptible,
								Effect.andThen(file.sync.pipe(Effect.uninterruptible)),
							),
					),
				)
				// Keep rename and directory synchronization together if the caller is canceled.
				yield* Effect.uninterruptible(
					Effect.gen(function* () {
						yield* fs.rename(temporary, destination)
						const directory = yield* fs.open(root, { flag: "r" })
						yield* directory.sync.pipe(Effect.uninterruptible)
					}),
				)
				// The new high-water file is durable before any old record is removed.
				yield* compact
			},
			Effect.scoped,
			mutex.withPermit,
			storage,
		),
	})
})

export const layerMemory = Layer.effect(Store, memory)
export const layerDirectory = (root: string) =>
	Layer.effect(Store, directory(root))
