import { Graft } from "@graftland/graft"

import { Authenticator } from "../Auth"
import * as Assembly from "../internal/assembly"
import { Listener } from "../Transport"
import { consumer } from "./consumer"

export const assembly = Assembly.make(
	"@graftland/plugin-remote/runner/assembly",
	[Listener, Authenticator],
)

/** Runs a listener and an authenticator in their own realm, then serves them. */
export const run = (
	input: Omit<Assembly.Input, "consumer">,
	serve = consumer(),
) =>
	Graft.plugin(
		assembly,
		{ ...input, consumer: serve },
		{ isolate: [Listener, Authenticator] },
	)
