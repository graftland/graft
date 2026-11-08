import { Context, type Cause, type Effect, type Stream } from "effect"

import type { CallEvidence, Cleanup, Command, Report } from "./decisionState"

export type UnitEvent =
	| CallEvidence
	| {
			readonly _tag: "Exited"
			readonly unit: string
			readonly incarnation: string
			readonly observer: string
			readonly cleanup: Cleanup
			readonly cause: Cause.Cause<unknown>
	  }
	| {
			readonly _tag: "UnitFailed" | "UnitDisconnected" | "UnitDiagnostic"
			readonly unit: string
			readonly incarnation: string
			readonly observer: string
			readonly cause: Cause.Cause<unknown>
	  }
	| {
			readonly _tag: "UnitCleanup"
			readonly unit: string
			readonly incarnation: string
			readonly observer: string
			readonly cleanup: Cleanup
			readonly cause: Cause.Cause<unknown>
	  }
	| {
			readonly _tag: "UnitProgress"
			readonly unit: string
			readonly incarnation: string
			readonly observer: string
			readonly stage: string
	  }
/** The fixed unit control protocol. Native placement implementations live outside the decision core. */
export class UnitControl extends Context.Service<
	UnitControl,
	{
		readonly events: Stream.Stream<UnitEvent>
		readonly send: (command: Command) => Effect.Effect<Report>
	}
>()("@graftland/graft/internal/unitControl") {}
