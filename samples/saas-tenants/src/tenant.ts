import { Graft, Plugin } from "@graftland/graft"
import { Effect, Schema } from "effect"
import { ready } from "./lifecycle.ts"
import { notes } from "./notes.ts"
import { storage } from "./storage.ts"

export const tenant = Plugin.make({
	name: "tenant",
	config: Schema.Struct({ file: Schema.String }),
	apply: Effect.fn("tenant.apply")(function* (config) {
		const consumer = yield* Graft.plugin(notes)
		yield* consumer.await
		yield* Effect.log("Notes Pending: waiting for this tenant's NoteStore")
		const provider = yield* Graft.plugin(storage, config)
		yield* ready(provider)
		yield* ready(consumer)
	}),
})
