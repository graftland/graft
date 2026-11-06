import { Graft } from "@graftland/graft"

import { Credentials } from "../Auth"
import * as Assembly from "../internal/assembly"
import { Connector } from "../Transport"

export const assembly = Assembly.make(
	"@graftland/plugin-remote/host/assembly",
	[Connector, Credentials],
)

/** Runs a connector and its credentials in their own realm, then the consumer. */
export const run = (input: Assembly.Input) =>
	Graft.plugin(assembly, input, { isolate: [Connector, Credentials] })
