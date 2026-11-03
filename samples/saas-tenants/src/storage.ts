import { Graft, Plugin } from "@graftland/graft"
import { Array, Effect, FileSystem, HashMap, Ref, Schema } from "effect"
import { Note, NotesFile, NoteStore } from "./services.ts"

export const storage = Plugin.make({
	name: "storage",
	config: Schema.Struct({ file: Schema.String }),
	inject: [FileSystem.FileSystem],
	apply: ({ file }) =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const exists = yield* fs.exists(file)
			const loaded = exists
				? yield* fs
						.readFileString(file)
						.pipe(Effect.flatMap(Schema.decodeEffect(NotesFile)))
				: []
			const notes = yield* Ref.make(
				HashMap.fromIterable(
					Array.map(loaded, (note) => [note.id, note] as const),
				),
			)
			yield* Effect.log("Storage opened", { file, notes: loaded.length })
			yield* Effect.addFinalizer(() =>
				Effect.gen(function* () {
					const current = yield* Ref.get(notes)
					const json = yield* Schema.encodeEffect(NotesFile)(
						HashMap.toValues(current),
					)
					yield* fs.writeFileString(file, json)
					yield* Effect.log("Storage flushed and closed", {
						file,
						notes: HashMap.size(current),
					})
				}).pipe(Effect.orDie),
			)
			yield* Graft.provide(NoteStore, {
				get: (id) => Ref.get(notes).pipe(Effect.map(HashMap.get(id))),
				size: Ref.get(notes).pipe(Effect.map(HashMap.size)),
				// Admission and insertion are atomic, including concurrent requests.
				save: (note: Note, limit) =>
					Ref.modify(notes, (current) => {
						if (
							!HashMap.has(current, note.id) &&
							HashMap.size(current) >= limit
						)
							return [false, current]
						return [true, HashMap.set(current, note.id, note)]
					}),
			})
		}),
})
