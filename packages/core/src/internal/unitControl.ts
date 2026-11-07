import { Context, type Effect } from "effect"

import type { Command, Report } from "./decisionState"

/** The fixed unit control protocol. Native placement implementations live outside the decision core. */
export class UnitControl extends Context.Service<
	UnitControl,
	{
		readonly send: (command: Command) => Effect.Effect<Report>
	}
>()("@graftland/graft/internal/unitControl") {}
