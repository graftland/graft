import { Duration, Effect, Schema } from "effect"

import { Graft, Plugin, Transition } from "@graftland/graft"
import * as Remote from "@graftland/plugin-remote"

export const managedPlugin = (
	driver: Transition.Driver,
	registration: Transition.Registration,
) =>
	Plugin.make({
		name: "independent/managed",
		apply: () => Transition.registerDriver(driver, registration),
	})
export const transition = (
	fork: number,
	deployment: Remote.CandidateOptions,
): Effect.Effect<Transition.Outcome, never, Graft.Graft> =>
	Graft.transition({ fork, candidate: Remote.candidate(deployment) })

export const directPlugin = (artifact: Remote.Artifact.Artifact) =>
	Remote.plugin(
		Remote.Contract.make({ name: "independent/direct", config: Schema.String }),
		{
			artifact,
			contractModule: "independent/contract",
			target: { _tag: "Worker" },
			maxInFlight: 8,
			policy: { total: "5 minutes", drain: Duration.seconds(1) },
		},
	)
export const busy = Transition.Outcome.Aborted({
	phase: "Admission",
	reason: "Busy",
	evidence: [],
})
