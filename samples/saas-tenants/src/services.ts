import { Event } from "@graftland/graft"
import { Context, Effect, Option, Schema } from "effect"

export const Note = Schema.Struct({ id: Schema.String, text: Schema.String })
export type Note = typeof Note.Type
export const NotesFile = Schema.fromJsonString(Schema.Array(Note))

export const Plan = Context.Reference<"free" | "pro">(
	"@graftland/sample-saas-tenants/services/Plan",
	{
		defaultValue: () => "free",
	},
)
export const Tenant = Context.Reference<string>(
	"@graftland/sample-saas-tenants/services/Tenant",
	{
		defaultValue: () => "host",
	},
)

export class Quota extends Context.Service<
	Quota,
	{ readonly limit: Effect.Effect<number> }
>()("@graftland/sample-saas-tenants/services/Quota") {}

export class NoteStore extends Context.Service<
	NoteStore,
	{
		readonly get: (id: string) => Effect.Effect<Option.Option<Note>>
		readonly size: Effect.Effect<number>
		readonly save: (note: Note, limit: number) => Effect.Effect<boolean>
	}
>()("@graftland/sample-saas-tenants/services/NoteStore") {}

export const Command = Schema.Union([
	Schema.TaggedStruct("Read", { id: Schema.String }),
	Schema.TaggedStruct("Save", { note: Note }),
])
export type Command = typeof Command.Type
export const Reply = Schema.Union([
	Schema.TaggedStruct("Found", { note: Note }),
	Schema.TaggedStruct("Missing", {}),
	Schema.TaggedStruct("Saved", {}),
	Schema.TaggedStruct("QuotaExceeded", { limit: Schema.Int }),
])
export type Reply = typeof Reply.Type

export const NoteRequest = Event.make<[command: Command], Option.Option<Reply>>(
	"@graftland/sample-saas-tenants/services/NoteRequest",
)
