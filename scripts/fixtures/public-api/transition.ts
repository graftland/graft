import { Effect } from "effect"

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
