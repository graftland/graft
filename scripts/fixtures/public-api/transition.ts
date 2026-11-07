import { Duration, Effect, Schema } from "effect"

import { Change, Graft, Plugin, Transition } from "@graftland/graft"
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
): Effect.Effect<Change.Outcome, never, Graft.Graft> =>
	Change.run({ instance: fork, candidate: Remote.candidate(deployment) })

export const directPlugin = (artifact: Remote.Artifact.Artifact) =>
	Remote.plugin(
		Remote.Contract.make({ name: "independent/direct", config: Schema.String }),
		{
			instance: "independent",
			artifact,
			contractModule: "independent/contract",
			target: { _tag: "Worker" },
			maxInFlight: 8,
			policy: { total: "5 minutes", drain: Duration.seconds(1) },
		},
	)
export const busy = Change.Outcome.Aborted({
	phase: "Admission",
	reason: "Busy",
	evidence: [],
})
