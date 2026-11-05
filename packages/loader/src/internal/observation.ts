import { Context, Option, type Scope } from "effect"

import type { Observation } from "../ModuleResolver"

/** Raw-module observations belong to the entry; explicit files belong to the activation that registers them. */
export const CurrentObservation = Context.Reference(
	"@graftland/loader/internal/CurrentObservation",
	{
		defaultValue: (): Option.Option<{
			readonly observation: Observation
			readonly activation: Scope.Scope
		}> => Option.none(),
	},
)
