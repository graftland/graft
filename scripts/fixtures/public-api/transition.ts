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
	instance: string,
	deployment: Remote.CandidateOptions,
): Effect.Effect<Change.Outcome, Change.ChangeRejected, Graft.Graft> =>
	Change.run({ instance, candidate: Remote.candidate(deployment) })

export const directPlugin = (artifact: Remote.Artifact.Artifact) =>
	Remote.plugin(
		Remote.Contract.make({ name: "independent/direct", config: Schema.String }),
		{
			instance: "independent",
			artifact,
			contractModule: "independent/contract",
			target: { _tag: "Worker" },
			maxInFlight: 8,
			budget: { total: "5 minutes", drain: Duration.seconds(1) },
		},
	)
export const busy = Change.ChangeRejected.make({
	reason: { _tag: "Busy", conflicts: [] },
})
export const completed = Change.Outcome.Accepted({
	change: Change.Id.make("compile-only"),
	phase: "Complete",
	evidence: [],
	members: [],
})
export const observe = (id: Change.Id) => Change.get(id)
export const submit = (request: Change.Request) => Change.submit(request)
