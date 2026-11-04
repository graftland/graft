import { Context, Option } from "effect"
import type { Observation } from "../ModuleResolver"

/** Raw-module observations belong to the entry, not to an activation. */
export const CurrentObservation = Context.Reference(
	"@graftland/loader/internal/CurrentObservation",
	{ defaultValue: (): Option.Option<Observation> => Option.none() },
)
