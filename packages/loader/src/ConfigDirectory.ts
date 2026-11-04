import { Context, Option } from "effect"

/** Directory of the supplied configuration path, before following symbolic links. */
export const ConfigDirectory = Context.Reference<Option.Option<string>>(
	"@graftland/loader/ConfigDirectory",
	{ defaultValue: Option.none },
)
