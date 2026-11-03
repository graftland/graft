import { Event, Plugin } from "@graftland/graft"
import { Effect, Option } from "effect"
import { NoteRequest, NoteStore, Quota, type Reply } from "./services.ts"

export const notes = Plugin.make({
	name: "notes",
	inject: [NoteStore, Quota],
	apply: () =>
		Effect.gen(function* () {
			const store = yield* NoteStore
			const quota = yield* Quota
			yield* Effect.addFinalizer(() =>
				Effect.gen(function* () {
					// The provider remains available until this consumer has stopped.
					const count = yield* store.size
					yield* Effect.log("Notes stopped", { notes: count })
				}),
			)
			yield* Event.on(NoteRequest, (command) =>
				Effect.gen(function* () {
					if (command._tag === "Read") {
						const note = yield* store.get(command.id)
						yield* Effect.log("Note read", {
							id: command.id,
							found: Option.isSome(note),
						})
						return Option.some<Reply>(
							Option.match(note, {
								onNone: () => ({ _tag: "Missing" }),
								onSome: (note) => ({ _tag: "Found", note }),
							}),
						)
					}
					const limit = yield* quota.limit
					const saved = yield* store.save(command.note, limit)
					yield* Effect.log(
						saved ? "Note saved" : "Note rejected: quota reached",
						{ id: command.note.id },
					)
					return Option.some<Reply>(
						saved ? { _tag: "Saved" } : { _tag: "QuotaExceeded", limit },
					)
				}),
			)
			yield* Effect.log("Notes ready")
		}),
})
