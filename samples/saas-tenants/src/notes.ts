import { Effect, Option } from "effect"

import { Event, Plugin } from "@graftland/graft"

import { NoteRequest, NoteStore, Quota, type Reply } from "./services.ts"

export const notes = Plugin.make({
	name: "@graftland/sample-saas-tenants/notes",
	inject: [NoteStore, Quota],
	apply: Effect.fn("notes.apply")(function* () {
		const store = yield* NoteStore
		const quota = yield* Quota
		yield* Effect.addFinalizer(
			Effect.fn("notes.stop")(function* () {
				// The provider remains available until this consumer has stopped.
				const count = yield* store.size
				yield* Effect.log("Notes stopped", { notes: count })
			}),
		)
		yield* Event.on(
			NoteRequest,
			Effect.fn("notes.request")(function* (command) {
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
