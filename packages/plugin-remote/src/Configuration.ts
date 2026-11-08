/** Inputs for immutable environment and intercept layers loaded inside a unit. */
import { Context, Schema } from "effect"

/** The encoded options of the configuration module currently being constructed. */
export const Options = Context.Reference<Schema.Json>(
	"@graftland/plugin-remote/Configuration/Options",
	{
		defaultValue: () => ({}),
	},
)
