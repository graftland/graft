import { Context, Schema } from "effect"
export const Identity = Schema.Struct({
	id: Schema.String,
	generation: Schema.Int,
})
/** Local sessions use a fresh UUID and generation 1; network runners will allocate generations. */
export const Instance = Context.Reference<typeof Identity.Type>(
	"@graftland/remote/Instance/Instance",
	{
		defaultValue: () => ({ id: "local", generation: 0 }),
	},
)
