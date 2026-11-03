import { Context, Schema } from "effect"
export const Identity = Schema.Struct({
	id: Schema.String,
	generation: Schema.Int,
})
/** Outside a remote activation the identity is local/0. Local activations use a fresh UUID/1; runners allocate persistent generations. */
export const Instance = Context.Reference<typeof Identity.Type>(
	"@graftland/remote/Instance/Instance",
	{
		defaultValue: () => ({ id: "local", generation: 0 }),
	},
)
