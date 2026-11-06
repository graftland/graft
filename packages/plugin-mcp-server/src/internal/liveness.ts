import { Context, MutableRef } from "effect"
import { McpSchema } from "effect/ai"

/** The predicate is synchronous, so its scope-owned flag must be readable synchronously. */
export const make = () => {
	const live = MutableRef.make(false)
	return {
		live,
		annotations: Context.make(McpSchema.EnabledWhen, () =>
			MutableRef.get(live),
		),
	}
}
