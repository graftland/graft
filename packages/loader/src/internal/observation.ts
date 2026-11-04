import { Context, Option, type Scope } from "effect"

/** The loader entry owns failed imports until its next attempt or disposal. */
export const ObservationScope = Context.Reference(
	"@graftland/loader/internal/ObservationScope",
	{
		defaultValue: (): Option.Option<Scope.Scope> => Option.none(),
	},
)
