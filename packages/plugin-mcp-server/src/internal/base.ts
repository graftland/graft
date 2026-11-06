import { Context } from "effect"

/** Transport services before request-specific additions. */
export const Base = Context.Reference<Context.Context<never>>(
	"@graftland/plugin-mcp-server/internal/Base",
	{ defaultValue: Context.empty },
)
