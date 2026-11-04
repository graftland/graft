import { Context, Duration, Schema } from "effect"

/** Relative paths in runner entries are resolved beside the configuration file. */
export const Directory = Context.Reference<string>(
	"@graftland/remote/ConfigDirectory",
	{
		defaultValue: () => ".",
	},
)
export const PositiveDuration = Schema.DurationFromString.check(
	Schema.makeFilter(
		(value) => Duration.isFinite(value) && Duration.toMillis(value) > 0,
		{ expected: "a finite, positive duration" },
	),
)
