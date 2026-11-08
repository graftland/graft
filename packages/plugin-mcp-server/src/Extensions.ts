import { Effect, Schema } from "effect"

import { Event } from "@graftland/graft"

import { Changed } from "./Catalog"

export const Declared = Event.make<[], Record<string, unknown>>(
	"@graftland/plugin-mcp-server/Extensions/Declared",
)
export class ExtensionConflict extends Schema.TaggedError<
	ExtensionConflict,
	{ readonly brand: unique symbol }
>()("ExtensionConflict", { key: Schema.String }) {}
export const declare = (record: Record<string, unknown>) =>
	Effect.gen(function* () {
		yield* Effect.addFinalizer(() => Event.emit(Changed))
		yield* Event.on(Declared, () => Effect.succeed(record))
		yield* Event.emit(Changed)
	})
